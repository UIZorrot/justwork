import base64
import os
import sys
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from y_py import YDoc, apply_update

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND_ROOT))


class BackendSyncMutationTest(unittest.TestCase):
    def setUp(self) -> None:
        self._env_backup = {
            "JUSTWORK_DATABASE_URL": os.environ.get("JUSTWORK_DATABASE_URL"),
            "JUSTWORK_BACKEND_DATA_FILE": os.environ.get("JUSTWORK_BACKEND_DATA_FILE"),
            "JUSTWORK_BACKEND_ASSET_DIR": os.environ.get("JUSTWORK_BACKEND_ASSET_DIR"),
        }
        self._tmp = tempfile.TemporaryDirectory()
        os.environ["JUSTWORK_DATABASE_URL"] = ""
        os.environ["JUSTWORK_BACKEND_DATA_FILE"] = os.path.join(self._tmp.name, "workspaces.json")
        os.environ["JUSTWORK_BACKEND_ASSET_DIR"] = os.path.join(self._tmp.name, "assets")

        from app.main import app, reset_gateway_for_tests, reset_image_assets_for_tests

        reset_gateway_for_tests()
        reset_image_assets_for_tests()
        self.client = TestClient(app)

    def tearDown(self) -> None:
        for key, value in self._env_backup.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._tmp.cleanup()

    def _create_workspace(self) -> str:
        created = self.client.post(
            "/v1/workspaces",
            json={
                "owner_user_id": "user_sync_owner",
                "nickname": "Sync",
                "password": "workspace-password",
                "title": "Sync",
            },
        )
        self.assertEqual(created.status_code, 200)
        return created.json()["workspace"]["workspace_id"]

    def _create_page(self, workspace_id: str, title: str = "Page") -> dict:
        created = self.client.post(
            f"/v1/workspaces/{workspace_id}/items",
            json={
                "password": "workspace-password",
                "kind": "page",
                "title": title,
                "parent_id": "root",
            },
        )
        self.assertEqual(created.status_code, 200)
        return created.json()["item"]

    def test_create_item_is_idempotent_by_client_mutation_id(self) -> None:
        workspace_id = self._create_workspace()
        body = {
            "password": "workspace-password",
            "kind": "page",
            "title": "Retry-safe page",
            "parent_id": "root",
            "client_mutation_id": "create-page-1",
        }

        first = self.client.post(f"/v1/workspaces/{workspace_id}/items", json=body)
        second = self.client.post(f"/v1/workspaces/{workspace_id}/items", json=body)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["item"]["id"], first.json()["item"]["id"])

        tree = self.client.post(
            f"/v1/workspaces/{workspace_id}/tree",
            json={"password": "workspace-password"},
        )
        retry_safe_pages = [item for item in tree.json()["items"] if item["title"] == "Retry-safe page"]
        self.assertEqual(len(retry_safe_pages), 1)

    def test_update_retry_with_same_mutation_id_returns_original_result(self) -> None:
        workspace_id = self._create_workspace()
        page = self._create_page(workspace_id)
        body = {
            "password": "workspace-password",
            "title": "Edited once",
            "markdown": "content",
            "expected_revision": page["revision"],
            "client_mutation_id": "edit-page-1",
        }

        first = self.client.put(f"/v1/workspaces/{workspace_id}/items/{page['id']}", json=body)
        second = self.client.put(f"/v1/workspaces/{workspace_id}/items/{page['id']}", json=body)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["item"], first.json()["item"])

    def test_structure_mutations_reject_stale_expected_revision(self) -> None:
        workspace_id = self._create_workspace()
        page = self._create_page(workspace_id)

        edited = self.client.put(
            f"/v1/workspaces/{workspace_id}/items/{page['id']}",
            json={
                "password": "workspace-password",
                "title": "Remote edit",
                "expected_revision": page["revision"],
            },
        )
        self.assertEqual(edited.status_code, 200)

        stale_trash = self.client.put(
            f"/v1/workspaces/{workspace_id}/items/{page['id']}/trash",
            json={
                "password": "workspace-password",
                "expected_revision": page["revision"],
                "client_mutation_id": "trash-stale-page",
            },
        )

        self.assertEqual(stale_trash.status_code, 409)
        self.assertEqual(stale_trash.json()["error"]["code"], "conflict")

    def test_hard_delete_retry_with_same_mutation_id_returns_deleted_item(self) -> None:
        workspace_id = self._create_workspace()
        page = self._create_page(workspace_id)
        trashed = self.client.put(
            f"/v1/workspaces/{workspace_id}/items/{page['id']}/trash",
            json={"password": "workspace-password", "expected_revision": page["revision"]},
        )
        self.assertEqual(trashed.status_code, 200)
        body = {
            "password": "workspace-password",
            "client_mutation_id": "hard-delete-page-1",
            "expected_revision": trashed.json()["item"]["revision"],
        }

        first = self.client.post(f"/v1/workspaces/{workspace_id}/items/{page['id']}/hard-delete", json=body)
        second = self.client.post(f"/v1/workspaces/{workspace_id}/items/{page['id']}/hard-delete", json=body)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["item"], first.json()["item"])

    def test_patch_retry_with_same_mutation_id_returns_original_result(self) -> None:
        workspace_id = self._create_workspace()
        page = self._create_page(workspace_id)
        seeded = self.client.put(
            f"/v1/workspaces/{workspace_id}/items/{page['id']}",
            json={
                "password": "workspace-password",
                "markdown": "alpha beta",
                "expected_revision": page["revision"],
            },
        )
        self.assertEqual(seeded.status_code, 200)
        seeded_item = seeded.json()["item"]
        body = {
            "password": "workspace-password",
            "find": "beta",
            "replace": "gamma",
            "dry_run": False,
            "expected_revision": seeded_item["revision"],
            "client_mutation_id": "patch-page-1",
        }

        first = self.client.post(f"/v1/workspaces/{workspace_id}/items/{page['id']}/patch", json=body)
        second = self.client.post(f"/v1/workspaces/{workspace_id}/items/{page['id']}/patch", json=body)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json(), first.json())

    def test_workspace_mutation_log_keeps_latest_one_thousand_entries(self) -> None:
        from app.main import SYNC_MUTATION_LOG_KEY, record_mutation_item

        state: dict = {}
        for index in range(1001):
            record_mutation_item(
                state,
                f"mutation-{index}",
                operation="update",
                target_id="doc_1",
                item={
                    "id": "doc_1",
                    "title": f"Title {index}",
                    "markdown": "",
                    "content": None,
                    "kind": "page",
                    "parent_id": "root",
                    "pinned": False,
                    "in_trash": False,
                    "revision": index,
                    "updated_at": "2026-07-06T00:00:00.000Z",
                },
            )

        entries = state[SYNC_MUTATION_LOG_KEY]
        self.assertEqual(len(entries), 1000)
        self.assertEqual(entries[0]["id"], "mutation-1")
        self.assertEqual(entries[-1]["id"], "mutation-1000")

    def test_revision_history_is_append_only_and_whole_workspace_replacement_is_disabled(self) -> None:
        workspace_id = self._create_workspace()
        page = self._create_page(workspace_id, "History page")
        updated = self.client.put(
            f"/v1/workspaces/{workspace_id}/items/{page['id']}",
            json={
                "password": "workspace-password",
                "markdown": "first version",
                "expected_revision": page["revision"],
            },
        )
        self.assertEqual(updated.status_code, 200, updated.text)

        history = self.client.post(
            f"/v1/workspaces/{workspace_id}/revisions",
            json={"password": "workspace-password"},
        )
        self.assertEqual(history.status_code, 200, history.text)
        page_events = [event for event in history.json()["revisions"] if event["item_id"] == page["id"]]
        self.assertEqual([event["operation"] for event in page_events[:2]], ["update", "create"])
        self.assertEqual(page_events[0]["before"]["markdown"], "")
        self.assertEqual(page_events[0]["after"]["markdown"], "first version")

        disabled = self.client.put(
            f"/v1/workspaces/{workspace_id}",
            json={
                "workspace_id": workspace_id,
                "owner_user_id": "user_sync_owner",
                "encrypted_payload": "replacement",
                "updated_at": "2026-07-28T00:00:00.000Z",
            },
        )
        self.assertEqual(disabled.status_code, 410, disabled.text)

    def test_history_revert_is_a_dedicated_inverse_that_preserves_later_edits(self) -> None:
        workspace_id = self._create_workspace()
        page = self._create_page(workspace_id, "Revert page")

        seeded = self.client.put(
            f"/v1/workspaces/{workspace_id}/items/{page['id']}",
            json={
                "password": "workspace-password",
                "markdown": "alpha TARGET omega",
                "expected_revision": page["revision"],
            },
        ).json()["item"]
        deleted = self.client.put(
            f"/v1/workspaces/{workspace_id}/items/{page['id']}",
            json={
                "password": "workspace-password",
                "markdown": "alpha  omega",
                "expected_revision": seeded["revision"],
            },
        ).json()["item"]
        history = self.client.post(
            f"/v1/workspaces/{workspace_id}/revisions",
            json={"password": "workspace-password"},
        ).json()["revisions"]
        deletion_event = next(
            event
            for event in history
            if event["item_id"] == page["id"]
            and event["before"].get("markdown") == "alpha TARGET omega"
            and event["after"].get("markdown") == "alpha  omega"
        )
        later = self.client.put(
            f"/v1/workspaces/{workspace_id}/items/{page['id']}",
            json={
                "password": "workspace-password",
                "markdown": "prefix alpha  omega suffix",
                "expected_revision": deleted["revision"],
            },
        ).json()["item"]
        revert_body = {
            "password": "workspace-password",
            "expected_revision": later["revision"],
            "client_mutation_id": "dedicated-revert-1",
        }

        reverted = self.client.post(
            f"/v1/workspaces/{workspace_id}/revisions/{deletion_event['id']}/revert",
            json=revert_body,
        )
        retried = self.client.post(
            f"/v1/workspaces/{workspace_id}/revisions/{deletion_event['id']}/revert",
            json=revert_body,
        )

        self.assertEqual(reverted.status_code, 200, reverted.text)
        self.assertEqual(reverted.json()["item"]["markdown"], "prefix alpha TARGET omega suffix")
        self.assertEqual(retried.status_code, 200, retried.text)
        self.assertEqual(retried.json()["item"], reverted.json()["item"])
        collab_state = self.client.post(
            f"/v1/workspaces/{workspace_id}/items/{page['id']}/collab/state?protocol_version=2",
            json={"password": "workspace-password"},
        ).json()
        collab_document = YDoc()
        apply_update(
            collab_document,
            base64.b64decode(collab_state["snapshot_base64"]),
        )
        self.assertEqual(
            str(collab_document.get_text("markdown")),
            "prefix alpha TARGET omega suffix",
        )
        after_history = self.client.post(
            f"/v1/workspaces/{workspace_id}/revisions",
            json={"password": "workspace-password"},
        ).json()["revisions"]
        self.assertEqual(after_history[0]["operation"], "history-revert")
        self.assertEqual(after_history[0]["source_revision_id"], deletion_event["id"])


if __name__ == "__main__":
    unittest.main()
