from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import secrets
import time
from dataclasses import dataclass

from fastapi import WebSocket
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .collab_store import (
    CollaborativeUpdateStore,
    get_collaborative_update_store,
    reset_collab_store_for_tests,
)


@dataclass
class CollabTicket:
    workspace_id: str
    item_id: str
    room_epoch: str
    writable: bool
    encryption_key: bytes
    protocol_version: int
    expires_at: float


class CollaborativeRelayHub:
    def __init__(
        self,
        ticket_ttl_seconds: int = 120,
        store: CollaborativeUpdateStore | None = None,
    ) -> None:
        self._ticket_ttl_seconds = ticket_ttl_seconds
        self._store = store or get_collaborative_update_store()
        self._tickets: dict[str, CollabTicket] = {}
        self._rooms: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()
        configured_secret = (
            os.getenv("JUSTWORK_COLLAB_TICKET_SECRET", "").strip()
            or os.getenv("JUSTWORK_BACKEND_TOKEN", "").strip()
        )
        self._ticket_key_bytes = hashlib.sha256(
            (configured_secret or secrets.token_urlsafe(48)).encode("utf-8")
        ).digest()

    async def issue_ticket(
        self,
        workspace_id: str,
        item_id: str,
        room_epoch: str,
        *,
        writable: bool,
        encryption_key: bytes,
        protocol_version: int,
    ) -> tuple[str, str]:
        expires_at = time.time() + self._ticket_ttl_seconds
        claims = json.dumps({
            "workspaceId": workspace_id,
            "itemId": item_id,
            "roomEpoch": room_epoch,
            "writable": writable,
            "encryptionKey": base64.urlsafe_b64encode(encryption_key).decode("ascii"),
            "protocolVersion": protocol_version,
            "expiresAt": expires_at,
        }, separators=(",", ":")).encode("utf-8")
        nonce = secrets.token_bytes(12)
        encrypted = AESGCM(self._ticket_key_bytes).encrypt(
            nonce, claims, b"justwork-collab-ticket-v1"
        )
        ticket = base64.urlsafe_b64encode(nonce + encrypted).decode("ascii").rstrip("=")
        return ticket, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(expires_at))

    async def validate_ticket(
        self, workspace_id: str, item_id: str, ticket: str
    ) -> tuple[str, bool, bytes, int] | None:
        try:
            padded = ticket + ("=" * ((4 - len(ticket) % 4) % 4))
            packed = base64.urlsafe_b64decode(padded.encode("ascii"))
            claims = json.loads(AESGCM(self._ticket_key_bytes).decrypt(
                packed[:12], packed[12:], b"justwork-collab-ticket-v1"
            ))
            if (
                claims.get("workspaceId") != workspace_id
                or claims.get("itemId") != item_id
                or float(claims.get("expiresAt", 0)) < time.time()
            ):
                return None
            return (
                str(claims["roomEpoch"]),
                bool(claims["writable"]),
                base64.urlsafe_b64decode(str(claims["encryptionKey"]).encode("ascii")),
                int(claims.get("protocolVersion", 1)),
            )
        except Exception:  # noqa: BLE001 - invalid tickets are authentication failures
            return None

    async def register(self, workspace_id: str, item_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            self._rooms.setdefault(self._room_key(workspace_id, item_id), set()).add(websocket)

    async def unregister(self, workspace_id: str, item_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            room = self._rooms.get(self._room_key(workspace_id, item_id))
            if room is None:
                return
            room.discard(websocket)
            if not room:
                self._rooms.pop(self._room_key(workspace_id, item_id), None)

    async def broadcast(
        self,
        workspace_id: str,
        item_id: str,
        sender: WebSocket | None,
        payload: bytes | str,
    ) -> None:
        async with self._lock:
            recipients = [ws for ws in self._rooms.get(self._room_key(workspace_id, item_id), set()) if ws is not sender]
        dead: list[WebSocket] = []
        for ws in recipients:
            try:
                if isinstance(payload, str):
                    await ws.send_text(payload)
                else:
                    await ws.send_bytes(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.unregister(workspace_id, item_id, ws)

    def snapshot(self, workspace_id: str, item_id: str, encryption_key: bytes) -> bytes | None:
        return self._store.get_snapshot(workspace_id, item_id, encryption_key)

    async def store_snapshot(
        self, workspace_id: str, item_id: str, payload: bytes, encryption_key: bytes
    ) -> None:
        self._store.append_update(workspace_id, item_id, payload, encryption_key=encryption_key)

    def delete_snapshot(self, workspace_id: str, item_id: str) -> None:
        self._store.delete_snapshot(workspace_id, item_id)

    def _ticket_key(self, workspace_id: str, item_id: str, ticket: str) -> str:
        return f"{workspace_id}:{item_id}:{ticket}"

    def _room_key(self, workspace_id: str, item_id: str) -> str:
        return f"{workspace_id}:{item_id}"


_COLLAB_RELAY_HUB = CollaborativeRelayHub()


def get_collaborative_relay_hub() -> CollaborativeRelayHub:
    return _COLLAB_RELAY_HUB


def reset_collaborative_relay_for_tests() -> None:
    global _COLLAB_RELAY_HUB
    reset_collab_store_for_tests()
    _COLLAB_RELAY_HUB = CollaborativeRelayHub(store=get_collaborative_update_store())
