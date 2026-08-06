from __future__ import annotations

import json
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Callable, TypeVar, cast

from diff_match_patch import diff_match_patch
from y_py import YDoc, apply_update, encode_state_as_update

from .db_gateway import CollaborativeRoomMutation, DatabaseGateway
from .workspace_crypto import (
    decrypt_collaboration_bytes,
    derive_workspace_collaboration_key,
    encrypt_collaboration_bytes,
)


T = TypeVar("T")
_COLLAB_GATEWAY_PROVIDER: Callable[[], DatabaseGateway] | None = None
_COMPACT_UPDATE_COUNT = max(8, int(os.getenv("JUSTWORK_COLLAB_COMPACT_UPDATE_COUNT", "64")))
_COMPACT_UPDATE_BYTES = max(65_536, int(os.getenv("JUSTWORK_COLLAB_COMPACT_UPDATE_BYTES", "1048576")))


def _default_collab_dir() -> Path:
    override = os.getenv("JUSTWORK_BACKEND_COLLAB_DIR", "").strip()
    if override:
        return Path(override)
    return Path(__file__).resolve().parent.parent.parent / ".justwork-backend" / "collab"


class CollaborativeUpdateStore:
    def __init__(
        self,
        base_dir: Path | None = None,
        gateway_provider: Callable[[], DatabaseGateway] | None = None,
    ) -> None:
        self._base_dir = base_dir or _default_collab_dir()
        self._force_file_storage = base_dir is not None
        self._gateway_provider = gateway_provider
        self._lock = threading.Lock()
        self._bootstrap_leases: dict[str, float] = {}

    @staticmethod
    def _key(workspace_id: str, encryption_key: bytes | None) -> bytes:
        # Tests and explicitly file-only development stores may omit a password.
        # Production call sites always provide the password-derived key.
        return encryption_key or derive_workspace_collaboration_key(workspace_id, "")

    @staticmethod
    def _aad(workspace_id: str, item_id: str, epoch: str, kind: str, version: int) -> str:
        return f"{workspace_id}\n{item_id}\n{epoch}\n{kind}\n{version}"

    def _decrypt_room_document(
        self,
        workspace_id: str,
        item_id: str,
        current,
        encryption_key: bytes,
        *,
        legacy_snapshot: bytes | None = None,
        legacy_epoch: str | None = None,
    ) -> tuple[YDoc, bool]:
        document = YDoc()
        used_legacy_plaintext = False
        if current is not None:
            epoch = current.room_epoch
            if current.snapshot is not None:
                snapshot, encrypted = decrypt_collaboration_bytes(
                    encryption_key,
                    current.snapshot,
                    aad=self._aad(workspace_id, item_id, epoch, "snapshot", current.snapshot_version),
                )
                apply_update(document, snapshot)
                used_legacy_plaintext = not encrypted
            for version, payload in current.updates:
                update, encrypted = decrypt_collaboration_bytes(
                    encryption_key,
                    payload,
                    aad=self._aad(workspace_id, item_id, epoch, "update", version),
                )
                apply_update(document, update)
                used_legacy_plaintext = used_legacy_plaintext or not encrypted
        elif legacy_snapshot is not None:
            epoch = legacy_epoch or "legacy"
            update, encrypted = decrypt_collaboration_bytes(
                encryption_key,
                legacy_snapshot,
                aad=self._aad(workspace_id, item_id, epoch, "file", 0),
            )
            apply_update(document, update)
            used_legacy_plaintext = not encrypted
        return document, used_legacy_plaintext

    def _database_state_mutation(
        self,
        workspace_id: str,
        item_id: str,
        current,
        epoch: str,
        merged: bytes,
        encryption_key: bytes,
        result: T,
        *,
        raw_update: bytes | None = None,
        force_compact: bool = False,
        bootstrap_lease_until: float = 0,
        update_id: str | None = None,
    ) -> CollaborativeRoomMutation:
        next_version = (current.version if current else 0) + 1
        tail_bytes = sum(len(payload) for _, payload in current.updates) if current else 0
        compact = (
            force_compact
            or current is None
            or len(current.updates) + 1 >= _COMPACT_UPDATE_COUNT
            or tail_bytes + len(raw_update or b"") >= _COMPACT_UPDATE_BYTES
        )
        if compact:
            snapshot = encrypt_collaboration_bytes(
                encryption_key,
                merged,
                aad=self._aad(workspace_id, item_id, epoch, "snapshot", next_version),
            )
            event_payload = (
                encrypt_collaboration_bytes(
                    encryption_key,
                    raw_update,
                    aad=self._aad(workspace_id, item_id, epoch, "event", next_version),
                )
                if raw_update is not None and update_id is not None
                else None
            )
            return CollaborativeRoomMutation(
                epoch,
                snapshot,
                bootstrap_lease_until,
                result,
                True,
                None,
                True,
                update_id,
                event_payload,
            )
        encrypted_update = (
            encrypt_collaboration_bytes(
                encryption_key,
                raw_update,
                aad=self._aad(workspace_id, item_id, epoch, "update", next_version),
            )
            if raw_update is not None
            else None
        )
        return CollaborativeRoomMutation(
            epoch,
            current.snapshot,
            bootstrap_lease_until,
            result,
            True,
            encrypted_update,
            False,
            update_id,
            (
                encrypt_collaboration_bytes(
                    encryption_key,
                    raw_update,
                    aad=self._aad(workspace_id, item_id, epoch, "event", next_version),
                )
                if raw_update is not None and update_id is not None
                else None
            ),
        )

    def event_cursor(self, workspace_id: str, item_id: str) -> int:
        gateway = self._database_gateway(workspace_id)
        return gateway.collaborative_event_cursor(workspace_id, item_id) if gateway else 0

    def events_since(
        self,
        workspace_id: str,
        item_id: str,
        room_epoch: str,
        after_event_id: int,
        encryption_key: bytes,
    ) -> list[tuple[int, str, bytes]]:
        gateway = self._database_gateway(workspace_id)
        if gateway is None:
            return []
        results: list[tuple[int, str, bytes]] = []
        for event in gateway.collaborative_events_since(
            workspace_id, item_id, after_event_id
        ):
            if event.room_epoch != room_epoch:
                continue
            plaintext, _ = decrypt_collaboration_bytes(
                encryption_key,
                event.payload,
                aad=self._aad(
                    workspace_id,
                    item_id,
                    event.room_epoch,
                    "event",
                    event.room_version,
                ),
            )
            results.append((event.event_id, event.update_id, plaintext))
        return results

    def _database_gateway(self, workspace_id: str) -> DatabaseGateway | None:
        if self._force_file_storage:
            return None
        provider = self._gateway_provider or _COLLAB_GATEWAY_PROVIDER
        if provider is None:
            return None
        gateway = provider()
        return gateway if gateway.supports_collaborative_storage(workspace_id) else None

    def supports_cross_instance_events(self, workspace_id: str) -> bool:
        return self._database_gateway(workspace_id) is not None

    def _legacy_file_state(self, workspace_id: str, item_id: str) -> tuple[str, bytes | None] | None:
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            snapshot = self._read_snapshot_locked(path)
            epoch = self._read_epoch_locked(path)
        if snapshot is None and epoch is None:
            return None
        return epoch or self._new_epoch(), snapshot

    def _remove_legacy_file_state(self, workspace_id: str, item_id: str) -> None:
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            path.unlink(missing_ok=True)
            self._epoch_path(path).unlink(missing_ok=True)
            self._receipt_path(path).unlink(missing_ok=True)
            self._bootstrap_leases.pop(self._bootstrap_key(workspace_id, item_id), None)

    @staticmethod
    def _unwrap_database_result(result: T | BaseException) -> T:
        if isinstance(result, BaseException):
            raise result
        return cast(T, result)

    def _file_path(self, workspace_id: str, item_id: str) -> Path:
        safe_workspace = workspace_id.replace("/", "_")
        safe_item = item_id.replace("/", "_")
        return self._base_dir / safe_workspace / f"{safe_item}.log"

    @staticmethod
    def _epoch_path(path: Path) -> Path:
        return path.with_suffix(f"{path.suffix}.epoch")

    @staticmethod
    def _receipt_path(path: Path) -> Path:
        return path.with_suffix(f"{path.suffix}.receipts")

    @staticmethod
    def _new_epoch() -> str:
        return f"epoch_{secrets.token_urlsafe(18)}"

    def set_snapshot(
        self, workspace_id: str, item_id: str, update: bytes, encryption_key: bytes | None = None
    ) -> None:
        key = self._key(workspace_id, encryption_key)
        gateway = self._database_gateway(workspace_id)
        if gateway is not None:
            legacy = self._legacy_file_state(workspace_id, item_id)
            gateway.mutate_collaborative_room(
                workspace_id,
                item_id,
                lambda current: self._database_state_mutation(
                    workspace_id,
                    item_id,
                    current,
                    current.room_epoch if current else legacy[0] if legacy else self._new_epoch(),
                    update,
                    key,
                    None,
                    force_compact=True,
                ),
            )
            if legacy is not None:
                self._remove_legacy_file_state(workspace_id, item_id)
            return
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            epoch = self._ensure_epoch_locked(path)
            encrypted = encrypt_collaboration_bytes(
                key, update, aad=self._aad(workspace_id, item_id, epoch, "file", 0)
            )
            self._write_snapshot_locked(path, encrypted)
            self._bootstrap_leases.pop(self._bootstrap_key(workspace_id, item_id), None)

    def get_snapshot(
        self, workspace_id: str, item_id: str, encryption_key: bytes | None = None
    ) -> bytes | None:
        updates = self.load_updates(workspace_id, item_id, encryption_key)
        if not updates:
            return None
        # Clients publish a full Yjs state update, so the latest entry is a complete
        # bootstrap snapshot. Raw Yjs updates must not be concatenated as bytes.
        return updates[-1]

    def get_state(
        self, workspace_id: str, item_id: str, encryption_key: bytes | None = None
    ) -> tuple[str, bytes | None]:
        """Return the canonical room epoch and snapshot under one lock."""
        key = self._key(workspace_id, encryption_key)
        gateway = self._database_gateway(workspace_id)
        if gateway is not None:
            legacy = self._legacy_file_state(workspace_id, item_id)
            migrated = False

            def read_or_create(current):
                nonlocal migrated
                if current is not None:
                    document, legacy_plaintext = self._decrypt_room_document(
                        workspace_id, item_id, current, key
                    )
                    merged = encode_state_as_update(document) if current.snapshot is not None or current.updates else None
                    if merged is None or not legacy_plaintext:
                        return CollaborativeRoomMutation(
                            current.room_epoch,
                            current.snapshot,
                            current.bootstrap_lease_until,
                            (current.room_epoch, merged),
                            False,
                        )
                    return self._database_state_mutation(
                        workspace_id,
                        item_id,
                        current,
                        current.room_epoch,
                        merged,
                        key,
                        (current.room_epoch, merged),
                        force_compact=True,
                        bootstrap_lease_until=current.bootstrap_lease_until,
                    )
                epoch, snapshot = legacy or (self._new_epoch(), None)
                migrated = legacy is not None
                if snapshot is None:
                    return CollaborativeRoomMutation(epoch, None, 0, (epoch, None))
                document, _ = self._decrypt_room_document(
                    workspace_id, item_id, None, key,
                    legacy_snapshot=snapshot, legacy_epoch=epoch,
                )
                merged = encode_state_as_update(document)
                return self._database_state_mutation(
                    workspace_id, item_id, None, epoch, merged, key, (epoch, merged),
                    force_compact=True,
                )

            result = gateway.mutate_collaborative_room(workspace_id, item_id, read_or_create)
            if migrated:
                self._remove_legacy_file_state(workspace_id, item_id)
            return result
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            epoch = self._ensure_epoch_locked(path)
            stored = self._read_snapshot_locked(path)
            if stored is None:
                return epoch, None
            snapshot, encrypted = decrypt_collaboration_bytes(
                key, stored, aad=self._aad(workspace_id, item_id, epoch, "file", 0)
            )
            if not encrypted:
                self._write_snapshot_locked(
                    path,
                    encrypt_collaboration_bytes(
                        key, snapshot, aad=self._aad(workspace_id, item_id, epoch, "file", 0)
                    ),
                )
            return epoch, snapshot

    def join_state(
        self,
        workspace_id: str,
        item_id: str,
        lease_seconds: float = 3.0,
        encryption_key: bytes | None = None,
    ) -> tuple[str, bytes | None, bool]:
        """Atomically read the room state and elect at most one bootstrap owner.

        A new epoch is minted whenever a room has no snapshot and a new bootstrap
        lease starts. Clients must never merge snapshots from different epochs.
        """
        key = self._key(workspace_id, encryption_key)
        gateway = self._database_gateway(workspace_id)
        if gateway is not None:
            now = time.time()
            legacy = self._legacy_file_state(workspace_id, item_id)
            migrated = False

            def join(current):
                nonlocal migrated
                if current is not None and (current.snapshot is not None or current.updates):
                    document, legacy_plaintext = self._decrypt_room_document(
                        workspace_id, item_id, current, key
                    )
                    merged = encode_state_as_update(document)
                    if legacy_plaintext or current.bootstrap_lease_until != 0:
                        return self._database_state_mutation(
                            workspace_id, item_id, current, current.room_epoch, merged, key,
                            (current.room_epoch, merged, False), force_compact=True,
                        )
                    return CollaborativeRoomMutation(
                        current.room_epoch, current.snapshot, 0,
                        (current.room_epoch, merged, False), False,
                    )
                if current is not None and current.bootstrap_lease_until > now:
                    return CollaborativeRoomMutation(
                        room_epoch=current.room_epoch,
                        snapshot=None,
                        bootstrap_lease_until=current.bootstrap_lease_until,
                        result=(current.room_epoch, None, False),
                        persist=False,
                    )
                if current is None and legacy is not None and legacy[1] is not None:
                    migrated = True
                    document, _ = self._decrypt_room_document(
                        workspace_id, item_id, None, key,
                        legacy_snapshot=legacy[1], legacy_epoch=legacy[0],
                    )
                    merged = encode_state_as_update(document)
                    return self._database_state_mutation(
                        workspace_id, item_id, None, legacy[0], merged, key,
                        (legacy[0], merged, False), force_compact=True,
                    )
                epoch = self._new_epoch()
                return CollaborativeRoomMutation(
                    room_epoch=epoch,
                    snapshot=None,
                    bootstrap_lease_until=now + lease_seconds,
                    result=(epoch, None, True),
                )

            result = gateway.mutate_collaborative_room(workspace_id, item_id, join)
            if migrated:
                self._remove_legacy_file_state(workspace_id, item_id)
            return result
        path = self._file_path(workspace_id, item_id)
        lease_key = self._bootstrap_key(workspace_id, item_id)
        now = time.monotonic()
        with self._lock:
            stored = self._read_snapshot_locked(path)
            if stored is not None:
                epoch = self._ensure_epoch_locked(path)
                snapshot, encrypted = decrypt_collaboration_bytes(
                    key, stored, aad=self._aad(workspace_id, item_id, epoch, "file", 0)
                )
                if not encrypted:
                    self._write_snapshot_locked(
                        path,
                        encrypt_collaboration_bytes(
                            key, snapshot, aad=self._aad(workspace_id, item_id, epoch, "file", 0)
                        ),
                    )
                return epoch, snapshot, False
            lease_expires_at = self._bootstrap_leases.get(lease_key, 0)
            if lease_expires_at > now:
                return self._ensure_epoch_locked(path), None, False
            epoch = self._new_epoch()
            self._write_epoch_locked(path, epoch)
            self._bootstrap_leases[lease_key] = now + lease_seconds
            return epoch, None, True

    def epoch_matches(
        self,
        workspace_id: str,
        item_id: str,
        expected_epoch: str,
        encryption_key: bytes | None = None,
    ) -> bool:
        if self._database_gateway(workspace_id) is not None:
            epoch, _ = self.get_state(workspace_id, item_id, encryption_key)
            return epoch == expected_epoch
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            return self._ensure_epoch_locked(path) == expected_epoch

    def delete_snapshot(self, workspace_id: str, item_id: str) -> None:
        gateway = self._database_gateway(workspace_id)
        if gateway is not None:
            gateway.mutate_collaborative_room(
                workspace_id,
                item_id,
                lambda _current: CollaborativeRoomMutation(
                    room_epoch=None,
                    snapshot=None,
                    bootstrap_lease_until=0,
                    result=None,
                ),
            )
            self._remove_legacy_file_state(workspace_id, item_id)
            return
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            path.unlink(missing_ok=True)
            self._epoch_path(path).unlink(missing_ok=True)
            self._receipt_path(path).unlink(missing_ok=True)
            self._bootstrap_leases.pop(self._bootstrap_key(workspace_id, item_id), None)

    @staticmethod
    def _decode_structured_value(value):
        if isinstance(value, list):
            return [CollaborativeUpdateStore._decode_structured_value(entry) for entry in value]
        if not isinstance(value, dict):
            return value
        if value.get("__type") == "justwork-keyed-array-v1":
            items = value.get("items") if isinstance(value.get("items"), dict) else {}
            ranks = value.get("ranks") if isinstance(value.get("ranks"), dict) else {}
            ordered_keys = sorted(
                items,
                key=lambda key: (float(ranks.get(key, 0) or 0), str(key)),
            )
            return [CollaborativeUpdateStore._decode_structured_value(items[key]) for key in ordered_keys]
        return {
            str(key): CollaborativeUpdateStore._decode_structured_value(entry)
            for key, entry in value.items()
        }

    @classmethod
    def _content_from_document(cls, document: YDoc) -> tuple[bytes, str, dict]:
        markdown = str(document.get_text("markdown"))
        raw_content = json.loads(document.get_map("content").to_json())
        content = cls._decode_structured_value(raw_content)
        return (
            encode_state_as_update(document),
            markdown,
            content if isinstance(content, dict) else {},
        )

    def drain_content(
        self,
        workspace_id: str,
        item_id: str,
        encryption_key: bytes | None = None,
    ) -> tuple[bytes, str, dict] | None:
        """Atomically read the canonical Yjs state and rotate the room to empty.

        Password rotation uses this to preserve the final acknowledged update
        while making every ticket for the previous room epoch unusable.
        """
        key = self._key(workspace_id, encryption_key)
        gateway = self._database_gateway(workspace_id)
        if gateway is not None:
            legacy = self._legacy_file_state(workspace_id, item_id)

            def drain(current):
                if current is None and legacy is None:
                    return CollaborativeRoomMutation(None, None, 0, None)
                try:
                    document, _ = self._decrypt_room_document(
                        workspace_id,
                        item_id,
                        current,
                        key,
                        legacy_snapshot=legacy[1] if current is None and legacy else None,
                        legacy_epoch=legacy[0] if current is None and legacy else None,
                    )
                    result = self._content_from_document(document)
                except BaseException as exc:  # noqa: BLE001
                    result = exc
                return CollaborativeRoomMutation(None, None, 0, result)

            stored = gateway.mutate_collaborative_room(workspace_id, item_id, drain)
            result = self._unwrap_database_result(stored)
            self._remove_legacy_file_state(workspace_id, item_id)
            return result

        path = self._file_path(workspace_id, item_id)
        with self._lock:
            stored = self._read_snapshot_locked(path)
            if stored is None:
                self._epoch_path(path).unlink(missing_ok=True)
                self._receipt_path(path).unlink(missing_ok=True)
                self._bootstrap_leases.pop(self._bootstrap_key(workspace_id, item_id), None)
                return None
            epoch = self._ensure_epoch_locked(path)
            snapshot, _ = decrypt_collaboration_bytes(
                key,
                stored,
                aad=self._aad(workspace_id, item_id, epoch, "file", 0),
            )
            document = YDoc()
            apply_update(document, snapshot)
            result = self._content_from_document(document)
            path.unlink(missing_ok=True)
            self._epoch_path(path).unlink(missing_ok=True)
            self._receipt_path(path).unlink(missing_ok=True)
            self._bootstrap_leases.pop(self._bootstrap_key(workspace_id, item_id), None)
            return result

    def append_update(
        self,
        workspace_id: str,
        item_id: str,
        update: bytes,
        expected_epoch: str | None = None,
        encryption_key: bytes | None = None,
        update_id: str | None = None,
    ) -> bool:
        key = self._key(workspace_id, encryption_key)
        gateway = self._database_gateway(workspace_id)
        if gateway is not None:
            legacy = self._legacy_file_state(workspace_id, item_id)
            migrated = False

            def merge(current):
                nonlocal migrated
                epoch = current.room_epoch if current else legacy[0] if legacy else self._new_epoch()
                migrated = current is None and legacy is not None
                epoch = current.room_epoch if current else legacy[0] if legacy else self._new_epoch()
                if expected_epoch is not None and epoch != expected_epoch:
                    return CollaborativeRoomMutation(
                        room_epoch=epoch,
                        snapshot=current.snapshot if current else legacy[1] if legacy else None,
                        bootstrap_lease_until=current.bootstrap_lease_until if current else 0,
                        result=ValueError("collaborative room epoch conflict"),
                        persist=False,
                    )
                try:
                    document, legacy_plaintext = self._decrypt_room_document(
                        workspace_id,
                        item_id,
                        current,
                        key,
                        legacy_snapshot=legacy[1] if current is None and legacy else None,
                        legacy_epoch=legacy[0] if current is None and legacy else None,
                    )
                    apply_update(document, update)
                    merged = encode_state_as_update(document)
                except BaseException as exc:  # noqa: BLE001
                    return CollaborativeRoomMutation(
                        epoch, current.snapshot if current else None, 0, exc, False
                    )
                return self._database_state_mutation(
                    workspace_id,
                    item_id,
                    current,
                    epoch,
                    merged,
                    key,
                    True,
                    raw_update=update,
                    force_compact=legacy_plaintext or migrated,
                    update_id=update_id,
                )

            result = gateway.mutate_collaborative_room(
                workspace_id,
                item_id,
                merge,
            )
            inserted = bool(self._unwrap_database_result(result))
            if migrated:
                self._remove_legacy_file_state(workspace_id, item_id)
            return inserted
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            epoch = self._ensure_epoch_locked(path)
            if expected_epoch is not None and epoch != expected_epoch:
                raise ValueError("collaborative room epoch conflict")
            if update_id is not None and self._has_receipt_locked(path, update_id):
                return False
            current_stored = self._read_snapshot_locked(path)
            document = YDoc()
            if current_stored:
                current, _ = decrypt_collaboration_bytes(
                    key, current_stored, aad=self._aad(workspace_id, item_id, epoch, "file", 0)
                )
                apply_update(document, current)
            # Merge on the server. A client's full state can be stale and therefore is
            # not a safe replacement for the room state; Yjs updates are commutative.
            apply_update(document, update)
            merged = encode_state_as_update(document)
            self._write_snapshot_locked(
                path,
                encrypt_collaboration_bytes(
                    key, merged, aad=self._aad(workspace_id, item_id, epoch, "file", 0)
                ),
            )
            self._bootstrap_leases.pop(self._bootstrap_key(workspace_id, item_id), None)
            if update_id is not None:
                self._append_receipt_locked(path, update_id)
            return True

    def commit_update(
        self,
        workspace_id: str,
        item_id: str,
        update: bytes,
        commit: Callable[[str], T],
        expected_epoch: str | None = None,
        encryption_key: bytes | None = None,
    ) -> tuple[bytes, str, T]:
        """Commit a Yjs update and its workspace revision as one guarded operation.

        The snapshot file is prepared before the workspace CAS. If the callback
        rejects the write, the canonical room is left untouched. Holding the room
        lock also prevents a WebSocket update from slipping between the merge and
        the corresponding encrypted workspace revision.
        """
        key = self._key(workspace_id, encryption_key)
        gateway = self._database_gateway(workspace_id)
        if gateway is not None:
            legacy = self._legacy_file_state(workspace_id, item_id)
            migrated = False

            def merge_and_commit(current):
                nonlocal migrated
                epoch = current.room_epoch if current else legacy[0] if legacy else self._new_epoch()
                migrated = current is None and legacy is not None
                if expected_epoch is not None and epoch != expected_epoch:
                    return CollaborativeRoomMutation(
                        epoch,
                        current.snapshot if current else legacy[1] if legacy else None,
                        current.bootstrap_lease_until if current else 0,
                        ValueError("collaborative room epoch conflict"),
                        False,
                    )
                try:
                    document, legacy_plaintext = self._decrypt_room_document(
                        workspace_id,
                        item_id,
                        current,
                        key,
                        legacy_snapshot=legacy[1] if current is None and legacy else None,
                        legacy_epoch=legacy[0] if current is None and legacy else None,
                    )
                    apply_update(document, update)
                    merged = encode_state_as_update(document)
                    merged_markdown = str(document.get_text("markdown"))
                    result = commit(merged_markdown)
                except BaseException as exc:  # noqa: BLE001
                    return CollaborativeRoomMutation(
                        epoch, current.snapshot if current else None, 0, exc, False
                    )
                return self._database_state_mutation(
                    workspace_id,
                    item_id,
                    current,
                    epoch,
                    merged,
                    key,
                    (merged, merged_markdown, result),
                    raw_update=update,
                    force_compact=legacy_plaintext or migrated,
                )

            stored = gateway.mutate_collaborative_room(
                workspace_id,
                item_id,
                merge_and_commit,
            )
            result = self._unwrap_database_result(stored)
            if migrated:
                self._remove_legacy_file_state(workspace_id, item_id)
            return result
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            epoch = self._ensure_epoch_locked(path)
            if expected_epoch is not None and epoch != expected_epoch:
                raise ValueError("collaborative room epoch conflict")
            current_stored = self._read_snapshot_locked(path)
            document = YDoc()
            if current_stored:
                current, _ = decrypt_collaboration_bytes(
                    key, current_stored, aad=self._aad(workspace_id, item_id, epoch, "file", 0)
                )
                apply_update(document, current)
            apply_update(document, update)
            merged = encode_state_as_update(document)
            merged_markdown = str(document.get_text("markdown"))
            encrypted = encrypt_collaboration_bytes(
                key, merged, aad=self._aad(workspace_id, item_id, epoch, "file", 0)
            )
            result = self._commit_snapshot_locked(path, encrypted, lambda: commit(merged_markdown))
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

    @staticmethod
    def _apply_minimal_markdown_diff(text, transaction, current: str, next_value: str) -> None:
        """Mutate only changed Y.Text spans, preserving CRDT identity elsewhere."""
        if current == next_value:
            return
        differ = diff_match_patch()
        diffs = differ.diff_main(current, next_value)
        differ.diff_cleanupEfficiency(diffs)
        cursor = 0
        for operation, value in diffs:
            if not value:
                continue
            if operation == differ.DIFF_EQUAL:
                cursor += len(value)
            elif operation == differ.DIFF_DELETE:
                text.delete_range(transaction, cursor, len(value))
            elif operation == differ.DIFF_INSERT:
                text.insert(transaction, cursor, value)
                cursor += len(value)

    def commit_markdown_change(
        self,
        workspace_id: str,
        item_id: str,
        base_markdown: str,
        next_markdown: str,
        commit: Callable[[str], T],
        encryption_key: bytes | None = None,
    ) -> tuple[bytes, str, T]:
        """Apply a REST text delta only if its workspace CAS also succeeds."""
        key = self._key(workspace_id, encryption_key)
        if base_markdown == next_markdown:
            # A duplicate/no-op REST callback must never initialize or rotate an
            # empty room while a WebSocket frame is in flight on another
            # connection. Give that frame a short opportunity to become visible;
            # if it has not, commit only the non-text workspace fields and leave
            # the room lineage untouched so the frame remains valid when it lands.
            observed_snapshot: bytes | None = None
            for _ in range(25):
                observed_snapshot = self.get_snapshot(workspace_id, item_id, encryption_key)
                if observed_snapshot is not None:
                    break
                time.sleep(0.01)
            if observed_snapshot is None:
                return b"", next_markdown, commit(next_markdown)
        gateway = self._database_gateway(workspace_id)
        if gateway is not None:
            legacy = self._legacy_file_state(workspace_id, item_id)
            migrated = False

            def apply_delta_and_commit(current):
                nonlocal migrated
                has_current_state = bool(
                    current and (current.snapshot is not None or current.updates)
                )
                epoch = (
                    current.room_epoch
                    if has_current_state
                    else legacy[0]
                    if current is None and legacy and legacy[1] is not None
                    else self._new_epoch()
                )
                migrated = current is None and legacy is not None
                try:
                    document, legacy_plaintext = self._decrypt_room_document(
                        workspace_id,
                        item_id,
                        current,
                        key,
                        legacy_snapshot=legacy[1] if current is None and legacy else None,
                        legacy_epoch=legacy[0] if current is None and legacy else None,
                    )
                    text = document.get_text("markdown")
                    current_markdown = str(text)
                    if not has_current_state and not (legacy and legacy[1] is not None):
                        merged_markdown = next_markdown
                    elif base_markdown == next_markdown:
                        merged_markdown = current_markdown
                    else:
                        differ = diff_match_patch()
                        patches = differ.patch_make(base_markdown, next_markdown)
                        merged_markdown, applied = differ.patch_apply(patches, current_markdown)
                        if not all(applied):
                            raise ValueError("collaborative markdown conflict")
                    if merged_markdown != current_markdown:
                        with document.begin_transaction() as transaction:
                            self._apply_minimal_markdown_diff(
                                text, transaction, current_markdown, merged_markdown
                            )
                    merged = encode_state_as_update(document)
                    result = commit(merged_markdown)
                except BaseException as exc:  # noqa: BLE001
                    return CollaborativeRoomMutation(
                        current.room_epoch if current else epoch,
                        current.snapshot if current else legacy[1] if legacy else None,
                        current.bootstrap_lease_until if current else 0,
                        exc,
                        False,
                    )
                return self._database_state_mutation(
                    workspace_id,
                    item_id,
                    current,
                    epoch,
                    merged,
                    key,
                    (merged, merged_markdown, result),
                    force_compact=True if legacy_plaintext or migrated else True,
                )

            stored = gateway.mutate_collaborative_room(
                workspace_id,
                item_id,
                apply_delta_and_commit,
            )
            result = self._unwrap_database_result(stored)
            if migrated:
                self._remove_legacy_file_state(workspace_id, item_id)
            return result
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            current_stored = self._read_snapshot_locked(path)
            if current_stored is None:
                # A server-side text write is now the canonical bootstrap. Rotate
                # the epoch so tickets previously issued to a client bootstrap
                # owner cannot later merge an independently seeded Yjs history.
                self._write_epoch_locked(path, self._new_epoch())
            else:
                self._ensure_epoch_locked(path)
            document = YDoc()
            if current_stored:
                current, _ = decrypt_collaboration_bytes(
                    key,
                    current_stored,
                    aad=self._aad(workspace_id, item_id, self._ensure_epoch_locked(path), "file", 0),
                )
                apply_update(document, current)
            text = document.get_text("markdown")
            current_markdown = str(text)
            if current_stored is None:
                merged_markdown = next_markdown
            elif base_markdown == next_markdown:
                merged_markdown = current_markdown
            else:
                differ = diff_match_patch()
                patches = differ.patch_make(base_markdown, next_markdown)
                merged_markdown, applied = differ.patch_apply(patches, current_markdown)
                if not all(applied):
                    raise ValueError("collaborative markdown conflict")
            if merged_markdown != current_markdown:
                with document.begin_transaction() as transaction:
                    self._apply_minimal_markdown_diff(
                        text, transaction, current_markdown, merged_markdown
                    )
            merged = encode_state_as_update(document)
            epoch = self._ensure_epoch_locked(path)
            encrypted = encrypt_collaboration_bytes(
                key, merged, aad=self._aad(workspace_id, item_id, epoch, "file", 0)
            )
            result = self._commit_snapshot_locked(path, encrypted, lambda: commit(merged_markdown))
            self._bootstrap_leases.pop(self._bootstrap_key(workspace_id, item_id), None)
            return merged, merged_markdown, result

    def get_markdown(
        self, workspace_id: str, item_id: str, encryption_key: bytes | None = None
    ) -> str | None:
        gateway = self._database_gateway(workspace_id)
        if gateway is not None:
            current = self.get_snapshot(workspace_id, item_id, encryption_key)
            if not current:
                return None
            document = YDoc()
            apply_update(document, current)
            return str(document.get_text("markdown"))
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            epoch = self._ensure_epoch_locked(path)
            stored = self._read_snapshot_locked(path)
            if not stored:
                return None
            current, _ = decrypt_collaboration_bytes(
                self._key(workspace_id, encryption_key),
                stored,
                aad=self._aad(workspace_id, item_id, epoch, "file", 0),
            )
            document = YDoc()
            apply_update(document, current)
            return str(document.get_text("markdown"))

    def claim_bootstrap(
        self,
        workspace_id: str,
        item_id: str,
        lease_seconds: float = 3.0,
        encryption_key: bytes | None = None,
    ) -> bool:
        """Atomically elect one client to seed a room that has no Yjs state yet."""
        _, _, bootstrap_owner = self.join_state(
            workspace_id, item_id, lease_seconds, encryption_key
        )
        return bootstrap_owner

    def _bootstrap_key(self, workspace_id: str, item_id: str) -> str:
        return f"{workspace_id}:{item_id}"

    def load_updates(
        self, workspace_id: str, item_id: str, encryption_key: bytes | None = None
    ) -> list[bytes]:
        gateway = self._database_gateway(workspace_id)
        if gateway is not None:
            _, snapshot = self.get_state(workspace_id, item_id, encryption_key)
            return [snapshot] if snapshot is not None else []
        path = self._file_path(workspace_id, item_id)
        with self._lock:
            epoch = self._ensure_epoch_locked(path)
            latest = self._read_snapshot_locked(path)
            if latest is None:
                return []
            plaintext, _ = decrypt_collaboration_bytes(
                self._key(workspace_id, encryption_key),
                latest,
                aad=self._aad(workspace_id, item_id, epoch, "file", 0),
            )
        return [plaintext]

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

    def _read_epoch_locked(self, path: Path) -> str | None:
        epoch_path = self._epoch_path(path)
        if not epoch_path.exists():
            return None
        epoch = epoch_path.read_text(encoding="utf-8").strip()
        return epoch or None

    def _has_receipt_locked(self, path: Path, update_id: str) -> bool:
        receipt_path = self._receipt_path(path)
        if not receipt_path.exists():
            return False
        return update_id in {
            line.strip()
            for line in receipt_path.read_text(encoding="utf-8").splitlines()[-8192:]
            if line.strip()
        }

    def _append_receipt_locked(self, path: Path, update_id: str) -> None:
        receipt_path = self._receipt_path(path)
        receipt_path.parent.mkdir(parents=True, exist_ok=True)
        existing = receipt_path.read_text(encoding="utf-8").splitlines() if receipt_path.exists() else []
        retained = [line for line in existing[-8191:] if line.strip()]
        retained.append(update_id)
        temporary = receipt_path.with_name(f".{receipt_path.name}.{threading.get_ident()}.tmp")
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as handle:
                handle.write("\n".join(retained))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, receipt_path)
        finally:
            temporary.unlink(missing_ok=True)

    def _ensure_epoch_locked(self, path: Path) -> str:
        epoch = self._read_epoch_locked(path)
        if epoch is not None:
            return epoch
        epoch = self._new_epoch()
        self._write_epoch_locked(path, epoch)
        return epoch

    def _write_epoch_locked(self, path: Path, epoch: str) -> None:
        epoch_path = self._epoch_path(path)
        epoch_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = epoch_path.with_name(f".{epoch_path.name}.{threading.get_ident()}.tmp")
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as handle:
                handle.write(epoch)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, epoch_path)
        finally:
            temporary.unlink(missing_ok=True)

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


def configure_collaborative_gateway_provider(provider: Callable[[], DatabaseGateway]) -> None:
    global _COLLAB_GATEWAY_PROVIDER
    _COLLAB_GATEWAY_PROVIDER = provider


def get_collaborative_update_store() -> CollaborativeUpdateStore:
    return _COLLAB_STORE


def reset_collab_store_for_tests() -> None:
    global _COLLAB_STORE
    _COLLAB_STORE = CollaborativeUpdateStore()
    _COLLAB_STORE.reset()
