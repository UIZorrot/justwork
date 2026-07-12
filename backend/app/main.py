import os
import json
import time
import base64
import hmac
import hashlib
import secrets
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None

# backend/.env — server-side only (gitignored). Keeps secrets out of the extension repo root.
if load_dotenv:
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel
from fastapi.responses import JSONResponse, HTMLResponse, PlainTextResponse, Response
from fastapi.middleware.cors import CORSMiddleware

from .db_gateway import DatabaseGateway, DatabaseUnavailableError
from .collab_relay import (
    get_collaborative_relay_hub as get_collab_relay_hub,
    reset_collaborative_relay_for_tests as reset_collaborative_relay_hub_for_tests,
)
from .collab_store import get_collaborative_update_store, reset_collab_store_for_tests
from .models import (
    ErrorBody,
    ErrorResponse,
    HealthResponse,
    ProfileBody,
    WorkspaceMemberBody,
    WorkspaceMembersResponse,
    ProfileResponse,
    WorkspaceQuotaBody,
    WorkspaceQuotaResponse,
    ProfileUpdateRequest,
    WorkspaceCollabJoinRequest,
    WorkspaceCollabJoinResponse,
    WorkspaceRelayJoinRequest,
    WorkspaceRelayJoinResponse,
    WorkspaceCreateRequest,
    WorkspaceCreateResponse,
    WorkspaceGetResponse,
    WorkspaceItemCreateRequest,
    WorkspaceItemPinRequest,
    WorkspaceItemResponse,
    WorkspaceShareCreateResponse,
    ShareViewRequest,
    ShareViewResponse,
    WorkspaceItemMoveRequest,
    WorkspaceItemUpdateRequest,
    WorkspaceOutlineResponse,
    WorkspacePatchRequest,
    WorkspacePatchResponse,
    WorkspacePasswordRequest,
    WorkspaceRecord,
    WorkspaceSearchRequest,
    WorkspaceSearchResponse,
    WorkspaceSettingsResponse,
    WorkspaceSettingsUpdateRequest,
    WorkspaceSummary,
    WorkspaceTreeResponse,
    WorkspaceUpsertRequest,
)
from .image_assets import get_image_asset_archive, reset_image_asset_archive_for_tests as reset_image_asset_archive_hub_for_tests
from .image_relay import get_image_relay_hub, parse_relay_payload, reset_image_relay_for_tests as reset_image_relay_hub_for_tests
from .write_signing import verify_signed_write_body
from .workspace_crypto import InvalidWorkspacePassword, decrypt_workspace_payload, encrypt_workspace_payload
from .workspace_runtime import (
    create_doc,
    default_workspace_title,
    display_name,
    find_doc,
    get_workspace_title,
    hard_delete_doc,
    item_view,
    make_initial_workspace_state,
    make_workspace_id,
    choose_active_item_id,
    ensure_workspace_members,
    ensure_actor_workspace_member,
    move_doc,
    now_iso,
    normalize_workspace_state,
    outline,
    patch_doc,
    restore_doc,
    search_docs,
    set_doc_pin,
    trash_doc,
    tree_items,
    update_doc,
    upsert_workspace_member,
    update_workspace_title,
    workspace_member_views,
)

app = FastAPI(title="JustWork Backend Gateway", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_gateway: DatabaseGateway | None = None
_backend_token = os.getenv("JUSTWORK_BACKEND_TOKEN", "").strip()

QUOTA_PLAN_FREE = "free"
QUOTA_PLAN_PRO = "pro"
MAX_WORKSPACES_PER_OWNER = 5
AGENT_SKILL_PATH = Path(__file__).resolve().parent.parent / "agent" / "SKILL.md"
SYNC_MUTATION_LOG_KEY = "__syncMutations"
MAX_SYNC_MUTATION_LOG_ENTRIES = 1000


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _quota_plan_for_workspace(_: WorkspaceRecord | None = None) -> str:
    raw = os.getenv("JUSTWORK_QUOTA_PLAN", QUOTA_PLAN_FREE).strip().lower()
    return QUOTA_PLAN_PRO if raw == QUOTA_PLAN_PRO else QUOTA_PLAN_FREE


def _quota_limits(plan: str) -> dict[str, int]:
    if plan == QUOTA_PLAN_PRO:
        return {
            "workspace_max_bytes": max(1024, _int_env("JUSTWORK_QUOTA_WORKSPACE_MAX_BYTES_PRO", 209_715_200)),
            "page_max_count": max(1, _int_env("JUSTWORK_QUOTA_PAGE_MAX_COUNT_PRO", 1_500)),
            "folder_max_count": max(1, _int_env("JUSTWORK_QUOTA_FOLDER_MAX_COUNT_PRO", 500)),
        }
    return {
        "workspace_max_bytes": max(1024, _int_env("JUSTWORK_QUOTA_WORKSPACE_MAX_BYTES_FREE", 41_943_040)),
        "page_max_count": max(1, _int_env("JUSTWORK_QUOTA_PAGE_MAX_COUNT_FREE", 300)),
        "folder_max_count": max(1, _int_env("JUSTWORK_QUOTA_FOLDER_MAX_COUNT_FREE", 100)),
    }


def _state_payload_size_bytes(state_payload: dict) -> int:
    return len(json.dumps(state_payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def get_workspace_quota_snapshot(record: WorkspaceRecord) -> WorkspaceQuotaBody:
    plan = _quota_plan_for_workspace(record)
    limits = _quota_limits(plan)
    used_bytes = len(record.encrypted_payload.encode("utf-8"))
    limit_bytes = limits["workspace_max_bytes"]
    usage_ratio = 1.0 if limit_bytes <= 0 else min(1.0, used_bytes / limit_bytes)
    return WorkspaceQuotaBody(
        plan=plan,
        used_bytes=used_bytes,
        limit_bytes=limit_bytes,
        usage_ratio=usage_ratio,
    )


def apply_workspace_quotas_or_raise(state_payload: dict, plan: str) -> None:
    limits = _quota_limits(plan)

    docs = state_payload.get("docs", [])
    page_count = 0
    folder_count = 0
    if isinstance(docs, list):
        for doc in docs:
            if not isinstance(doc, dict):
                continue
            doc_id = str(doc.get("id", ""))
            kind = str(doc.get("kind", ""))
            if doc_id in ("root", "welcome"):
                continue
            if kind == "page":
                page_count += 1
            elif kind == "folder":
                folder_count += 1

    if page_count > limits["page_max_count"]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="page count exceeded")
    if folder_count > limits["folder_max_count"]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="folder count exceeded")

    payload_size = _state_payload_size_bytes(state_payload)
    if payload_size > limits["workspace_max_bytes"]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="workspace quota exceeded")


