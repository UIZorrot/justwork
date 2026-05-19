import hashlib
import json
import os
from pathlib import Path
from threading import Lock
from typing import Any


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class WorkspaceImageAssetArchive:
    def __init__(self, root: Path) -> None:
        self._root = root
        self._lock = Lock()
        self._root.mkdir(parents=True, exist_ok=True)

    def _workspace_dir(self, workspace_id: str) -> Path:
        return self._root / workspace_id

    def _meta_path(self, workspace_id: str, asset_id: str) -> Path:
        return self._workspace_dir(workspace_id) / f"{asset_id}.json"

    def _bytes_path(self, workspace_id: str, asset_id: str) -> Path:
        return self._workspace_dir(workspace_id) / f"{asset_id}.bin"

    def _atomic_write_bytes(self, path: Path, payload: bytes) -> None:
        tmp_path = path.with_suffix(path.suffix + ".tmp")
        tmp_path.write_bytes(payload)
        tmp_path.replace(path)

    def _atomic_write_text(self, path: Path, payload: str) -> None:
        tmp_path = path.with_suffix(path.suffix + ".tmp")
        tmp_path.write_text(payload, encoding="utf-8")
        tmp_path.replace(path)

    def put(self, meta: dict[str, Any], bytes_payload: bytes) -> None:
        workspace_id = str(meta.get("workspaceId", "")).strip()
        asset_id = str(meta.get("assetId", "")).strip()
        sha256 = str(meta.get("sha256", "")).strip()
        size_bytes = meta.get("sizeBytes")
        if not workspace_id or not asset_id or not sha256:
            raise ValueError("invalid asset metadata")
        if not isinstance(size_bytes, int):
            raise ValueError("invalid asset size")

        digest = hashlib.sha256(bytes_payload).hexdigest()
        if digest != sha256:
            raise ValueError("asset digest mismatch")
        if len(bytes_payload) != size_bytes:
            raise ValueError("asset size mismatch")

        workspace_dir = self._workspace_dir(workspace_id)
        workspace_dir.mkdir(parents=True, exist_ok=True)
        meta_path = self._meta_path(workspace_id, asset_id)
        bytes_path = self._bytes_path(workspace_id, asset_id)
        record = {
            "meta": {
                **meta,
                "workspaceId": workspace_id,
                "assetId": asset_id,
                "sha256": sha256,
                "sizeBytes": size_bytes,
            },
            "storedAt": _now_iso(),
        }

        with self._lock:
            self._atomic_write_bytes(bytes_path, bytes_payload)
            self._atomic_write_text(meta_path, json.dumps(record, ensure_ascii=False, separators=(",", ":")))

    def get(self, workspace_id: str, asset_id: str) -> dict[str, Any] | None:
        meta_path = self._meta_path(workspace_id, asset_id)
        bytes_path = self._bytes_path(workspace_id, asset_id)
        if not meta_path.exists() or not bytes_path.exists():
            return None
        with self._lock:
            try:
                record = json.loads(meta_path.read_text(encoding="utf-8"))
                meta = record.get("meta")
                if not isinstance(meta, dict):
                    return None
                payload = bytes_path.read_bytes()
                if str(meta.get("workspaceId", "")) != workspace_id or str(meta.get("assetId", "")) != asset_id:
                    return None
                return {
                    "meta": meta,
                    "bytes": payload,
                    "storedAt": str(record.get("storedAt", "")),
                }
            except Exception:  # noqa: BLE001
                return None

    def has(self, workspace_id: str, asset_id: str) -> bool:
        return self._meta_path(workspace_id, asset_id).exists() and self._bytes_path(workspace_id, asset_id).exists()

    def list_asset_ids(self, workspace_id: str) -> list[str]:
        workspace_dir = self._workspace_dir(workspace_id)
        if not workspace_dir.exists():
            return []
        ids: list[str] = []
        for meta_path in workspace_dir.glob("*.json"):
            ids.append(meta_path.stem)
        return sorted(ids)


_ARCHIVE: WorkspaceImageAssetArchive | None = None


def get_image_asset_archive() -> WorkspaceImageAssetArchive:
    global _ARCHIVE
    if _ARCHIVE is None:
        root = Path(os.getenv("JUSTWORK_BACKEND_ASSET_DIR", ".justwork-backend/assets"))
        _ARCHIVE = WorkspaceImageAssetArchive(root)
    return _ARCHIVE


def reset_image_asset_archive_for_tests() -> None:
    global _ARCHIVE
    _ARCHIVE = None
