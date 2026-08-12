from __future__ import annotations

import signal
import subprocess
import unittest
from unittest.mock import patch

from backend.app.collab_store import (
    YjsMergeResult,
    _raise_for_incremental_merge_failure,
    safe_merge_yjs_updates,
    CollaborativeRoomTransientError,
    CollaborativeUpdateStore,
)


class CollabSafetyTests(unittest.TestCase):
    def test_only_sigabrt_confirms_corrupt_crdt(self) -> None:
        with patch("backend.app.collab_store.subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], -signal.SIGABRT, b"", b"")
            self.assertEqual(safe_merge_yjs_updates([b"unsafe"]).kind, "abort")

            run.return_value = subprocess.CompletedProcess([], -signal.SIGTERM, b"", b"")
            terminated = safe_merge_yjs_updates([b"healthy"])
            self.assertEqual(terminated.kind, "transient")
            self.assertIn("exitcode", terminated.detail)

    def test_abort_from_new_update_rejects_update_without_marking_room_corrupt(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid collaborative update"):
            _raise_for_incremental_merge_failure(
                YjsMergeResult("abort", None, "merge_worker_signal_6"),
                workspace_id="workspace-safe",
                item_id="page-safe",
            )

    def test_transient_incremental_failure_remains_retryable(self) -> None:
        with self.assertRaises(CollaborativeRoomTransientError):
            _raise_for_incremental_merge_failure(
                YjsMergeResult("transient", None, "merge_worker_timeout"),
                workspace_id="workspace-safe",
                item_id="page-safe",
            )

    def test_failed_quarantine_does_not_rotate_or_delete_room(self) -> None:
        class FailingGateway:
            mutate_called = False

            def supports_collaborative_storage(self, _workspace_id: str) -> bool:
                return True

            def quarantine_collaborative_room(self, *_args, **_kwargs):
                raise RuntimeError("database unavailable")

            def mutate_collaborative_room(self, *_args, **_kwargs):
                self.mutate_called = True

        gateway = FailingGateway()
        store = CollaborativeUpdateStore(gateway_provider=lambda: gateway)
        with self.assertRaises(CollaborativeRoomTransientError):
            store._quarantine_and_reset_room(
                "workspace-safe",
                "page-safe",
                reason="confirmed abort",
            )
        self.assertFalse(gateway.mutate_called)


if __name__ == "__main__":
    unittest.main()