def _share_secret() -> bytes:
    raw = os.getenv("JUSTWORK_SHARE_SECRET", "").strip()
    if raw:
        return raw.encode("utf-8")
    # Dev fallback: deterministic-enough local secret.
    return b"justwork-dev-share-secret"


def _urlsafe_b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _urlsafe_unb64(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode((text + pad).encode("ascii"))


def create_share_token(workspace_id: str, item_id: str) -> str:
    payload = {
        "w": workspace_id,
        "i": item_id,
        "ts": int(time.time()),
        "n": secrets.token_hex(6),
    }
    payload_b64 = _urlsafe_b64(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = hmac.new(_share_secret(), payload_b64.encode("ascii"), hashlib.sha256).digest()
    sig_b64 = _urlsafe_b64(sig)
    return f"{payload_b64}.{sig_b64}"


def parse_share_token_or_raise(token: str) -> tuple[str, str]:
    try:
        payload_b64, sig_b64 = token.split(".", 1)
        expected = hmac.new(_share_secret(), payload_b64.encode("ascii"), hashlib.sha256).digest()
        got = _urlsafe_unb64(sig_b64)
        if not hmac.compare_digest(expected, got):
            raise ValueError("signature mismatch")
        payload = json.loads(_urlsafe_unb64(payload_b64).decode("utf-8"))
        workspace_id = str(payload.get("w", "")).strip()
        item_id = str(payload.get("i", "")).strip()
        if not workspace_id or not item_id:
            raise ValueError("missing token fields")
        return workspace_id, item_id
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="share link not found") from exc


def get_gateway() -> DatabaseGateway:
    global _gateway
    if _gateway is None:
        _gateway = DatabaseGateway()
    return _gateway


def reset_gateway_for_tests() -> None:
    global _gateway
    _gateway = None


def reset_image_relay_for_tests() -> None:
    reset_image_relay_hub_for_tests()


def reset_collab_relay_for_tests() -> None:
    reset_collab_store_for_tests()
    reset_collaborative_relay_hub_for_tests()


def reset_image_assets_for_tests() -> None:
    reset_image_asset_archive_hub_for_tests()


def reset_collaborative_relay_for_tests() -> None:
    reset_collab_store_for_tests()
    reset_collaborative_relay_hub_for_tests()


def _chunk_bytes(payload: bytes, chunk_size: int = 256 * 1024) -> list[bytes]:
    if not payload:
        return [b""]
    return [payload[index : index + chunk_size] for index in range(0, len(payload), chunk_size)]


async def _send_asset_to_websocket(websocket: WebSocket, meta: dict, payload: bytes) -> None:
    await websocket.send_json({"type": "asset.manifest", "meta": meta})
    chunks = _chunk_bytes(payload)
    total = len(chunks)
    for index, chunk in enumerate(chunks):
        await websocket.send_json(
            {
                "type": "asset.chunk",
                "workspaceId": meta["workspaceId"],
                "assetId": meta["assetId"],
                "index": index,
                "total": total,
                "chunkBase64": base64.b64encode(chunk).decode("ascii"),
            }
        )


async def _send_collaborative_updates(websocket: WebSocket, updates: list[bytes]) -> None:
    for update in updates:
        await websocket.send_bytes(update)


def require_backend_token(authorization: str | None = Header(default=None)) -> None:
    if not _backend_token:
        return
    expected = f"Bearer {_backend_token}"
    if authorization != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")


@app.exception_handler(HTTPException)
async def http_exception_handler(_: Request, exc: HTTPException) -> JSONResponse:
    code = "http_error"
    if exc.status_code == status.HTTP_401_UNAUTHORIZED:
        code = "unauthorized"
    elif exc.status_code == status.HTTP_404_NOT_FOUND:
        code = "not_found"
    elif exc.status_code == status.HTTP_403_FORBIDDEN and exc.detail == "invalid workspace password":
        code = "invalid_workspace_password"
    elif exc.status_code == status.HTTP_409_CONFLICT:
        if exc.detail == "workspace quota exceeded":
            code = "workspace_quota_exceeded"
        elif exc.detail == "workspace create limit exceeded":
            code = "workspace_create_limit_exceeded"
        elif exc.detail == "page count exceeded":
            code = "page_count_exceeded"
        elif exc.detail == "folder count exceeded":
            code = "folder_count_exceeded"
        else:
            code = "conflict"
    payload = ErrorResponse(error=ErrorBody(code=code, message=str(exc.detail))).model_dump()
    return JSONResponse(status_code=exc.status_code, content=payload)


@app.exception_handler(DatabaseUnavailableError)
async def database_unavailable_exception_handler(_: Request, exc: DatabaseUnavailableError) -> JSONResponse:
    payload = ErrorResponse(
        error=ErrorBody(code="database_unavailable", message=str(exc)),
    ).model_dump()
    return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content=payload)


