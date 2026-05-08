import os
import json
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
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from .db_gateway import DatabaseGateway
from .models import (
    ErrorBody,
    ErrorResponse,
    HealthResponse,
    ProfileBody,
    ProfileResponse,
    WorkspaceQuotaBody,
    WorkspaceQuotaResponse,
    ProfileUpdateRequest,
    WorkspaceRelayJoinRequest,
    WorkspaceRelayJoinResponse,
    WorkspaceHistoryResponse,
    WorkspaceCreateRequest,
    WorkspaceCreateResponse,
    WorkspaceGetResponse,
    WorkspaceItemCreateRequest,
    WorkspaceItemPinRequest,
    WorkspaceItemResponse,
    WorkspaceItemMoveRequest,
    WorkspaceItemUpdateRequest,
    WorkspaceOutlineResponse,
    WorkspacePatchRequest,
    WorkspacePatchResponse,
    WorkspacePasswordRequest,
    WorkspaceRecord,
    WorkspaceSearchRequest,
    WorkspaceSearchResponse,
    WorkspaceSummary,
    WorkspaceTreeResponse,
    WorkspaceUpsertRequest,
)
from .image_relay import get_image_relay_hub, parse_relay_payload, reset_image_relay_for_tests as reset_image_relay_hub_for_tests
from .write_signing import verify_signed_write_body
from .workspace_crypto import InvalidWorkspacePassword, decrypt_workspace_payload, encrypt_workspace_payload
from .workspace_runtime import (
    create_doc,
    display_name,
    find_doc,
    hard_delete_doc,
    item_view,
    make_initial_workspace_state,
    make_workspace_id,
    choose_active_item_id,
    move_doc,
    now_iso,
    outline,
    patch_doc,
    record_history,
    revert_history_event,
    restore_doc,
    search_docs,
    set_doc_pin,
    trash_doc,
    tree_items,
    update_doc,
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
            "history_max_events": max(50, _int_env("JUSTWORK_QUOTA_HISTORY_MAX_EVENTS_PRO", 1_500)),
        }
    return {
        "workspace_max_bytes": max(1024, _int_env("JUSTWORK_QUOTA_WORKSPACE_MAX_BYTES_FREE", 41_943_040)),
        "page_max_count": max(1, _int_env("JUSTWORK_QUOTA_PAGE_MAX_COUNT_FREE", 300)),
        "folder_max_count": max(1, _int_env("JUSTWORK_QUOTA_FOLDER_MAX_COUNT_FREE", 100)),
        "history_max_events": max(50, _int_env("JUSTWORK_QUOTA_HISTORY_MAX_EVENTS_FREE", 300)),
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

    history = state_payload.get("history")
    if isinstance(history, list):
        max_events = limits["history_max_events"]
        if len(history) > max_events:
            del history[max_events:]

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
        elif exc.detail == "page count exceeded":
            code = "page_count_exceeded"
        elif exc.detail == "folder count exceeded":
            code = "folder_count_exceeded"
        else:
            code = "conflict"
    payload = ErrorResponse(error=ErrorBody(code=code, message=str(exc.detail))).model_dump()
    return JSONResponse(status_code=exc.status_code, content=payload)


@app.get("/v1/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse()


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
        return decrypt_workspace_payload(record.encrypted_payload, password)
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


def require_workspace(gateway: DatabaseGateway, workspace_id: str) -> WorkspaceRecord:
    workspace = gateway.get_workspace(workspace_id)
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="workspace not found")
    return workspace


def save_state(
    gateway: DatabaseGateway,
    record: WorkspaceRecord,
    state_payload: dict,
    password: str,
) -> WorkspaceRecord:
    apply_workspace_quotas_or_raise(state_payload, _quota_plan_for_workspace(record))
    next_record = WorkspaceRecord(
        workspace_id=record.workspace_id,
        owner_user_id=record.owner_user_id,
        owner_nickname=record.owner_nickname,
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
    default_title = f"work_{workspace_id[-4:]}"
    workspace_title = raw_title or default_title
    state_payload = make_initial_workspace_state(workspace_title)
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
    saved = gateway.upsert_workspace(record)
    return WorkspaceCreateResponse(
        ok=True,
        workspace=summarize_workspace(saved),
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
            if parsed.get("type") == "asset.manifest":
                meta = parsed.get("meta")
                if isinstance(meta, dict) and meta.get("workspaceId") != workspace_id:
                    continue
            if parsed.get("type") == "relay.leave":
                await hub.broadcast(workspace_id, websocket, parsed)
                break
            await hub.broadcast(workspace_id, websocket, parsed)
    except WebSocketDisconnect:
        pass
    finally:
        await hub.unregister(workspace_id, websocket)


@app.put("/v1/workspaces/{workspace_id}/profile", response_model=ProfileResponse)
def update_profile(
    workspace_id: str,
    body: ProfileUpdateRequest,
    request: Request,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> ProfileResponse:
    actor_from_body(body, request, workspace_id, "profile")
    record = require_workspace(gateway, workspace_id)
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
        active_item_id=state_payload["activeDocId"],
        items=tree_items(state_payload),
    )


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
    try:
        doc = create_doc(state_payload, body.kind, body.title, body.parent_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    record_history(
        state_payload,
        "workspace.item.create",
        {},
        doc,
        actor_user_id=au,
        signed=sg,
        signature_digest=sd,
    )
    save_state(gateway, record, state_payload, body.password)
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item_view(doc))


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
    try:
        cur = find_doc(state_payload, item_id)
        if cur is None:
            raise KeyError(item_id)
        if body.expected_revision is not None and int(cur.get("revision", 0)) != body.expected_revision:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="revision conflict")
        before_doc = dict(cur)
        doc = update_doc(state_payload, item_id, body.title, body.markdown)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    record_history(
        state_payload,
        "workspace.item.set",
        before_doc,
        doc,
        actor_user_id=au,
        signed=sg,
        signature_digest=sd,
    )
    save_state(gateway, record, state_payload, body.password)
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item_view(doc))


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
    try:
        before_doc = dict(find_doc(state_payload, item_id) or {})
        doc = set_doc_pin(state_payload, item_id, body.pinned)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    record_history(
        state_payload,
        "workspace.item.pin",
        before_doc,
        doc,
        actor_user_id=au,
        signed=sg,
        signature_digest=sd,
    )
    save_state(gateway, record, state_payload, body.password)
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item_view(doc))


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
    try:
        before_doc = dict(find_doc(state_payload, item_id) or {})
        doc = move_doc(state_payload, item_id, body.parent_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    record_history(
        state_payload,
        "workspace.item.move",
        before_doc,
        doc,
        actor_user_id=au,
        signed=sg,
        signature_digest=sd,
    )
    save_state(gateway, record, state_payload, body.password)
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item_view(doc))


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
    try:
        before_doc = dict(find_doc(state_payload, item_id) or {})
        doc = trash_doc(state_payload, item_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    record_history(
        state_payload,
        "workspace.item.trash",
        before_doc,
        doc,
        actor_user_id=au,
        signed=sg,
        signature_digest=sd,
    )
    save_state(gateway, record, state_payload, body.password)
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item_view(doc))


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
    try:
        before_doc = dict(find_doc(state_payload, item_id) or {})
        doc = restore_doc(state_payload, item_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    record_history(
        state_payload,
        "workspace.item.restore",
        before_doc,
        doc,
        actor_user_id=au,
        signed=sg,
        signature_digest=sd,
    )
    save_state(gateway, record, state_payload, body.password)
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item_view(doc))


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
    try:
        before_doc = dict(find_doc(state_payload, item_id) or {})
        doc = hard_delete_doc(state_payload, item_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    record_history(
        state_payload,
        "workspace.item.hard_delete",
        before_doc,
        doc,
        actor_user_id=au,
        signed=sg,
        signature_digest=sd,
    )
    save_state(gateway, record, state_payload, body.password)
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item_view(doc))


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
    try:
        cur = find_doc(state_payload, item_id)
        if cur is None:
            raise KeyError(item_id)
        if body.expected_revision is not None and int(cur.get("revision", 0)) != body.expected_revision:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="revision conflict")
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
    if not body.dry_run and changed:
        save_state(gateway, record, state_payload, body.password)
    return WorkspacePatchResponse(
        ok=True,
        workspace_id=workspace_id,
        item=item_view(doc),
        changed=changed,
        preview_markdown=preview,
    )


@app.post("/v1/workspaces/{workspace_id}/history", response_model=WorkspaceHistoryResponse)
def list_workspace_history(
    workspace_id: str,
    body: WorkspacePasswordRequest,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceHistoryResponse:
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    return WorkspaceHistoryResponse(
        ok=True,
        workspace_id=workspace_id,
        events=state_payload.get("history", []),
    )


@app.post("/v1/workspaces/{workspace_id}/history/{event_id}/revert", response_model=WorkspaceItemResponse)
def revert_workspace_history(
    workspace_id: str,
    event_id: str,
    body: WorkspacePasswordRequest,
    request: Request,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceItemResponse:
    au, sg, sd = actor_from_body(body, request, workspace_id, event_id)
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    try:
        doc = revert_history_event(
            state_payload,
            event_id,
            actor_user_id=au,
            signed=sg,
            signature_digest=sd,
        )
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="history event not found") from exc
    save_state(gateway, record, state_payload, body.password)
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item_view(doc))


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
