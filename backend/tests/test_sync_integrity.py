import base64
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient
from y_py import YDoc, apply_update
from app import main
from app.workspace_runtime import normalize_workspace_state
from app.db_gateway import DatabaseGateway


class SyncIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {
            "JUSTWORK_DATABASE_URL": os.environ.get("JUSTWORK_TEST_DATABASE_URL", ""),
            "JUSTWORK_BACKEND_DATA_FILE": str(Path(self.temp.name) / "workspace.json"),
            "JUSTWORK_BACKEND_ASSET_DIR": str(Path(self.temp.name) / "assets"),
            "JUSTWORK_BACKEND_COLLAB_DIR": str(Path(self.temp.name) / "collab"),
        })
        self.environment.start()
        main.reset_gateway_for_tests()
        self.client = TestClient(main.app)
        self.password = {"password": "sync-integrity-password"}
        created = self.client.post("/v1/workspaces", json={
            **self.password, "owner_user_id": f"integrity-{uuid.uuid4().hex}", "nickname": "Owner", "title": "Tests",
        })
        self.assertEqual(created.status_code, 200, created.text)
        self.workspace = created.json()["workspace"]["workspace_id"]

    def tearDown(self):
        self.client.close()
        main.reset_gateway_for_tests()
        self.environment.stop()
        self.temp.cleanup()

    def create(self, kind="page", title="Notes"):
        response = self.client.post(f"/v1/workspaces/{self.workspace}/items", json={
            **self.password, "kind": kind, "title": title, "parent_id": "root",
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["item"]

    def url(self, item):
        return f"/v1/workspaces/{self.workspace}/items/{item['id']}"

    def room(self, item):
        response = self.client.post(self.url(item) + "/collab/state?protocol_version=3", json=self.password)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_save_read_and_unrelated_write_preserve_exact_markdown(self):
        page = self.create()
        markdown = "# Notes\n\nWelcome to JustWork\n欢迎来到 JustWork\nMy real work\n"
        saved = self.client.put(self.url(page), json={**self.password, "expected_revision": page["revision"], "markdown": markdown})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.create(title="Unrelated write")
        loaded = self.client.post(self.url(page), json=self.password)
        self.assertEqual(loaded.json()["item"]["markdown"], markdown)

    def test_normalization_is_lossless_and_idempotent(self):
        doc = {"id": "p", "kind": "page", "title": "Notes", "markdown": "# Notes\n\nThis is your document hub\nreal content", "revision": 2}
        state = normalize_workspace_state({"docs": [doc]})
        self.assertEqual(state["docs"][0]["markdown"], doc["markdown"])
        self.assertEqual(normalize_workspace_state(state), state)

    def test_malformed_state_is_rejected_instead_of_replaced_with_empty_content(self):
        for state in [{}, {"docs": {}}, {"docs": [None]}, {"docs": [{"id": "a", "kind": "table", "content": "broken"}]}, {"docs": [{"id": "a"}, {"id": "a"}]}]:
            with self.subTest(state=state), self.assertRaises(ValueError):
                normalize_workspace_state(state)

    def test_failed_file_replacement_keeps_last_good_workspace(self):
        path = Path(self.temp.name) / "atomic.json"
        DatabaseGateway._atomic_write_json(path, {"body": "saved"})
        with patch("app.db_gateway.os.replace", side_effect=OSError("disk error")):
            with self.assertRaises(OSError):
                DatabaseGateway._atomic_write_json(path, {"body": "new"})
        self.assertEqual(path.read_text(encoding="utf-8"), '{\n  "body": "saved"\n}')

    def test_structured_save_seeds_canonical_room_and_old_retry_cannot_erase_new_room(self):
        page = self.create("table")
        body = {**self.password, "expected_revision": page["revision"], "content": {"kind": "table", "columns": [], "rows": []}, "client_mutation_id": "first"}
        saved = self.client.put(self.url(page), json=body)
        self.assertEqual(saved.status_code, 200, saved.text)
        first_room = self.room(page)
        self.assertIsNotNone(first_room["snapshot_base64"])
        newer = self.client.put(self.url(page), json={**self.password, "expected_revision": saved.json()["item"]["revision"], "content": {"kind": "table", "columns": [], "rows": [{"id": "new", "cells": {}}]}, "client_mutation_id": "second"})
        self.assertEqual(newer.status_code, 200, newer.text)
        newer_room = self.room(page)
        self.assertNotEqual(newer_room["room_epoch"], first_room["room_epoch"])
        retried = self.client.put(self.url(page), json=body)
        self.assertEqual(retried.status_code, 200, retried.text)
        self.assertEqual(self.room(page), newer_room)
        self.assertEqual(self.client.post(self.url(page), json=self.password).json()["item"], newer.json()["item"])

    def test_failed_structured_commit_preserves_previous_room_and_body(self):
        page = self.create("table")
        room = self.room(page)
        gateway = main.get_gateway()
        with patch.object(gateway, "compare_and_swap_workspace", return_value=None):
            response = self.client.put(self.url(page), json={**self.password, "expected_revision": page["revision"], "content": {"kind": "table", "rows": []}})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(self.room(page), room)
        self.assertEqual(self.client.post(self.url(page), json=self.password).json()["item"], page)

    def test_stale_body_and_delete_requests_are_rejected(self):
        page = self.create()
        saved = self.client.put(self.url(page), json={**self.password, "expected_revision": page["revision"], "markdown": "new work"})
        self.assertEqual(saved.status_code, 200, saved.text)
        stale = self.client.put(self.url(page), json={**self.password, "expected_revision": page["revision"], "markdown": "old"})
        self.assertEqual(stale.status_code, 409, stale.text)
        stale_delete = self.client.put(self.url(page) + "/trash", json={**self.password, "expected_revision": page["revision"]})
        self.assertEqual(stale_delete.status_code, 409, stale_delete.text)


if __name__ == "__main__":
    unittest.main()