@app.get("/v1/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse()


@app.get("/agent/SKILL.md", response_class=PlainTextResponse, include_in_schema=False)
def agent_skill() -> PlainTextResponse:
    try:
        body = AGENT_SKILL_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="agent skill not found")
    return PlainTextResponse(body, media_type="text/markdown")


def summarize_workspace(record: WorkspaceRecord) -> WorkspaceSummary:
    return WorkspaceSummary(
        workspace_id=record.workspace_id,
        owner_user_id=record.owner_user_id,
        owner_nickname=record.owner_nickname,
        owner_display_name=display_name(record.owner_nickname, record.owner_user_id),
        encrypted_payload=record.encrypted_payload,
        updated_at=record.updated_at,
    )


def load_decrypted_state(record: WorkspaceRecord, password: str) -> dict:
    try:
        state = decrypt_workspace_payload(record.encrypted_payload, password)
        if isinstance(state, dict):
            state.pop("history", None)
            normalized = normalize_workspace_state(state)
            ensure_workspace_members(normalized, record.owner_user_id, record.owner_nickname)
            return normalized
        return state
    except InvalidWorkspacePassword as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="invalid workspace password") from exc


def actor_from_body(
    body: BaseModel,
    request: Request,
    workspace_id: str,
    target_id: str,
) -> tuple[str | None, bool, str | None]:
    return verify_signed_write_body(
        body,
        method=request.method,
        path=request.url.path,
        workspace_id=workspace_id,
        target_id=target_id,
    )


def client_mutation_id_from_body(body: BaseModel) -> str | None:
    raw = str(getattr(body, "client_mutation_id", "") or "").strip()
    if not raw:
        return None
    if len(raw) > 200:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="client mutation id too long")
    return raw


def recorded_mutation_item(
    state_payload: dict,
    mutation_id: str | None,
    *,
    operation: str,
    target_id: str,
) -> dict | None:
    entry = recorded_mutation_entry(
        state_payload,
        mutation_id,
        operation=operation,
        target_id=target_id,
    )
    if entry is None:
        return None
    item = entry.get("item")
    if not isinstance(item, dict):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="mutation record conflict")
    return item


def recorded_mutation_entry(
    state_payload: dict,
    mutation_id: str | None,
    *,
    operation: str,
    target_id: str,
) -> dict | None:
    if mutation_id is None:
        return None
    entries = state_payload.get(SYNC_MUTATION_LOG_KEY)
    if not isinstance(entries, list):
        return None
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("id") != mutation_id:
            continue
        if entry.get("operation") != operation or entry.get("targetId", "") != target_id:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="mutation id conflict")
        return entry
    return None


def record_mutation_item(
    state_payload: dict,
    mutation_id: str | None,
    *,
    operation: str,
    target_id: str,
    item: dict,
) -> None:
    if mutation_id is None:
        return
    entries = state_payload.get(SYNC_MUTATION_LOG_KEY)
    if not isinstance(entries, list):
        entries = []
        state_payload[SYNC_MUTATION_LOG_KEY] = entries
    entries.append(
        {
            "id": mutation_id,
            "operation": operation,
            "targetId": target_id,
            "item": item,
            "createdAt": now_iso(),
        }
    )
    if len(entries) > MAX_SYNC_MUTATION_LOG_ENTRIES:
        del entries[0 : len(entries) - MAX_SYNC_MUTATION_LOG_ENTRIES]


def record_patch_mutation(
    state_payload: dict,
    mutation_id: str | None,
    *,
    target_id: str,
    item: dict,
    changed: bool,
    preview_markdown: str,
) -> None:
    record_mutation_item(state_payload, mutation_id, operation="patch", target_id=target_id, item=item)
    if mutation_id is None:
        return
    entries = state_payload.get(SYNC_MUTATION_LOG_KEY)
    if not isinstance(entries, list):
        return
    for entry in reversed(entries):
        if isinstance(entry, dict) and entry.get("id") == mutation_id:
            entry["changed"] = changed
            entry["previewMarkdown"] = preview_markdown
            return


def require_expected_revision(state_payload: dict, item_id: str, expected_revision: int | None) -> dict:
    doc = find_doc(state_payload, item_id)
    if doc is None:
        raise KeyError(item_id)
    if expected_revision is not None and int(doc.get("revision", 0)) != expected_revision:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="revision conflict")
    return doc


def require_workspace(gateway: DatabaseGateway, workspace_id: str) -> WorkspaceRecord:
    workspace = gateway.get_workspace(workspace_id)
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="workspace not found")
    return workspace


def require_collaborative_markdown_item(
    gateway: DatabaseGateway,
    workspace_id: str,
    item_id: str,
    password: str,
) -> tuple[WorkspaceRecord, dict, dict]:
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, password)
    doc = find_doc(state_payload, item_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found")
    if doc.get("kind") != "page":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="collaboration requires markdown text")
    return record, state_payload, doc


