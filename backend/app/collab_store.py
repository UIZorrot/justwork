from __future__ import annotations

import os
import threading
from pathlib import Path


def _default_collab_dir() -> Path:
    override = os.getenv("JUSTWORK_BACKEND_COLLAB_DIR", "").strip()
    if override:
        return Path(override)
    return Path(__file__).resolve().parent.parent.parent / ".justwork-backend" / "collab"


class CollaborativeUpdateStore:
    def __init__(self, base_dir: Path | None = None) -> None:
        self._base_dir = base_dir or _default_collab_dir()
        self._lock = threading.Lock()

    def _file_path(self, workspace_id: str, item_id: str) -> Path:
        safe_workspace = workspace_id.replace("/", "_")
        safe_item = item_id.replace("/", "_")
        return self._base_dir / safe_workspace / f"{safe_item}.log"

    def set_snapshot(self, workspace_id: str, item_id: str, update: bytes) -> None:
        path = self._file_path(workspace_id, item_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            encoded = update.hex()
            with path.open("w", encoding="utf-8", newline="\n") as handle:
                handle.write(encoded)
                handle.write("\n")

    def get_snapshot(self, workspace_id: str, item_id: str) -> bytes | None:
        updates = self.load_updates(workspace_id, item_id)
        if not updates:
            return None
        return b"".join(updates)

    def delete_snapshot(self, workspace_id: str, item_id: str) -> None:
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            path.unlink(missing_ok=True)

    def append_update(self, workspace_id: str, item_id: str, update: bytes) -> None:
        self.set_snapshot(workspace_id, item_id, update)

    def load_updates(self, workspace_id: str, item_id: str) -> list[bytes]:
        path = self._file_path(workspace_id, item_id)
        if not path.exists():
            return []
        with self._lock:
            with path.open("r", encoding="utf-8") as handle:
                latest: bytes | None = None
                for raw_line in handle:
                    line = raw_line.strip()
                    if not line:
                        continue
                    try:
                        latest = bytes.fromhex(line)
                    except ValueError:
                        continue
        return [latest] if latest is not None else []

    def reset(self) -> None:
        with self._lock:
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
