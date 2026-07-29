from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Callable, TypeVar

from diff_match_patch import diff_match_patch
from y_py import YDoc, apply_update, encode_state_as_update


T = TypeVar("T")


def _default_collab_dir() -> Path:
    override = os.getenv("JUSTWORK_BACKEND_COLLAB_DIR", "").strip()
    if override:
        return Path(override)
    return Path(__file__).resolve().parent.parent.parent / ".justwork-backend" / "collab"


class CollaborativeUpdateStore:
    def __init__(self, base_dir: Path | None = None) -> None:
        self._base_dir = base_dir or _default_collab_dir()
        self._lock = threading.Lock()
        self._bootstrap_leases: dict[str, float] = {}

    def _file_path(self, workspace_id: str, item_id: str) -> Path:
        safe_workspace = workspace_id.replace("/", "_")
        safe_item = item_id.replace("/", "_")
        return self._base_dir / safe_workspace / f"{safe_item}.log"

    def set_snapshot(self, workspace_id: str, item_id: str, update: bytes) -> None:
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            self._write_snapshot_locked(path, update)
            self._bootstrap_leases.pop(self._bootstrap_key(workspace_id, item_id), None)

    def get_snapshot(self, workspace_id: str, item_id: str) -> bytes | None:
        updates = self.load_updates(workspace_id, item_id)
        if not updates:
            return None
        # Clients publish a full Yjs state update, so the latest entry is a complete
        # bootstrap snapshot. Raw Yjs updates must not be concatenated as bytes.
        return updates[-1]

    def delete_snapshot(self, workspace_id: str, item_id: str) -> None:
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            path.unlink(missing_ok=True)
            self._bootstrap_leases.pop(self._bootstrap_key(workspace_id, item_id), None)

    def append_update(self, workspace_id: str, item_id: str, update: bytes) -> None:
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            current = self._read_snapshot_locked(path)
            document = YDoc()
            if current:
                apply_update(document, current)
            # Merge on the server. A client's full state can be stale and therefore is
            # not a safe replacement for the room state; Yjs updates are commutative.
            apply_update(document, update)
            merged = encode_state_as_update(document)
            self._write_snapshot_locked(path, merged)
            self._bootstrap_leases.pop(self._bootstrap_key(workspace_id, item_id), None)

    def commit_update(
        self,
        workspace_id: str,
        item_id: str,
        update: bytes,
        commit: Callable[[str], T],
    ) -> tuple[bytes, str, T]:
        """Commit a Yjs update and its workspace revision as one guarded operation.

        The snapshot file is prepared before the workspace CAS. If the callback
        rejects the write, the canonical room is left untouched. Holding the room
        lock also prevents a WebSocket update from slipping between the merge and
        the corresponding encrypted workspace revision.
        """
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            current = self._read_snapshot_locked(path)
            document = YDoc()
            if current:
                apply_update(document, current)
            apply_update(document, update)
            merged = encode_state_as_update(document)
            merged_markdown = str(document.get_text("markdown"))
            result = self._commit_snapshot_locked(path, merged, lambda: commit(merged_markdown))
            self._bootstrap_leases.pop(self._bootstrap_key(workspace_id, item_id), None)
            return merged, merged_markdown, result

    def apply_markdown_change(
        self,
        workspace_id: str,
        item_id: str,
        base_markdown: str,
        next_markdown: str,
    ) -> tuple[bytes, str]:
        """Apply a non-Yjs REST edit without replacing unseen collaborative text.

        The request's previous markdown is the edit base. We replay only its text
        change onto the canonical room. A no-op based on stale/empty REST state is
        therefore also a no-op against newer collaborative content.
        """
        merged, merged_markdown, _ = self.commit_markdown_change(
            workspace_id,
            item_id,
            base_markdown,
            next_markdown,
            lambda _markdown: None,
        )
        return merged, merged_markdown

    def commit_markdown_change(
        self,
        workspace_id: str,
        item_id: str,
        base_markdown: str,
        next_markdown: str,
        commit: Callable[[str], T],
    ) -> tuple[bytes, str, T]:
        """Apply a REST text delta only if its workspace CAS also succeeds."""
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            current = self._read_snapshot_locked(path)
            document = YDoc()
            if current:
                apply_update(document, current)
            text = document.get_text("markdown")
            current_markdown = str(text)
            if current is None:
                merged_markdown = next_markdown
            elif base_markdown == next_markdown:
                merged_markdown = current_markdown
            else:
                differ = diff_match_patch()
                patches = differ.patch_make(base_markdown, next_markdown)
                merged_markdown, applied = differ.patch_apply(patches, current_markdown)
                if not all(applied):
                    raise ValueError("collaborative markdown conflict")
            with document.begin_transaction() as transaction:
                if len(text) > 0:
                    text.delete_range(transaction, 0, len(text))
                if merged_markdown:
                    text.insert(transaction, 0, merged_markdown)
            merged = encode_state_as_update(document)
            result = self._commit_snapshot_locked(path, merged, lambda: commit(merged_markdown))
            self._bootstrap_leases.pop(self._bootstrap_key(workspace_id, item_id), None)
            return merged, merged_markdown, result

    def get_markdown(self, workspace_id: str, item_id: str) -> str | None:
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            current = self._read_snapshot_locked(path)
            if not current:
                return None
            document = YDoc()
            apply_update(document, current)
            return str(document.get_text("markdown"))

    def claim_bootstrap(self, workspace_id: str, item_id: str, lease_seconds: float = 3.0) -> bool:
        """Atomically elect one client to seed a room that has no Yjs state yet."""
        path = self._file_path(workspace_id, item_id)
        key = self._bootstrap_key(workspace_id, item_id)
        now = time.monotonic()
        with self._lock:
            if path.exists() and path.stat().st_size > 0:
                return False
            lease_expires_at = self._bootstrap_leases.get(key, 0)
            if lease_expires_at > now:
                return False
            self._bootstrap_leases[key] = now + lease_seconds
            return True

    def _bootstrap_key(self, workspace_id: str, item_id: str) -> str:
        return f"{workspace_id}:{item_id}"

    def load_updates(self, workspace_id: str, item_id: str) -> list[bytes]:
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            latest = self._read_snapshot_locked(path)
        return [latest] if latest is not None else []

    def _read_snapshot_locked(self, path: Path) -> bytes | None:
        if not path.exists():
            return None
        with path.open("r", encoding="utf-8") as handle:
            for raw_line in reversed(handle.readlines()):
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    return bytes.fromhex(line)
                except ValueError:
                    continue
        return None

    def _write_snapshot_locked(self, path: Path, update: bytes) -> None:
        temporary = self._prepare_snapshot_locked(path, update)
        try:
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def _prepare_snapshot_locked(self, path: Path, update: bytes) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{threading.get_ident()}.tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(update.hex())
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        return temporary

    def _commit_snapshot_locked(self, path: Path, update: bytes, commit: Callable[[], T]) -> T:
        temporary = self._prepare_snapshot_locked(path, update)
        try:
            result = commit()
            os.replace(temporary, path)
            return result
        finally:
            temporary.unlink(missing_ok=True)

    def reset(self) -> None:
        with self._lock:
            self._bootstrap_leases.clear()
            if self._base_dir.exists():
                for path in sorted(self._base_dir.rglob("*"), reverse=True):
                    if path.is_file() or path.is_symlink():
                        path.unlink(missing_ok=True)
                    elif path.is_dir():
                        path.rmdir()
            self._base_dir.mkdir(parents=True, exist_ok=True)


_COLLAB_STORE = CollaborativeUpdateStore()


def get_collaborative_update_store() -> CollaborativeUpdateStore:
    return _COLLAB_STORE


def reset_collab_store_for_tests() -> None:
    global _COLLAB_STORE
    _COLLAB_STORE = CollaborativeUpdateStore()
    _COLLAB_STORE.reset()