def save_state(
    gateway: DatabaseGateway,
    record: WorkspaceRecord,
    state_payload: dict,
    password: str,
    *,
    owner_nickname: str | None = None,
    actor_user_id: str | None = None,
) -> WorkspaceRecord:
    state_payload.pop("history", None)
    next_owner_nickname = record.owner_nickname if owner_nickname is None else owner_nickname
    ensure_workspace_members(state_payload, record.owner_user_id, next_owner_nickname)
    ensure_actor_workspace_member(state_payload, record.owner_user_id, actor_user_id)
    apply_workspace_quotas_or_raise(state_payload, _quota_plan_for_workspace(record))
    next_record = WorkspaceRecord(
        workspace_id=record.workspace_id,
        owner_user_id=record.owner_user_id,
        owner_nickname=next_owner_nickname,
        encrypted_payload=encrypt_workspace_payload(record.workspace_id, state_payload, password),
        updated_at=now_iso(),
    )
    return gateway.upsert_workspace(next_record)


@app.post("/v1/workspaces", response_model=WorkspaceCreateResponse)
def create_workspace(
    body: WorkspaceCreateRequest,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceCreateResponse:
    workspace_id = make_workspace_id()
    raw_title = (body.title or "").strip()
    default_title = default_workspace_title(workspace_id)
    workspace_title = raw_title or default_title
    state_payload = make_initial_workspace_state(workspace_title)
    ensure_workspace_members(state_payload, body.owner_user_id, body.nickname)
    apply_workspace_quotas_or_raise(state_payload, _quota_plan_for_workspace(None))
    now = now_iso()
    encrypted_payload = encrypt_workspace_payload(workspace_id, state_payload, body.password)
    record = WorkspaceRecord(
        workspace_id=workspace_id,
        owner_user_id=body.owner_user_id,
        owner_nickname=body.nickname,
        encrypted_payload=encrypted_payload,
        updated_at=now,
    )
    saved = gateway.insert_workspace_with_owner_limit(record, MAX_WORKSPACES_PER_OWNER)
    if saved is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="workspace create limit exceeded")
    return WorkspaceCreateResponse(
        ok=True,
        workspace=summarize_workspace(saved),
        workspace_title=get_workspace_title(state_payload, workspace_id),
        active_item_id=choose_active_item_id(state_payload),
        items=tree_items(state_payload),
    )


