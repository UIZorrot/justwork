from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass

from fastapi import WebSocket

from .collab_store import (
    CollaborativeUpdateStore,
    get_collaborative_update_store,
    reset_collab_store_for_tests,
)


@dataclass
class CollabTicket:
    workspace_id: str
    item_id: str
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

    async def issue_ticket(self, workspace_id: str, item_id: str) -> tuple[str, str]:
        ticket = secrets.token_urlsafe(32)
        expires_at = time.time() + self._ticket_ttl_seconds
        async with self._lock:
            self._tickets[self._ticket_key(workspace_id, item_id, ticket)] = CollabTicket(
                workspace_id=workspace_id,
                item_id=item_id,
                expires_at=expires_at,
            )
        return ticket, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(expires_at))

    async def validate_ticket(self, workspace_id: str, item_id: str, ticket: str) -> bool:
        key = self._ticket_key(workspace_id, item_id, ticket)
        async with self._lock:
            record = self._tickets.get(key)
            if record is None:
                return False
            if record.expires_at < time.time():
                self._tickets.pop(key, None)
                return False
            self._tickets.pop(key, None)
            return True

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

    async def broadcast(self, workspace_id: str, item_id: str, sender: WebSocket, payload: bytes) -> None:
        async with self._lock:
            recipients = [ws for ws in self._rooms.get(self._room_key(workspace_id, item_id), set()) if ws is not sender]
        dead: list[WebSocket] = []
        for ws in recipients:
            try:
                await ws.send_bytes(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.unregister(workspace_id, item_id, ws)

    def snapshot(self, workspace_id: str, item_id: str) -> bytes | None:
        return self._store.get_snapshot(workspace_id, item_id)

    async def store_snapshot(self, workspace_id: str, item_id: str, payload: bytes) -> None:
        self._store.set_snapshot(workspace_id, item_id, payload)

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
