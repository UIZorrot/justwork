import unittest

from backend.app.workspace_runtime import (
    create_doc,
    ensure_workspace_members,
    make_initial_workspace_state,
    normalize_workspace_state,
    search_docs,
    update_workspace_title,
)


class WorkspaceRuntimeMigrationTests(unittest.TestCase):
    def test_ensure_workspace_members_seeds_owner_and_preserves_existing_members(self) -> None:
        state = {
            "members": {
                "user_guest9999": {
                    "userId": "user_guest9999",
                    "nickname": "Guest",
                    "joinedAt": "2026-05-06T00:00:00.000Z",
                    "updatedAt": "2026-05-06T00:00:00.000Z",
                }
            }
        }

        changed = ensure_workspace_members(state, "user_owner1234", "Alice")

        self.assertTrue(changed)
        self.assertIn("user_owner1234", state["members"])
        self.assertEqual(state["members"]["user_owner1234"]["nickname"], "Alice")
        self.assertEqual(state["members"]["user_guest9999"]["nickname"], "Guest")

    def test_normalize_workspace_state_preserves_title_heading_in_page_body(self) -> None:
        state = {
            "activeDocId": "page_doc",
            "workspaceDescription": "test workspace",
            "docs": [
                {
                    "id": "root",
                    "title": "Root",
                    "markdown": "",
                    "revision": 0,
                    "updatedAt": "2026-05-06T00:00:00.000Z",
                    "lastVisitedAt": "2026-05-06T00:00:00.000Z",
                    "parentId": None,
                    "pinned": False,
                    "inTrash": False,
                    "kind": "folder",
                },
                {
                    "id": "page_doc",
                    "title": "My Title",
                    "markdown": "# My Title\n\nBody text.",
                    "revision": 0,
                    "updatedAt": "2026-05-06T00:00:00.000Z",
                    "lastVisitedAt": "2026-05-06T00:00:00.000Z",
                    "parentId": "root",
                    "pinned": False,
                    "inTrash": False,
                    "kind": "page",
                },
            ],
        }

        next_state = normalize_workspace_state(state)
        page_doc = next(doc for doc in next_state["docs"] if doc["id"] == "page_doc")

        self.assertEqual(page_doc["markdown"], "# My Title\n\nBody text.")

    def test_document_titles_keep_visible_spaces_when_created(self) -> None:
        state = {
            "activeDocId": "root",
            "workspaceDescription": "test workspace",
            "docs": [
                {
                    "id": "root",
                    "title": "Root",
                    "markdown": "",
                    "revision": 0,
                    "updatedAt": "2026-05-06T00:00:00.000Z",
                    "lastVisitedAt": "2026-05-06T00:00:00.000Z",
                    "parentId": None,
                    "pinned": False,
                    "inTrash": False,
                    "kind": "folder",
                }
            ],
        }

        doc = create_doc(state, "page", "  My Page  ", "root")

        self.assertEqual(doc["title"], "  My Page  ")

    def test_workspace_title_spaces_are_preserved_and_collapsed(self) -> None:
        state = make_initial_workspace_state("Project Docs")

        self.assertEqual(state["workspaceTitle"], "Project Docs")
        self.assertEqual(update_workspace_title(state, "  Launch   Plan  ", "workspace_1234"), "Launch Plan")

    def test_normalize_workspace_state_converts_legacy_welcome_doc_to_page(self) -> None:
        state = {
            "activeDocId": "welcome_doc",
            "workspaceDescription": "test workspace",
            "docs": [
                {
                    "id": "root",
                    "title": "Root",
                    "markdown": "",
                    "revision": 0,
                    "updatedAt": "2026-05-06T00:00:00.000Z",
                    "lastVisitedAt": "2026-05-06T00:00:00.000Z",
                    "parentId": None,
                    "pinned": False,
                    "inTrash": False,
                    "kind": "folder",
                },
                {
                    "id": "welcome_doc",
                    "title": "Welcome",
                    "markdown": "# Welcome to JustWork\n\nThis is your document hub.",
                    "revision": 0,
                    "updatedAt": "2026-05-06T00:00:00.000Z",
                    "lastVisitedAt": "2026-05-06T00:00:00.000Z",
                    "parentId": "root",
                    "pinned": False,
                    "inTrash": False,
                    "kind": "welcome",
                },
            ],
        }

        next_state = normalize_workspace_state(state)
        welcome_doc = next(doc for doc in next_state["docs"] if doc["id"] == "welcome_doc")

        self.assertEqual(welcome_doc["kind"], "page")
        self.assertEqual(welcome_doc["markdown"], "# Welcome to JustWork\n\nThis is your document hub.")
        self.assertEqual(next_state["activeDocId"], "welcome_doc")

    def test_normalize_workspace_state_seeds_structured_content_for_table_and_board_docs(self) -> None:
        state = {
            "activeDocId": "missing_doc",
            "workspaceDescription": "test workspace",
            "docs": [
                {
                    "id": "root",
                    "title": "Root",
                    "markdown": "",
                    "revision": 0,
                    "updatedAt": "2026-05-06T00:00:00.000Z",
                    "lastVisitedAt": "2026-05-06T00:00:00.000Z",
                    "parentId": None,
                    "pinned": False,
                    "inTrash": False,
                    "kind": "folder",
                },
                {
                    "id": "table_doc",
                    "title": "Dataset",
                    "markdown": "legacy markdown should be cleared",
                    "revision": 0,
                    "updatedAt": "2026-05-06T00:00:00.000Z",
                    "lastVisitedAt": "2026-05-06T00:00:00.000Z",
                    "parentId": "root",
                    "pinned": False,
                    "inTrash": False,
                    "kind": "table",
                },
                {
                    "id": "board_doc",
                    "title": "Sprint",
                    "markdown": "legacy markdown should be cleared",
                    "revision": 0,
                    "updatedAt": "2026-05-06T00:00:00.000Z",
                    "lastVisitedAt": "2026-05-06T00:00:00.000Z",
                    "parentId": "root",
                    "pinned": False,
                    "inTrash": False,
                    "kind": "board",
                },
            ],
        }

        next_state = normalize_workspace_state(state)
        table_doc = next(doc for doc in next_state["docs"] if doc["id"] == "table_doc")
        board_doc = next(doc for doc in next_state["docs"] if doc["id"] == "board_doc")

        self.assertEqual(next_state["activeDocId"], "table_doc")
        self.assertEqual(table_doc["markdown"], "")
        self.assertEqual(board_doc["markdown"], "")
        self.assertEqual(table_doc["content"]["columns"][0]["title"], "Name")
        self.assertEqual(board_doc["content"]["columns"][0]["id"], "todo")

    def test_search_docs_indexes_structured_table_and_board_content(self) -> None:
        state = {
            "activeDocId": "table_doc",
            "workspaceDescription": "test workspace",
            "docs": [
                {
                    "id": "root",
                    "title": "Root",
                    "markdown": "",
                    "revision": 0,
                    "updatedAt": "2026-05-06T00:00:00.000Z",
                    "lastVisitedAt": "2026-05-06T00:00:00.000Z",
                    "parentId": None,
                    "pinned": False,
                    "inTrash": False,
                    "kind": "folder",
                },
                {
                    "id": "table_doc",
                    "title": "Dataset",
                    "markdown": "",
                    "content": {
                        "columns": [
                            {"id": "col_name", "title": "Name", "type": "text"},
                            {"id": "col_status", "title": "Status", "type": "text"},
                        ],
                        "rows": [
                            {"id": "row_1", "cells": {"col_name": "Alpha", "col_status": "Blocked"}},
                        ],
                    },
                    "revision": 0,
                    "updatedAt": "2026-05-06T00:00:00.000Z",
                    "lastVisitedAt": "2026-05-06T00:00:00.000Z",
                    "parentId": "root",
                    "pinned": False,
                    "inTrash": False,
                    "kind": "table",
                },
                {
                    "id": "board_doc",
                    "title": "Sprint",
                    "markdown": "",
                    "content": {
                        "columns": [
                            {"id": "todo", "title": "To do", "cardIds": ["card_1"]},
                        ],
                        "cards": [
                            {"id": "card_1", "title": "Ship Inbox", "description": "Release blocker for launch"},
                        ],
                    },
                    "revision": 0,
                    "updatedAt": "2026-05-06T00:00:00.000Z",
                    "lastVisitedAt": "2026-05-06T00:00:00.000Z",
                    "parentId": "root",
                    "pinned": False,
                    "inTrash": False,
                    "kind": "board",
                },
            ],
        }

        normalized = normalize_workspace_state(state)
        table_results = search_docs(normalized, "Blocked")
        board_results = search_docs(normalized, "launch")

        self.assertEqual(table_results[0]["id"], "table_doc")
        self.assertIn("Blocked", table_results[0]["excerpt"])
        self.assertEqual(board_results[0]["id"], "board_doc")
        self.assertIn("launch", board_results[0]["excerpt"])


if __name__ == "__main__":
    unittest.main()