@app.get("/v1/workspaces/{workspace_id}/profile", response_model=ProfileResponse)
def get_profile(
    workspace_id: str,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> ProfileResponse:
    record = require_workspace(gateway, workspace_id)
    return ProfileResponse(
        ok=True,
        profile=ProfileBody(
            user_id=record.owner_user_id,
            nickname=record.owner_nickname,
            display_name=display_name(record.owner_nickname, record.owner_user_id),
        ),
    )


@app.get("/v1/workspaces/{workspace_id}/quota", response_model=WorkspaceQuotaResponse)
def get_workspace_quota(
    workspace_id: str,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceQuotaResponse:
    record = require_workspace(gateway, workspace_id)
    return WorkspaceQuotaResponse(
        ok=True,
        workspace_id=workspace_id,
        quota=get_workspace_quota_snapshot(record),
    )


@app.post("/v1/workspaces/{workspace_id}/members", response_model=WorkspaceMembersResponse)
def list_workspace_members(
    workspace_id: str,
    body: WorkspacePasswordRequest,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceMembersResponse:
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    return WorkspaceMembersResponse(
        ok=True,
        workspace_id=workspace_id,
        members=[WorkspaceMemberBody(**member) for member in workspace_member_views(state_payload, record.owner_user_id)],
    )


@app.post("/v1/workspaces/{workspace_id}/relay/join", response_model=WorkspaceRelayJoinResponse)
async def join_workspace_relay(
    workspace_id: str,
    body: WorkspaceRelayJoinRequest,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceRelayJoinResponse:
    record = require_workspace(gateway, workspace_id)
    load_decrypted_state(record, body.password)
    hub = get_image_relay_hub()
    ticket, expires_at = await hub.issue_ticket(workspace_id)
    return WorkspaceRelayJoinResponse(ok=True, workspace_id=workspace_id, ticket=ticket, expires_at=expires_at)


@app.websocket("/v1/workspaces/{workspace_id}/relay")
async def workspace_image_relay(
    websocket: WebSocket,
    workspace_id: str,
    ticket: str,
) -> None:
    hub = get_image_relay_hub()
    asset_archive = get_image_asset_archive()
    pending_asset_uploads: dict[str, dict[str, object]] = {}
    if not await hub.validate_ticket(workspace_id, ticket):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    await hub.register(workspace_id, websocket)
    try:
        while True:
            payload = await websocket.receive_json()
            parsed = parse_relay_payload(payload)
            if parsed is None:
                continue
            message_workspace_id = parsed.get("workspaceId")
            if isinstance(message_workspace_id, str) and message_workspace_id != workspace_id:
                continue
            message_type = parsed.get("type")
            if message_type == "asset.manifest":
                meta = parsed.get("meta")
                if not isinstance(meta, dict):
                    continue
                if str(meta.get("workspaceId", "")) != workspace_id:
                    continue
                asset_id = str(meta.get("assetId", "")).strip()
                if not asset_id:
                    continue
                pending_asset_uploads[asset_id] = {"meta": meta, "chunks": {}, "total": None}
                await hub.broadcast(workspace_id, websocket, parsed)
                continue
            if message_type == "asset.chunk":
                asset_id = str(parsed.get("assetId", "")).strip()
                if not asset_id:
                    continue
                record = pending_asset_uploads.setdefault(asset_id, {"meta": None, "chunks": {}, "total": None})
                chunks = record.setdefault("chunks", {})
                if not isinstance(chunks, dict):
                    continue
                index = parsed.get("index")
                total = parsed.get("total")
                chunk_base64 = parsed.get("chunkBase64")
                if not isinstance(index, int) or not isinstance(total, int) or not isinstance(chunk_base64, str):
                    continue
                chunks[index] = chunk_base64
                record["total"] = total
                meta = record.get("meta")
                if isinstance(meta, dict) and len(chunks) >= total and all(i in chunks for i in range(total)):
                    try:
                        payload_bytes = b"".join(base64.b64decode(chunks[i]) for i in range(total))
                        asset_archive.put(meta, payload_bytes)
                    except Exception:
                        pass
                await hub.broadcast(workspace_id, websocket, parsed)
                continue
            if message_type == "workspace.presence.sync":
                await websocket.send_json(
                    {
                        "type": "workspace.presence.snapshot",
                        "workspaceId": workspace_id,
                        "members": await hub.list_members(workspace_id),
                    }
                )
                continue
            if message_type == "relay.join":
                member_session_id = str(parsed.get("sessionId", "")).strip() or secrets.token_urlsafe(8)
                display_name = str(parsed.get("displayName", "")).strip() or "Guest"
                user_id = str(parsed.get("userId", "")).strip() or None
                await hub.register_member(workspace_id, websocket, member_session_id, display_name, user_id)
                await hub.broadcast(
                    workspace_id,
                    websocket,
                    {
                        "type": "workspace.presence.join",
                        "workspaceId": workspace_id,
                        "member": {
                            "sessionId": member_session_id,
                            "displayName": display_name,
                            "userId": user_id,
                            "joinedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                        },
                    },
                )
                continue
            if message_type == "asset.request":
                asset_id = str(parsed.get("assetId", "")).strip()
                if asset_id:
                    cached = asset_archive.get(workspace_id, asset_id)
                    if cached is not None:
                        await _send_asset_to_websocket(websocket, cached["meta"], cached["bytes"])
                        continue
                await hub.broadcast(workspace_id, websocket, parsed)
                continue
            if message_type == "relay.leave":
                member = await hub.unregister_member(websocket)
                if member is not None:
                    await hub.broadcast(
                        workspace_id,
                        websocket,
                        {
                            "type": "workspace.presence.leave",
                            "workspaceId": workspace_id,
                            "sessionId": member.session_id,
                        },
                    )
                await hub.broadcast(workspace_id, websocket, parsed)
                break
            await hub.broadcast(workspace_id, websocket, parsed)
    except WebSocketDisconnect:
        pass
    finally:
        member = await hub.unregister_member(websocket)
        if member is not None:
            await hub.broadcast(
                workspace_id,
                websocket,
                {
                    "type": "workspace.presence.leave",
                    "workspaceId": workspace_id,
                    "sessionId": member.session_id,
                },
            )
        await hub.unregister(workspace_id, websocket)


@app.post("/v1/workspaces/{workspace_id}/items/{item_id}/collab/join", response_model=WorkspaceCollabJoinResponse)
async def join_workspace_collab(
    workspace_id: str,
    item_id: str,
    body: WorkspaceCollabJoinRequest,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceCollabJoinResponse:
    require_collaborative_markdown_item(gateway, workspace_id, item_id, body.password)
    hub = get_collab_relay_hub()
    ticket, expires_at = await hub.issue_ticket(workspace_id, item_id)
    return WorkspaceCollabJoinResponse(
        ok=True,
        workspace_id=workspace_id,
        item_id=item_id,
        ticket=ticket,
        expires_at=expires_at,
    )


@app.post("/v1/workspaces/{workspace_id}/items/{item_id}/collab/state")
def get_workspace_collab_state(
    workspace_id: str,
    item_id: str,
    body: WorkspacePasswordRequest,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> Response:
    require_collaborative_markdown_item(gateway, workspace_id, item_id, body.password)
    snapshot = b"".join(get_collaborative_update_store().load_updates(workspace_id, item_id))
    return Response(content=snapshot, media_type="application/octet-stream")


@app.websocket("/v1/workspaces/{workspace_id}/items/{item_id}/collab")
async def workspace_collab_relay(
    websocket: WebSocket,
    workspace_id: str,
    item_id: str,
    ticket: str,
) -> None:
    hub = get_collab_relay_hub()
    store = get_collaborative_update_store()
    if not await hub.validate_ticket(workspace_id, item_id, ticket):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    for update in store.load_updates(workspace_id, item_id):
        await websocket.send_bytes(update)
    await hub.register(workspace_id, item_id, websocket)
    try:
        while True:
            message = await websocket.receive()
            msg_type = message.get("type")
            if msg_type == "websocket.disconnect":
                break
            payload = message.get("bytes")
            if not isinstance(payload, (bytes, bytearray)):
                continue
            next_payload = bytes(payload)
            store.append_update(workspace_id, item_id, next_payload)
            await hub.broadcast(workspace_id, item_id, websocket, next_payload)
    except WebSocketDisconnect:
        pass
    finally:
        await hub.unregister(workspace_id, item_id, websocket)


@app.put("/v1/workspaces/{workspace_id}/profile", response_model=ProfileResponse)
def update_profile(
    workspace_id: str,
    body: ProfileUpdateRequest,
    request: Request,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> ProfileResponse:
    actor_user_id, _, _ = actor_from_body(body, request, workspace_id, "profile")
    record = require_workspace(gateway, workspace_id)
    target_user_id = actor_user_id or record.owner_user_id
    password = (body.password or "").strip()
    if password:
        state_payload = load_decrypted_state(record, password)
        member = upsert_workspace_member(state_payload, target_user_id, body.nickname)
        saved = save_state(
            gateway,
            record,
            state_payload,
            password,
            owner_nickname=body.nickname if target_user_id == record.owner_user_id else None,
            actor_user_id=actor_user_id,
        )
        return ProfileResponse(
            ok=True,
            profile=ProfileBody(
                user_id=target_user_id,
                nickname=member["nickname"],
                display_name=display_name(member["nickname"], target_user_id),
            ),
        )
    if target_user_id != record.owner_user_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="password required to update non-owner profile")
    saved = gateway.upsert_workspace(
        WorkspaceRecord(
            workspace_id=record.workspace_id,
            owner_user_id=record.owner_user_id,
            owner_nickname=body.nickname,
            encrypted_payload=record.encrypted_payload,
            updated_at=now_iso(),
        )
    )
    return ProfileResponse(
        ok=True,
        profile=ProfileBody(
            user_id=saved.owner_user_id,
            nickname=saved.owner_nickname,
            display_name=display_name(saved.owner_nickname, saved.owner_user_id),
        ),
    )


@app.post("/v1/workspaces/{workspace_id}/tree", response_model=WorkspaceTreeResponse)
def get_workspace_tree(
    workspace_id: str,
    body: WorkspacePasswordRequest,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceTreeResponse:
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    return WorkspaceTreeResponse(
        ok=True,
        workspace_id=workspace_id,
        workspace_title=get_workspace_title(state_payload, workspace_id),
        active_item_id=state_payload["activeDocId"],
        items=tree_items(state_payload),
    )


@app.put("/v1/workspaces/{workspace_id}/settings", response_model=WorkspaceSettingsResponse)
def update_workspace_settings(
    workspace_id: str,
    body: WorkspaceSettingsUpdateRequest,
    request: Request,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceSettingsResponse:
    actor_user_id, _, _ = actor_from_body(body, request, workspace_id, "settings")
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    title = update_workspace_title(state_payload, body.title, workspace_id)
    save_state(gateway, record, state_payload, body.password, actor_user_id=actor_user_id)
    return WorkspaceSettingsResponse(ok=True, workspace_id=workspace_id, title=title)


@app.post("/v1/workspaces/{workspace_id}/items/{item_id}", response_model=WorkspaceItemResponse)
def get_workspace_item(
    workspace_id: str,
    item_id: str,
    body: WorkspacePasswordRequest,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceItemResponse:
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    doc = find_doc(state_payload, item_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found")
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item_view(doc))


@app.post("/v1/workspaces/{workspace_id}/items/{item_id}/share", response_model=WorkspaceShareCreateResponse)
def create_workspace_item_share(
    workspace_id: str,
    item_id: str,
    _: None = Depends(require_backend_token),
) -> WorkspaceShareCreateResponse:
    # Ultra-fast path: sign and return link without decrypting workspace or DB roundtrips.
    # Validation (password + item existence + shareability) happens in share view endpoint.
    share_token = create_share_token(workspace_id, item_id)
    public_base = os.getenv("JUSTWORK_PUBLIC_BASE_URL", "http://127.0.0.1:1446").strip().rstrip("/")
    share_url = f"{public_base}/shares/{share_token}"
    return WorkspaceShareCreateResponse(
        ok=True,
        workspace_id=workspace_id,
        item_id=item_id,
        share_url=share_url,
    )


def _share_view_html(token: str) -> str:
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>JustWork Share</title>
  <style>
    body {{ margin:0; background:#fff; color:#262626; font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Arial,sans-serif; }}
    .wrap {{ max-width:860px; margin:36px auto; padding:0 18px; }}
    .card {{ border:1px solid #e5e5e5; border-radius:12px; padding:18px; }}
    .row {{ display:flex; gap:10px; align-items:center; margin-top:12px; }}
    input {{ flex:1; height:38px; border:1px solid #d4d4d4; border-radius:10px; padding:0 12px; font-size:14px; }}
    button {{ height:38px; border:1px solid #000; border-radius:10px; background:#000; color:#fff; padding:0 14px; font-size:14px; cursor:pointer; }}
    .muted {{ color:#737373; font-size:13px; }}
    .err {{ color:#8b0000; font-size:13px; margin-top:10px; }}
    .doc {{ margin-top:18px; border:1px solid #e5e5e5; border-radius:12px; padding:18px; white-space:pre-wrap; font-size:14px; line-height:1.6; }}
  </style>
</head>
<body>
  <div class="wrap">
    <h2>分享文档（只读）</h2>
    <p class="muted">请输入工作区密码查看该文档。该页面不会进入工作区，也不支持编辑。</p>
    <div class="card">
      <div class="row">
        <input id="pwd" type="password" placeholder="工作区密码" autocomplete="current-password" />
        <button id="btn">查看</button>
      </div>
      <div id="err" class="err"></div>
    </div>
    <div id="doc" class="doc" hidden data-share-token="{token}"></div>
  </div>
  <script src="/shares/static/view.js"></script>
</body>
</html>"""


@app.get("/shares/{token}", response_class=HTMLResponse)
def share_page(token: str) -> HTMLResponse:
    parse_share_token_or_raise(token)
    return HTMLResponse(_share_view_html(token))


@app.get("/shares/static/view.js")
def share_page_script() -> Response:
    js = """
const btn = document.getElementById('btn');
const pwd = document.getElementById('pwd');
const err = document.getElementById('err');
const doc = document.getElementById('doc');
const token = doc?.dataset?.shareToken || '';
btn?.addEventListener('click', async () => {
  if (!token) return;
  err.textContent = '';
  doc.hidden = true;
  try {
    const res = await fetch(`/v1/shares/${token}/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    doc.textContent = `# ${data.item.title}\\n\\n${data.item.markdown || ''}`;
    doc.hidden = false;
  } catch (e) {
    err.textContent = e?.message || '加载失败';
  }
});
""".strip()
    return Response(content=js, media_type="application/javascript")


@app.post("/v1/shares/{token}/view", response_model=ShareViewResponse)
def view_shared_doc(
    token: str,
    body: ShareViewRequest,
    gateway: DatabaseGateway = Depends(get_gateway),
) -> ShareViewResponse:
    workspace_id, item_id = parse_share_token_or_raise(token)
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    doc = find_doc(state_payload, item_id)
    if doc is None or doc.get("kind") == "folder":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="shared item not found")
    return ShareViewResponse(
        ok=True,
        workspace_id=workspace_id,
        item=item_view(doc),
    )


@app.post("/v1/workspaces/{workspace_id}/items", response_model=WorkspaceItemResponse)
def create_workspace_item(
    workspace_id: str,
    body: WorkspaceItemCreateRequest,
    request: Request,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceItemResponse:
    au, sg, sd = actor_from_body(body, request, workspace_id, "")
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    mutation_id = client_mutation_id_from_body(body)
    recorded_item = recorded_mutation_item(state_payload, mutation_id, operation="create", target_id="")
    if recorded_item is not None:
        return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=recorded_item)
    try:
        doc = create_doc(state_payload, body.kind, body.title, body.parent_id, body.client_item_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    item = item_view(doc)
    record_mutation_item(state_payload, mutation_id, operation="create", target_id="", item=item)
    save_state(gateway, record, state_payload, body.password, actor_user_id=au)
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item)


@app.put("/v1/workspaces/{workspace_id}/items/{item_id}", response_model=WorkspaceItemResponse)
def update_workspace_item(
    workspace_id: str,
    item_id: str,
    body: WorkspaceItemUpdateRequest,
    request: Request,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceItemResponse:
    au, sg, sd = actor_from_body(body, request, workspace_id, item_id)
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    mutation_id = client_mutation_id_from_body(body)
    recorded_item = recorded_mutation_item(state_payload, mutation_id, operation="update", target_id=item_id)
    if recorded_item is not None:
        return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=recorded_item)
    try:
        cur = require_expected_revision(state_payload, item_id, body.expected_revision)
        before_doc = dict(cur)
        doc = update_doc(state_payload, item_id, body.title, body.markdown, body.content)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    item = item_view(doc)
    record_mutation_item(state_payload, mutation_id, operation="update", target_id=item_id, item=item)
    save_state(gateway, record, state_payload, body.password, actor_user_id=au)
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item)


@app.put("/v1/workspaces/{workspace_id}/items/{item_id}/pin", response_model=WorkspaceItemResponse)
def pin_workspace_item(
    workspace_id: str,
    item_id: str,
    body: WorkspaceItemPinRequest,
    request: Request,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceItemResponse:
    au, sg, sd = actor_from_body(body, request, workspace_id, item_id)
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    mutation_id = client_mutation_id_from_body(body)
    recorded_item = recorded_mutation_item(state_payload, mutation_id, operation="pin", target_id=item_id)
    if recorded_item is not None:
        return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=recorded_item)
    try:
        before_doc = dict(require_expected_revision(state_payload, item_id, body.expected_revision))
        doc = set_doc_pin(state_payload, item_id, body.pinned)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    item = item_view(doc)
    record_mutation_item(state_payload, mutation_id, operation="pin", target_id=item_id, item=item)
    save_state(gateway, record, state_payload, body.password, actor_user_id=au)
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item)


@app.put("/v1/workspaces/{workspace_id}/items/{item_id}/move", response_model=WorkspaceItemResponse)
def move_workspace_item(
    workspace_id: str,
    item_id: str,
    body: WorkspaceItemMoveRequest,
    request: Request,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceItemResponse:
    au, sg, sd = actor_from_body(body, request, workspace_id, item_id)
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    mutation_id = client_mutation_id_from_body(body)
    recorded_item = recorded_mutation_item(state_payload, mutation_id, operation="move", target_id=item_id)
    if recorded_item is not None:
        return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=recorded_item)
    try:
        before_doc = dict(require_expected_revision(state_payload, item_id, body.expected_revision))
        doc = move_doc(state_payload, item_id, body.parent_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    item = item_view(doc)
    record_mutation_item(state_payload, mutation_id, operation="move", target_id=item_id, item=item)
    save_state(gateway, record, state_payload, body.password, actor_user_id=au)
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item)


@app.put("/v1/workspaces/{workspace_id}/items/{item_id}/trash", response_model=WorkspaceItemResponse)
def trash_workspace_item(
    workspace_id: str,
    item_id: str,
    body: WorkspacePasswordRequest,
    request: Request,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceItemResponse:
    au, sg, sd = actor_from_body(body, request, workspace_id, item_id)
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    mutation_id = client_mutation_id_from_body(body)
    recorded_item = recorded_mutation_item(state_payload, mutation_id, operation="trash", target_id=item_id)
    if recorded_item is not None:
        return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=recorded_item)
    try:
        before_doc = dict(require_expected_revision(state_payload, item_id, body.expected_revision))
        doc = trash_doc(state_payload, item_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    item = item_view(doc)
    record_mutation_item(state_payload, mutation_id, operation="trash", target_id=item_id, item=item)
    save_state(gateway, record, state_payload, body.password, actor_user_id=au)
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item)


@app.put("/v1/workspaces/{workspace_id}/items/{item_id}/restore", response_model=WorkspaceItemResponse)
def restore_workspace_item(
    workspace_id: str,
    item_id: str,
    body: WorkspacePasswordRequest,
    request: Request,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceItemResponse:
    au, sg, sd = actor_from_body(body, request, workspace_id, item_id)
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    mutation_id = client_mutation_id_from_body(body)
    recorded_item = recorded_mutation_item(state_payload, mutation_id, operation="restore", target_id=item_id)
    if recorded_item is not None:
        return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=recorded_item)
    try:
        before_doc = dict(require_expected_revision(state_payload, item_id, body.expected_revision))
        doc = restore_doc(state_payload, item_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    item = item_view(doc)
    record_mutation_item(state_payload, mutation_id, operation="restore", target_id=item_id, item=item)
    save_state(gateway, record, state_payload, body.password, actor_user_id=au)
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item)


@app.post("/v1/workspaces/{workspace_id}/items/{item_id}/hard-delete", response_model=WorkspaceItemResponse)
def hard_delete_workspace_item(
    workspace_id: str,
    item_id: str,
    body: WorkspacePasswordRequest,
    request: Request,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceItemResponse:
    au, sg, sd = actor_from_body(body, request, workspace_id, item_id)
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    mutation_id = client_mutation_id_from_body(body)
    recorded_item = recorded_mutation_item(state_payload, mutation_id, operation="hard-delete", target_id=item_id)
    if recorded_item is not None:
        return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=recorded_item)
    try:
        before_doc = dict(require_expected_revision(state_payload, item_id, body.expected_revision))
        doc = hard_delete_doc(state_payload, item_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    item = item_view(doc)
    record_mutation_item(state_payload, mutation_id, operation="hard-delete", target_id=item_id, item=item)
    get_collab_relay_hub().delete_snapshot(workspace_id, item_id)
    save_state(gateway, record, state_payload, body.password, actor_user_id=au)
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item)


@app.post("/v1/workspaces/{workspace_id}/search", response_model=WorkspaceSearchResponse)
def search_workspace(
    workspace_id: str,
    body: WorkspaceSearchRequest,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceSearchResponse:
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    return WorkspaceSearchResponse(
        ok=True,
        workspace_id=workspace_id,
        results=search_docs(state_payload, body.query),
    )


@app.post("/v1/workspaces/{workspace_id}/items/{item_id}/outline", response_model=WorkspaceOutlineResponse)
def get_workspace_item_outline(
    workspace_id: str,
    item_id: str,
    body: WorkspacePasswordRequest,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceOutlineResponse:
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    doc = find_doc(state_payload, item_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found")
    return WorkspaceOutlineResponse(
        ok=True,
        workspace_id=workspace_id,
        item_id=item_id,
        headings=outline(doc.get("markdown", "")),
    )


@app.post("/v1/workspaces/{workspace_id}/items/{item_id}/patch", response_model=WorkspacePatchResponse)
def patch_workspace_item(
    workspace_id: str,
    item_id: str,
    body: WorkspacePatchRequest,
    request: Request,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspacePatchResponse:
    au, sg, sd = actor_from_body(body, request, workspace_id, item_id)
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    mutation_id = client_mutation_id_from_body(body)
    recorded_entry = recorded_mutation_entry(state_payload, mutation_id, operation="patch", target_id=item_id)
    if recorded_entry is not None:
        return WorkspacePatchResponse(
            ok=True,
            workspace_id=workspace_id,
            item=recorded_entry["item"],
            changed=bool(recorded_entry.get("changed", False)),
            preview_markdown=str(recorded_entry.get("previewMarkdown", "")),
        )
    try:
        require_expected_revision(state_payload, item_id, body.expected_revision)
        doc, changed, preview = patch_doc(
            state_payload,
            item_id,
            body.find,
            body.replace,
            body.dry_run,
            actor_user_id=au,
            signed=sg,
            signature_digest=sd,
        )
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    item = item_view(doc)
    if not body.dry_run and changed:
        record_patch_mutation(
            state_payload,
            mutation_id,
            target_id=item_id,
            item=item,
            changed=changed,
            preview_markdown=preview,
        )
        save_state(gateway, record, state_payload, body.password, actor_user_id=au)
    return WorkspacePatchResponse(
        ok=True,
        workspace_id=workspace_id,
        item=item,
        changed=changed,
        preview_markdown=preview,
    )
@app.get("/v1/workspaces/{workspace_id}", response_model=WorkspaceGetResponse)
def get_workspace(
    workspace_id: str,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceGetResponse:
    workspace = gateway.get_workspace(workspace_id)
    return WorkspaceGetResponse(ok=True, workspace=workspace)


@app.put("/v1/workspaces/{workspace_id}", response_model=WorkspaceGetResponse)
def upsert_workspace(
    workspace_id: str,
    body: WorkspaceUpsertRequest,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceGetResponse:
    record = WorkspaceRecord(
        workspace_id=workspace_id,
        owner_user_id=body.owner_user_id,
        owner_nickname=body.owner_nickname,
        encrypted_payload=body.encrypted_payload,
        updated_at=body.updated_at,
    )
    saved = gateway.upsert_workspace(record)
    return WorkspaceGetResponse(ok=True, workspace=saved)
