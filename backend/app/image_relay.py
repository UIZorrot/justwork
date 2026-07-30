import asyncio
import base64
import hashlib
import json
import os
import secrets
import time
from dataclasses import dataclass
from typing import Any

from fastapi import WebSocket
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


@dataclass
class RelayTicket:
    workspace_id: str
    expires_at: float


@dataclass
class RelayMember:
    workspace_id: str
    session_id: str
    display_name: str
    user_id: str | None
    joined_at: str


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
        if msg_type == "relay.join":
            if "sessionId" in payload and payload.get("sessionId") is not None and not isinstance(payload.get("sessionId"), str):
                return None
            if "displayName" in payload and payload.get("displayName") is not None and not isinstance(payload.get("displayName"), str):
                return None
            if "userId" in payload and payload.get("userId") is not None and not isinstance(payload.get("userId"), str):
                return None
        if msg_type == "relay.leave":
            if "sessionId" in payload and payload.get("sessionId") is not None and not isinstance(payload.get("sessionId"), str):
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
    if msg_type == "workspace.presence.sync":
        return payload if isinstance(payload.get("workspaceId"), str) else None
    return None


class ImageRelayHub:
    def __init__(self, ticket_ttl_seconds: int = 120) -> None:
        self._ticket_ttl_seconds = ticket_ttl_seconds
        self._tickets: dict[str, RelayTicket] = {}
        self._rooms: dict[str, set[WebSocket]] = {}
        self._members: dict[str, dict[str, RelayMember]] = {}
        self._websocket_index: dict[WebSocket, tuple[str, str]] = {}
        self._lock = asyncio.Lock()
        configured_secret = (
            os.getenv("JUSTWORK_COLLAB_TICKET_SECRET", "").strip()
            or os.getenv("JUSTWORK_BACKEND_TOKEN", "").strip()
        )
        self._ticket_key_bytes = hashlib.sha256(
            (configured_secret or secrets.token_urlsafe(48)).encode("utf-8")
        ).digest()

    async def issue_ticket(self, workspace_id: str) -> tuple[str, str]:
        expires_at = time.time() + self._ticket_ttl_seconds
        claims = json.dumps(
            {"workspaceId": workspace_id, "expiresAt": expires_at},
            separators=(",", ":"),
        ).encode("utf-8")
        nonce = secrets.token_bytes(12)
        ciphertext = AESGCM(self._ticket_key_bytes).encrypt(
            nonce, claims, b"justwork-relay-ticket-v1"
        )
        ticket = base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii").rstrip("=")
        return ticket, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(expires_at))

    async def validate_ticket(self, workspace_id: str, ticket: str) -> bool:
        try:
            padded = ticket + ("=" * ((4 - len(ticket) % 4) % 4))
            packed = base64.urlsafe_b64decode(padded.encode("ascii"))
            claims = json.loads(AESGCM(self._ticket_key_bytes).decrypt(
                packed[:12], packed[12:], b"justwork-relay-ticket-v1"
            ))
            return (
                claims.get("workspaceId") == workspace_id
                and float(claims.get("expiresAt", 0)) >= time.time()
            )
        except Exception:  # noqa: BLE001 - invalid tickets are authentication failures
            return False

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

    async def register_member(
        self,
        workspace_id: str,
        websocket: WebSocket,
        session_id: str,
        display_name: str,
        user_id: str | None = None,
    ) -> RelayMember:
        member = RelayMember(
            workspace_id=workspace_id,
            session_id=session_id,
            display_name=display_name or "Guest",
            user_id=user_id.strip() if isinstance(user_id, str) and user_id.strip() else None,
            joined_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        )
        async with self._lock:
            room = self._members.setdefault(workspace_id, {})
            room[session_id] = member
            self._websocket_index[websocket] = (workspace_id, session_id)
        return member

    async def unregister_member(self, websocket: WebSocket) -> RelayMember | None:
        async with self._lock:
            ref = self._websocket_index.pop(websocket, None)
            if ref is None:
                return None
            workspace_id, session_id = ref
            room = self._members.get(workspace_id)
            member = room.pop(session_id, None) if room is not None else None
            if room is not None and not room:
                self._members.pop(workspace_id, None)
            return member

    async def get_member(self, websocket: WebSocket) -> RelayMember | None:
        async with self._lock:
            ref = self._websocket_index.get(websocket)
            if ref is None:
                return None
            workspace_id, session_id = ref
            return self._members.get(workspace_id, {}).get(session_id)

    async def list_members(self, workspace_id: str) -> list[dict[str, str]]:
        async with self._lock:
            room = list(self._members.get(workspace_id, {}).values())
        return [
            {
                "sessionId": member.session_id,
                "displayName": member.display_name,
                "userId": member.user_id,
                "joinedAt": member.joined_at,
            }
            for member in sorted(room, key=lambda member: member.joined_at)
        ]

    async def broadcast(self, workspace_id: str, sender: WebSocket | None, payload: dict[str, Any]) -> None:
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
