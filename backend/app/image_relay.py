import asyncio
import secrets
import time
from dataclasses import dataclass
from typing import Any

from fastapi import WebSocket


@dataclass
class RelayTicket:
    workspace_id: str
    expires_at: float


def parse_relay_payload(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    msg_type = payload.get("type")
    if not isinstance(msg_type, str):
        return None
    if msg_type in {"relay.join", "relay.leave"}:
        workspace_id = payload.get("workspaceId")
        if not isinstance(workspace_id, str):
            return None
        if msg_type == "relay.join" and not isinstance(payload.get("ticket"), str):
            return None
        return payload
    if msg_type == "asset.manifest":
        meta = payload.get("meta")
        if not isinstance(meta, dict):
            return None
        if not all(isinstance(meta.get(key), str) for key in ("workspaceId", "assetId", "mimeType", "sha256")):
            return None
        if not isinstance(meta.get("sizeBytes"), int):
            return None
        return payload
    if msg_type in {"asset.request", "asset.missing", "asset.ack"}:
        if not isinstance(payload.get("workspaceId"), str) or not isinstance(payload.get("assetId"), str):
            return None
        return payload
    if msg_type == "asset.chunk":
        if not isinstance(payload.get("workspaceId"), str) or not isinstance(payload.get("assetId"), str):
            return None
        if not isinstance(payload.get("index"), int) or not isinstance(payload.get("total"), int):
            return None
        if not isinstance(payload.get("chunkBase64"), str):
            return None
        return payload
    return None


class ImageRelayHub:
    def __init__(self, ticket_ttl_seconds: int = 120) -> None:
        self._ticket_ttl_seconds = ticket_ttl_seconds
        self._tickets: dict[str, RelayTicket] = {}
        self._rooms: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def issue_ticket(self, workspace_id: str) -> tuple[str, str]:
        ticket = secrets.token_urlsafe(32)
        expires_at = time.time() + self._ticket_ttl_seconds
        async with self._lock:
            self._tickets[self._ticket_key(workspace_id, ticket)] = RelayTicket(
                workspace_id=workspace_id,
                expires_at=expires_at,
            )
        return ticket, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(expires_at))

    async def validate_ticket(self, workspace_id: str, ticket: str) -> bool:
        key = self._ticket_key(workspace_id, ticket)
        async with self._lock:
            record = self._tickets.get(key)
            if record is None:
                return False
            if record.expires_at < time.time():
                self._tickets.pop(key, None)
                return False
            self._tickets.pop(key, None)
            return True

    async def register(self, workspace_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            self._rooms.setdefault(workspace_id, set()).add(websocket)

    async def unregister(self, workspace_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            room = self._rooms.get(workspace_id)
            if room is None:
                return
            room.discard(websocket)
            if not room:
                self._rooms.pop(workspace_id, None)

    async def broadcast(self, workspace_id: str, sender: WebSocket, payload: dict[str, Any]) -> None:
        async with self._lock:
            recipients = [ws for ws in self._rooms.get(workspace_id, set()) if ws is not sender]
        dead: list[WebSocket] = []
        for ws in recipients:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.unregister(workspace_id, ws)

    def _ticket_key(self, workspace_id: str, ticket: str) -> str:
        return f"{workspace_id}:{ticket}"


_IMAGE_RELAY_HUB = ImageRelayHub()


def get_image_relay_hub() -> ImageRelayHub:
    return _IMAGE_RELAY_HUB


def reset_image_relay_for_tests() -> None:
    global _IMAGE_RELAY_HUB
    _IMAGE_RELAY_HUB = ImageRelayHub()
