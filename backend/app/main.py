import os
import asyncio
import copy
import json
import time
import base64
import hmac
import hashlib
import secrets
from collections.abc import Callable
from functools import partial
from pathlib import Path
from threading import Lock
from anyio import from_thread, to_thread as anyio_to_thread

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
from diff_match_patch import diff_match_patch

from .db_gateway import DatabaseGateway, DatabaseUnavailableError
from .billing import BillingConfigurationError, BillingProviderError, StripeBillingService
from .database_routing import (
    DatabaseRoutingConfigurationError,
    encrypt_database_url,
    validate_custom_database_url,
)
from .collab_relay import (
    get_collaborative_relay_hub as get_collab_relay_hub,
    reset_collaborative_relay_for_tests as reset_collaborative_relay_hub_for_tests,
)
from .collab_store import (
    CollaborativeRoomCorruptError,
    CollaborativeRoomTransientError,
    configure_collaborative_gateway_provider,
    get_collaborative_update_store,
    reset_collab_store_for_tests,
)
from .models import (
    ErrorBody,
    ErrorResponse,
    HealthResponse,
    ProfileBody,
    PaidCheckoutRecord,
    PaidWorkspaceBillingConfigResponse,
    PaidWorkspaceCheckoutRequest,
    PaidWorkspaceCheckoutResponse,
    PaidWorkspaceCheckoutStatusResponse,
    PaidWorkspaceCompleteRequest,
    WorkspaceMemberBody,
    WorkspaceMembersResponse,
    ProfileResponse,
    WorkspaceQuotaBody,
    WorkspaceQuotaResponse,
    ProfileUpdateRequest,
    WorkspaceCollabJoinRequest,
    WorkspaceCollabJoinResponse,
    WorkspaceCollabStateResponse,
    WorkspaceRelayJoinRequest,
    WorkspaceRelayJoinResponse,
    WorkspaceRevisionHistoryResponse,
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
    WorkspacePasswordChangeRequest,
    WorkspacePasswordChangeResponse,
    WorkspacePasswordRequest,
    WorkspaceRevisionMutationRequest,
    WorkspaceRecord,
    WorkspaceSearchRequest,
    WorkspaceSearchResponse,
    WorkspaceSettingsResponse,
    WorkspaceSettingsUpdateRequest,
    WorkspaceSummary,
    WorkspaceTreeResponse,
    WorkspaceUpsertRequest,
    WorkspaceRouteRecord,
)
from .image_assets import get_image_asset_archive, reset_image_asset_archive_for_tests as reset_image_asset_archive_hub_for_tests
from .image_relay import get_image_relay_hub, parse_relay_payload, reset_image_relay_for_tests as reset_image_relay_hub_for_tests
from .write_signing import verify_signed_write_body
from .workspace_crypto import (
    InvalidWorkspacePassword,
    cached_workspace_collaboration_key,
    decrypt_workspace_payload,
    encrypt_workspace_payload,
    invalidate_cached_workspace_collaboration_key,
)
from .revision_history import append_workspace_revision, list_workspace_revisions
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
    normalize_workspace_members,
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
_billing_service: StripeBillingService | None = None
_paid_completion_lock = Lock()
_backend_token = os.getenv("JUSTWORK_BACKEND_TOKEN", "").strip()

QUOTA_PLAN_FREE = "free"
QUOTA_PLAN_PAID = "paid"
QUOTA_PLAN_CUSTOM_DATABASE = "paid_custom_database"
MAX_WORKSPACES_PER_OWNER = 5
AGENT_SKILL_PATH = Path(__file__).resolve().parent.parent / "agent" / "SKILL.md"
SYNC_MUTATION_LOG_KEY = "__syncMutations"
MAX_SYNC_MUTATION_LOG_ENTRIES = 1000
WORKSPACE_EVENT_POLL_MIN_SECONDS = 0.2
WORKSPACE_EVENT_POLL_MAX_SECONDS = 3.0
COLLAB_EVENT_POLL_MIN_SECONDS = 0.15
COLLAB_EVENT_POLL_MAX_SECONDS = 2.0


def _next_event_poll_delay(current: float, had_events: bool, minimum: float, maximum: float) -> float:
    """Poll quickly under activity and exponentially back off while idle."""
    if had_events:
        return minimum
    return min(maximum, max(minimum, current * 2))


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _int_env_with_legacy(primary_name: str, legacy_name: str, default: int) -> int:
    if os.getenv(primary_name, "").strip():
        return _int_env(primary_name, default)
    return _int_env(legacy_name, default)


def _quota_plan_for_workspace(record: WorkspaceRecord | None = None) -> str:
    if record is not None and record.plan == QUOTA_PLAN_PAID and record.billing_status in {
        "paid",
        "active",
        "trialing",
    }:
        if record.custom_database:
            return QUOTA_PLAN_CUSTOM_DATABASE
        return QUOTA_PLAN_PAID
    raw = os.getenv("JUSTWORK_QUOTA_PLAN", QUOTA_PLAN_FREE).strip().lower()
    return QUOTA_PLAN_PAID if raw in {"paid", "pro"} else QUOTA_PLAN_FREE


def _quota_limits(plan: str) -> dict[str, int]:
    if plan == QUOTA_PLAN_CUSTOM_DATABASE:
        return {
            "workspace_max_bytes": 0,
            "page_max_count": 0,
            "folder_max_count": 0,
        }
    free_workspace_bytes = max(1024, _int_env("JUSTWORK_QUOTA_WORKSPACE_MAX_BYTES_FREE", 41_943_040))
    if plan == QUOTA_PLAN_PAID:
        return {
            "workspace_max_bytes": max(
                free_workspace_bytes * 4,
                _int_env_with_legacy(
                    "JUSTWORK_QUOTA_WORKSPACE_MAX_BYTES_PAID",
                    "JUSTWORK_QUOTA_WORKSPACE_MAX_BYTES_PRO",
                    free_workspace_bytes * 4,
                ),
            ),
            "page_max_count": max(
                1,
                _int_env_with_legacy(
                    "JUSTWORK_QUOTA_PAGE_MAX_COUNT_PAID",
                    "JUSTWORK_QUOTA_PAGE_MAX_COUNT_PRO",
                    1_500,
                ),
            ),
            "folder_max_count": max(
                1,
                _int_env_with_legacy(
                    "JUSTWORK_QUOTA_FOLDER_MAX_COUNT_PAID",
                    "JUSTWORK_QUOTA_FOLDER_MAX_COUNT_PRO",
                    500,
                ),
            ),
        }
    return {
        "workspace_max_bytes": free_workspace_bytes,
        "page_max_count": max(1, _int_env("JUSTWORK_QUOTA_PAGE_MAX_COUNT_FREE", 300)),
        "folder_max_count": max(1, _int_env("JUSTWORK_QUOTA_FOLDER_MAX_COUNT_FREE", 100)),
    }


def _history_limit_for_plan(plan: str) -> int:
    if plan in {QUOTA_PLAN_PAID, QUOTA_PLAN_CUSTOM_DATABASE}:
        # Paid workspaces guarantee exactly the supported 1000-event history.
        return 1_000
    return max(1, min(1_000, _int_env("JUSTWORK_QUOTA_HISTORY_MAX_EVENTS_FREE", 200)))


def _state_payload_size_bytes(state_payload: dict) -> int:
    return len(json.dumps(state_payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def get_workspace_quota_snapshot(record: WorkspaceRecord) -> WorkspaceQuotaBody:
    plan = _quota_plan_for_workspace(record)
    used_bytes = len(record.encrypted_payload.encode("utf-8"))
    if plan == QUOTA_PLAN_CUSTOM_DATABASE:
        return WorkspaceQuotaBody(
            plan=plan,
            used_bytes=used_bytes,
            limit_bytes=0,
            usage_ratio=0,
            unlimited=True,
        )
    limits = _quota_limits(plan)
    limit_bytes = limits["workspace_max_bytes"]
    usage_ratio = 1.0 if limit_bytes <= 0 else min(1.0, used_bytes / limit_bytes)
    return WorkspaceQuotaBody(
        plan=plan,
        used_bytes=used_bytes,
        limit_bytes=limit_bytes,
        usage_ratio=usage_ratio,
    )


def apply_workspace_quotas_or_raise(state_payload: dict, plan: str) -> None:
    if plan == QUOTA_PLAN_CUSTOM_DATABASE:
        return
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


configure_collaborative_gateway_provider(get_gateway)


def get_billing_service() -> StripeBillingService:
    global _billing_service
    if _billing_service is None:
        _billing_service = StripeBillingService()
    return _billing_service


def reset_gateway_for_tests() -> None:
    global _gateway, _billing_service
    _gateway = None
    _billing_service = None


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


def _broadcast_collaborative_update_from_http(workspace_id: str, item_id: str, update: bytes) -> None:
    """Publish a committed REST/Agent edit to currently connected page clients."""
    try:
        from_thread.run(get_collab_relay_hub().broadcast, workspace_id, item_id, None, update)
    except RuntimeError:
        # Endpoint handlers normally run in an AnyIO worker thread. Keeping this
        # fallback makes direct function calls in tests/tools non-fatal after the
        # durable workspace and room snapshots have already committed.
        pass


def _broadcast_workspace_invalidation(workspace_id: str, updated_at: str) -> None:
    """Wake connected workbenches after any committed workspace mutation."""
    try:
        from_thread.run(
            get_image_relay_hub().broadcast,
            workspace_id,
            None,
            {
                "type": "workspace.invalidated",
                "workspaceId": workspace_id,
                "updatedAt": updated_at,
            },
        )
    except RuntimeError:
        pass


def _disconnect_workspace_realtime_clients(workspace_id: str) -> None:
    """Invalidate in-process sockets after a password/member boundary change."""
    try:
        from_thread.run(get_collab_relay_hub().disconnect_workspace, workspace_id, 4403)
        from_thread.run(get_image_relay_hub().disconnect_workspace, workspace_id, 4403)
    except RuntimeError:
        # Direct unit calls do not always run inside an AnyIO worker thread.
        pass


def _disconnect_collaborative_item_clients(workspace_id: str, item_id: str) -> None:
    """Force clients to rejoin after an authoritative structured rollback."""
    try:
        from_thread.run(get_collab_relay_hub().disconnect_item, workspace_id, item_id, 4409)
    except RuntimeError:
        # Direct unit calls do not always run inside an AnyIO worker thread.
        pass


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
    elif exc.status_code == status.HTTP_403_FORBIDDEN and exc.detail == "workspace owner required":
        code = "workspace_owner_required"
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


@app.exception_handler(CollaborativeRoomCorruptError)
async def collab_room_corrupt_exception_handler(
    _: Request, exc: CollaborativeRoomCorruptError
) -> JSONResponse:
    payload = ErrorResponse(
        error=ErrorBody(code="collaborative_room_corrupt", message=str(exc)),
    ).model_dump()
    return JSONResponse(status_code=status.HTTP_409_CONFLICT, content=payload)


@app.exception_handler(CollaborativeRoomTransientError)
async def collab_room_transient_exception_handler(
    _: Request, exc: CollaborativeRoomTransientError
) -> JSONResponse:
    payload = ErrorResponse(
        error=ErrorBody(code="collaborative_room_transient", message=str(exc)),
    ).model_dump()
    return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content=payload)


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
        plan=record.plan,
        billing_status=record.billing_status,
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
    if expected_revision is None:
        raise HTTPException(status_code=status.HTTP_428_PRECONDITION_REQUIRED, detail="expected_revision is required")
    if int(doc.get("revision", 0)) != expected_revision:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="revision conflict")
    return doc


def require_workspace(gateway: DatabaseGateway, workspace_id: str) -> WorkspaceRecord:
    workspace = gateway.get_workspace(workspace_id)
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="workspace not found")
    return workspace


def require_collaborative_item(
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
    if doc.get("kind") not in {"page", "table", "board"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="real-time collaboration requires a page, table, or board",
        )
    return record, state_payload, doc


def save_state(
    gateway: DatabaseGateway,
    record: WorkspaceRecord,
    state_payload: dict,
    password: str,
    *,
    owner_nickname: str | None = None,
    actor_user_id: str | None = None,
    deferred_notifications: list[Callable[[], None]] | None = None,
    enforce_quotas: bool = True,
) -> WorkspaceRecord:
    next_owner_nickname = record.owner_nickname if owner_nickname is None else owner_nickname
    ensure_workspace_members(state_payload, record.owner_user_id, next_owner_nickname)
    actor = (actor_user_id or "").strip()
    members_before = state_payload.get("members") if isinstance(state_payload.get("members"), dict) else {}
    actor_before = dict(members_before.get(actor, {})) if actor and isinstance(members_before.get(actor), dict) else None
    actor_member_changed = ensure_actor_workspace_member(state_payload, record.owner_user_id, actor_user_id)
    if actor_member_changed and actor and actor_before is None:
        actor_after = dict(state_payload.get("members", {}).get(actor, {}))
        append_workspace_revision(
            state_payload,
            operation="member-join",
            item_id=actor,
            title=str(actor_after.get("nickname", actor)),
            before={},
            after=actor_after,
            actor_user_id=actor,
        )
    if enforce_quotas:
        apply_workspace_quotas_or_raise(state_payload, _quota_plan_for_workspace(record))
    next_record = WorkspaceRecord(
        workspace_id=record.workspace_id,
        owner_user_id=record.owner_user_id,
        owner_nickname=next_owner_nickname,
        encrypted_payload=encrypt_workspace_payload(record.workspace_id, state_payload, password),
        updated_at=now_iso(),
        plan=record.plan,
        billing_status=record.billing_status,
        stripe_customer_id=record.stripe_customer_id,
        stripe_subscription_id=record.stripe_subscription_id,
        custom_database=record.custom_database,
    )
    saved = gateway.compare_and_swap_workspace(next_record, record.encrypted_payload)
    if saved is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="workspace write conflict")
    gateway.publish_workspace_event(
        record.workspace_id,
        "workspace.invalidated",
        {
            "type": "workspace.invalidated",
            "workspaceId": record.workspace_id,
            "updatedAt": saved.updated_at,
        },
    )
    notify = lambda: _broadcast_workspace_invalidation(record.workspace_id, saved.updated_at)
    if not gateway.defer_until_after_commit(notify, record.workspace_id):
        if deferred_notifications is not None:
            deferred_notifications.append(notify)
        else:
            notify()
    return saved


def _workspace_create_response(record: WorkspaceRecord, state_payload: dict) -> WorkspaceCreateResponse:
    return WorkspaceCreateResponse(
        ok=True,
        workspace=summarize_workspace(record),
        workspace_title=get_workspace_title(state_payload, record.workspace_id),
        workspace_revision=int(state_payload.get("workspaceRevision", 0)),
        active_item_id=choose_active_item_id(state_payload),
        items=tree_items(state_payload),
    )


def _stripe_object_id(value: object) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, dict) and isinstance(value.get("id"), str):
        return value["id"]
    return None


def _sync_paid_checkout(
    gateway: DatabaseGateway,
    billing: StripeBillingService,
    checkout_session_id: str,
) -> tuple[PaidCheckoutRecord, dict]:
    checkout = gateway.get_paid_checkout(checkout_session_id)
    if checkout is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="paid checkout not found")
    try:
        session = billing.retrieve_checkout(checkout_session_id)
    except BillingConfigurationError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    except BillingProviderError as exc:
        if checkout.status == "paid":
            return checkout, {}
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    metadata = session.get("metadata") if isinstance(session.get("metadata"), dict) else {}
    if (
        session.get("id") != checkout.checkout_session_id
        or session.get("client_reference_id") != checkout.owner_user_id
        or metadata.get("intent") != "paid_workspace"
        or metadata.get("purchase_token") != checkout.purchase_token
    ):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Stripe checkout metadata mismatch")
    next_status = "paid" if billing.checkout_is_paid(session) else str(session.get("status", "pending"))
    updated = checkout.model_copy(
        update={
            "status": next_status,
            "stripe_customer_id": _stripe_object_id(session.get("customer")) or checkout.stripe_customer_id,
            "stripe_subscription_id": _stripe_object_id(session.get("subscription")) or checkout.stripe_subscription_id,
            "updated_at": now_iso(),
        }
    )
    gateway.save_paid_checkout(updated)
    return updated, session


@app.get("/v1/billing/paid-workspace/config", response_model=PaidWorkspaceBillingConfigResponse)
def paid_workspace_billing_config(
    _: None = Depends(require_backend_token),
) -> PaidWorkspaceBillingConfigResponse:
    config = get_billing_service().config()
    routing_secret = os.getenv("JUSTWORK_DATABASE_ROUTING_SECRET", "").strip()
    return PaidWorkspaceBillingConfigResponse(
        enabled=config.enabled,
        checkout_mode=config.checkout_mode,
        price_label=config.price_label,
        history_limit=_history_limit_for_plan(QUOTA_PLAN_PAID),
        custom_database_enabled=len(routing_secret) >= 32,
    )


@app.post("/v1/billing/paid-workspace/checkout", response_model=PaidWorkspaceCheckoutResponse)
def create_paid_workspace_checkout(
    body: PaidWorkspaceCheckoutRequest,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> PaidWorkspaceCheckoutResponse:
    purchase_token = secrets.token_urlsafe(24)
    billing = get_billing_service()
    try:
        session = billing.create_paid_workspace_checkout(body.owner_user_id, purchase_token)
    except BillingConfigurationError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    except BillingProviderError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    session_id = str(session.get("id", "")).strip()
    checkout_url = str(session.get("url", "")).strip()
    if not session_id or not checkout_url:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Stripe did not return a checkout URL")
    created_at = now_iso()
    gateway.save_paid_checkout(
        PaidCheckoutRecord(
            purchase_token=purchase_token,
            owner_user_id=body.owner_user_id,
            checkout_session_id=session_id,
            status="pending",
            created_at=created_at,
            updated_at=created_at,
        )
    )
    return PaidWorkspaceCheckoutResponse(checkout_session_id=session_id, checkout_url=checkout_url)


@app.get(
    "/v1/billing/paid-workspace/checkout/{checkout_session_id}",
    response_model=PaidWorkspaceCheckoutStatusResponse,
)
def get_paid_workspace_checkout_status(
    checkout_session_id: str,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> PaidWorkspaceCheckoutStatusResponse:
    checkout, _ = _sync_paid_checkout(gateway, get_billing_service(), checkout_session_id)
    return PaidWorkspaceCheckoutStatusResponse(
        checkout_session_id=checkout_session_id,
        status=checkout.status,
        paid=checkout.status == "paid",
    )


@app.post("/v1/workspaces/paid/complete", response_model=WorkspaceCreateResponse)
def complete_paid_workspace(
    body: PaidWorkspaceCompleteRequest,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceCreateResponse:
    with _paid_completion_lock:
        checkout, _ = _sync_paid_checkout(gateway, get_billing_service(), body.checkout_session_id)
        if checkout.owner_user_id != body.owner_user_id or checkout.status != "paid":
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="paid checkout is not complete")
        candidate_workspace_id = checkout.consumed_workspace_id or make_workspace_id()
        try:
            claimed = gateway.claim_paid_checkout(
                body.checkout_session_id,
                body.owner_user_id,
                candidate_workspace_id,
                now_iso(),
            )
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
        workspace_id = claimed.consumed_workspace_id or candidate_workspace_id
        existing = gateway.get_workspace(workspace_id)
        if existing is not None:
            state_payload = load_decrypted_state(existing, body.password)
            return _workspace_create_response(existing, state_payload)

        database_url_ciphertext: str | None = None
        if body.custom_database_url and body.custom_database_url.strip():
            try:
                custom_database_url = validate_custom_database_url(body.custom_database_url)
                database_url_ciphertext = encrypt_database_url(custom_database_url)
            except ValueError as exc:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
            except DatabaseRoutingConfigurationError as exc:
                raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc

        workspace_title = (body.title or "").strip() or default_workspace_title(workspace_id)
        state_payload = make_initial_workspace_state(workspace_title)
        state_payload["billingPlan"] = QUOTA_PLAN_PAID
        state_payload["historyLimit"] = _history_limit_for_plan(QUOTA_PLAN_PAID)
        ensure_workspace_members(state_payload, body.owner_user_id, body.nickname)
        apply_workspace_quotas_or_raise(
            state_payload,
            QUOTA_PLAN_CUSTOM_DATABASE if database_url_ciphertext is not None else QUOTA_PLAN_PAID,
        )
        created_at = now_iso()
        record = WorkspaceRecord(
            workspace_id=workspace_id,
            owner_user_id=body.owner_user_id,
            owner_nickname=body.nickname,
            encrypted_payload=encrypt_workspace_payload(workspace_id, state_payload, body.password),
            updated_at=created_at,
            plan=QUOTA_PLAN_PAID,
            billing_status="paid",
            stripe_customer_id=claimed.stripe_customer_id,
            stripe_subscription_id=claimed.stripe_subscription_id,
            custom_database=database_url_ciphertext is not None,
        )
        route = WorkspaceRouteRecord(
            workspace_id=workspace_id,
            owner_user_id=body.owner_user_id,
            billing_status="paid",
            stripe_customer_id=claimed.stripe_customer_id,
            stripe_subscription_id=claimed.stripe_subscription_id,
            database_url_ciphertext=database_url_ciphertext,
            updated_at=created_at,
        )
        try:
            saved = gateway.insert_paid_workspace(record, route)
        except DatabaseUnavailableError:
            raise
        return _workspace_create_response(saved, state_payload)


@app.post("/v1/billing/stripe/webhook")
async def stripe_webhook(
    request: Request,
    stripe_signature: str | None = Header(default=None, alias="Stripe-Signature"),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> dict[str, bool]:
    payload = await request.body()
    try:
        event = get_billing_service().verify_webhook(payload, stripe_signature or "")
    except (BillingConfigurationError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    event_id = str(event["id"])
    event_type = str(event.get("type", ""))
    event_object = event.get("data", {}).get("object", {})
    if not isinstance(event_object, dict):
        event_object = {}
    if event_type in {
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed",
    }:
        session_id = str(event_object.get("id", ""))
        checkout = gateway.get_paid_checkout(session_id)
        if checkout is not None:
            paid = event_type == "checkout.session.async_payment_succeeded" or get_billing_service().checkout_is_paid(event_object)
            next_status = "paid" if paid else "failed" if event_type.endswith("failed") else "pending"
            gateway.save_paid_checkout(
                checkout.model_copy(
                    update={
                        "status": next_status,
                        "stripe_customer_id": _stripe_object_id(event_object.get("customer")) or checkout.stripe_customer_id,
                        "stripe_subscription_id": _stripe_object_id(event_object.get("subscription")) or checkout.stripe_subscription_id,
                        "updated_at": now_iso(),
                    }
                )
            )
    elif event_type in {"customer.subscription.updated", "customer.subscription.deleted"}:
        subscription_id = str(event_object.get("id", ""))
        subscription_status = str(event_object.get("status", "canceled" if event_type.endswith("deleted") else "inactive"))
        gateway.update_billing_status_by_subscription(subscription_id, subscription_status, now_iso())
    gateway.record_stripe_event_once(event_id, now_iso())
    return {"ok": True}


@app.get("/billing/paid-workspace/success", response_class=HTMLResponse)
def paid_workspace_success_page() -> HTMLResponse:
    return HTMLResponse(
        "<main style='font:16px system-ui;padding:40px;max-width:560px;margin:auto'>"
        "<h1>Payment complete</h1><p>Return to JustWork to finish creating the paid workspace.</p></main>"
    )


@app.get("/billing/paid-workspace/cancel", response_class=HTMLResponse)
def paid_workspace_cancel_page() -> HTMLResponse:
    return HTMLResponse(
        "<main style='font:16px system-ui;padding:40px;max-width:560px;margin:auto'>"
        "<h1>Payment canceled</h1><p>No workspace was created. You can close this page.</p></main>"
    )


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
    state_payload["billingPlan"] = QUOTA_PLAN_FREE
    state_payload["historyLimit"] = _history_limit_for_plan(QUOTA_PLAN_FREE)
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
    return _workspace_create_response(saved, state_payload)


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


@app.put("/v1/workspaces/{workspace_id}/password", response_model=WorkspacePasswordChangeResponse)
def change_workspace_password(
    workspace_id: str,
    body: WorkspacePasswordChangeRequest,
    request: Request,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspacePasswordChangeResponse:
    actor_user_id, signed, _ = actor_from_body(body, request, workspace_id, "password")
    record = require_workspace(gateway, workspace_id)
    if not signed or actor_user_id != record.owner_user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="workspace owner required")
    if hmac.compare_digest(body.password, body.new_password):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="new password must be different")

    state_payload = load_decrypted_state(record, body.password)
    current_revision = int(state_payload.get("workspaceRevision", 0))
    if current_revision != body.expected_revision:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="workspace settings revision conflict")

    members = normalize_workspace_members(state_payload.get("members"))
    owner_member = members.get(record.owner_user_id)
    if owner_member is None:
        ensure_workspace_members(state_payload, record.owner_user_id, record.owner_nickname)
        members = normalize_workspace_members(state_payload.get("members"))
        owner_member = members[record.owner_user_id]
    removed_member_count = max(0, len(members) - 1)
    state_payload["members"] = {record.owner_user_id: owner_member}
    next_revision = current_revision + 1
    state_payload["workspaceRevision"] = next_revision
    workspace_title = get_workspace_title(state_payload, workspace_id)
    append_workspace_revision(
        state_payload,
        operation="workspace-password-change",
        item_id="workspace",
        title=workspace_title,
        before={"title": workspace_title, "revision": current_revision},
        after={"title": workspace_title, "revision": next_revision},
        actor_user_id=actor_user_id,
    )

    # Old collaboration tickets contain the previous derived key. Atomically
    # drain each room before re-encrypting: this preserves its final acknowledged
    # CRDT update while rotating the epoch that guards subsequent appends.
    old_collaboration_key = cached_workspace_collaboration_key(workspace_id, body.password)
    collaboration_store = get_collaborative_update_store()
    collaborative_item_ids: list[str] = []
    drained_collaboration_updates: dict[str, bytes] = {}
    for doc in state_payload.get("docs", []):
        if isinstance(doc, dict) and doc.get("kind") in {"page", "table", "board"}:
            item_id = str(doc.get("id", "")).strip()
            if item_id:
                collaborative_item_ids.append(item_id)
                drained = collaboration_store.drain_content(
                    workspace_id,
                    item_id,
                    old_collaboration_key,
                )
                if drained is not None:
                    drained_update, latest_markdown, latest_content = drained
                    drained_collaboration_updates[item_id] = drained_update
                    if doc.get("kind") == "page" and latest_markdown != str(doc.get("markdown", "")):
                        doc["markdown"] = latest_markdown
                        doc["revision"] = int(doc.get("revision", 0)) + 1
                        doc["updatedAt"] = now_iso()
                    elif doc.get("kind") in {"table", "board"} and latest_content != doc.get("content"):
                        doc["content"] = latest_content
                        doc["revision"] = int(doc.get("revision", 0)) + 1
                        doc["updatedAt"] = now_iso()
    invalidate_cached_workspace_collaboration_key(workspace_id)

    try:
        save_state(
            gateway,
            record,
            state_payload,
            body.new_password,
            actor_user_id=actor_user_id,
            enforce_quotas=False,
        )
    except Exception:
        # A workspace CAS can still lose to an unrelated concurrent metadata
        # write. Restore the drained CRDT state under the old credential before
        # reporting that conflict so no acknowledged edit disappears.
        for item_id, update in drained_collaboration_updates.items():
            collaboration_store.append_update(
                workspace_id,
                item_id,
                update,
                encryption_key=old_collaboration_key,
            )
        raise
    # Rotate once more after the payload CAS. A ticket issued with the old
    # password in the pre-commit window must not retain the freshly-created
    # room epoch on another server instance.
    for item_id in collaborative_item_ids:
        collaboration_store.delete_snapshot(workspace_id, item_id)
    invalidate_cached_workspace_collaboration_key(workspace_id)
    gateway.publish_workspace_event(
        workspace_id,
        "workspace.credentials.rotated",
        {
            "type": "workspace.credentials.rotated",
            "workspaceId": workspace_id,
        },
    )
    _disconnect_workspace_realtime_clients(workspace_id)
    return WorkspacePasswordChangeResponse(
        ok=True,
        workspace_id=workspace_id,
        revision=next_revision,
        removed_member_count=removed_member_count,
    )


@app.post("/v1/workspaces/{workspace_id}/relay/join", response_model=WorkspaceRelayJoinResponse)
async def join_workspace_relay(
    workspace_id: str,
    body: WorkspaceRelayJoinRequest,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceRelayJoinResponse:
    def validate_workspace() -> None:
        record = require_workspace(gateway, workspace_id)
        load_decrypted_state(record, body.password)

    # File and database gateways are synchronous. Never hold the event loop on
    # their locks: a concurrent worker may be waiting for this loop to publish a
    # committed invalidation.
    await asyncio.to_thread(validate_workspace)
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
    collab_send_lock = asyncio.Lock()
    await hub.register(workspace_id, websocket)
    relay_gateway = get_gateway()
    uses_workspace_events = await asyncio.to_thread(
        relay_gateway.supports_collaborative_storage,
        workspace_id,
    )
    workspace_event_cursor = (
        await asyncio.to_thread(relay_gateway.workspace_event_cursor, workspace_id)
        if uses_workspace_events
        else 0
    )
    workspace_event_task: asyncio.Task | None = None
    if uses_workspace_events:
        async def poll_workspace_events() -> None:
            nonlocal workspace_event_cursor
            poll_delay = WORKSPACE_EVENT_POLL_MIN_SECONDS
            while True:
                had_events = False
                try:
                    events = await asyncio.to_thread(
                        relay_gateway.workspace_events_since,
                        workspace_id,
                        workspace_event_cursor,
                    )
                    had_events = bool(events)
                    for next_cursor, event_type, event_payload in events:
                        workspace_event_cursor = max(workspace_event_cursor, next_cursor)
                        if event_type == "workspace.credentials.rotated":
                            await websocket.close(code=4403)
                            return
                        if event_type != "workspace.invalidated":
                            continue
                        async with collab_send_lock:
                            await websocket.send_json(event_payload)
                except DatabaseUnavailableError:
                    # The cursor remains unchanged; the durable stream catches up
                    # after a transient database outage.
                    pass
                poll_delay = _next_event_poll_delay(
                    poll_delay,
                    had_events,
                    WORKSPACE_EVENT_POLL_MIN_SECONDS,
                    WORKSPACE_EVENT_POLL_MAX_SECONDS,
                )
                await asyncio.sleep(poll_delay)

        workspace_event_task = asyncio.create_task(poll_workspace_events())
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
                async with collab_send_lock:
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
        if workspace_event_task is not None:
            workspace_event_task.cancel()
            try:
                await workspace_event_task
            except asyncio.CancelledError:
                pass
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
    def prepare_join() -> tuple[bytes, str, bytes | None, bool]:
        require_collaborative_item(gateway, workspace_id, item_id, body.password)
        collaboration_key = cached_workspace_collaboration_key(workspace_id, body.password)
        store = get_collaborative_update_store()
        if body.protocol_version >= 2:
            room_epoch, snapshot, bootstrap_owner = store.join_state(
                workspace_id, item_id, encryption_key=collaboration_key
            )
        else:
            room_epoch, snapshot = store.get_state(workspace_id, item_id, collaboration_key)
            bootstrap_owner = False
        return collaboration_key, room_epoch, snapshot, bootstrap_owner

    # join_state uses the same room lock as revision-guarded HTTP saves. A save
    # commits in a worker and then publishes through the event loop, so waiting
    # for that lock on the loop itself creates an AB/BA deadlock.
    collaboration_key, room_epoch, snapshot, bootstrap_owner = await asyncio.to_thread(prepare_join)
    hub = get_collab_relay_hub()
    ticket, expires_at = await hub.issue_ticket(
        workspace_id,
        item_id,
        room_epoch,
        writable=body.protocol_version >= 2,
        encryption_key=collaboration_key,
        protocol_version=body.protocol_version,
    )
    return WorkspaceCollabJoinResponse(
        ok=True,
        workspace_id=workspace_id,
        item_id=item_id,
        ticket=ticket,
        expires_at=expires_at,
        bootstrap_owner=bootstrap_owner,
        room_epoch=room_epoch,
        snapshot_base64=base64.b64encode(snapshot).decode("ascii") if snapshot else None,
    )


@app.post("/v1/workspaces/{workspace_id}/items/{item_id}/collab/state", response_model=None)
def get_workspace_collab_state(
    workspace_id: str,
    item_id: str,
    body: WorkspacePasswordRequest,
    protocol_version: int = 1,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceCollabStateResponse | Response:
    require_collaborative_item(gateway, workspace_id, item_id, body.password)
    collaboration_key = cached_workspace_collaboration_key(workspace_id, body.password)
    room_epoch, snapshot = get_collaborative_update_store().get_state(
        workspace_id, item_id, collaboration_key
    )
    if protocol_version < 2:
        return Response(content=snapshot or b"", media_type="application/octet-stream")
    return WorkspaceCollabStateResponse(
        ok=True,
        workspace_id=workspace_id,
        item_id=item_id,
        room_epoch=room_epoch,
        snapshot_base64=base64.b64encode(snapshot).decode("ascii") if snapshot else None,
    )


@app.websocket("/v1/workspaces/{workspace_id}/items/{item_id}/collab")
async def workspace_collab_relay(
    websocket: WebSocket,
    workspace_id: str,
    item_id: str,
    ticket: str,
) -> None:
    hub = get_collab_relay_hub()
    store = get_collaborative_update_store()
    ticket_state = await hub.validate_ticket(workspace_id, item_id, ticket)
    if ticket_state is None:
        await websocket.close(code=4401)
        return
    room_epoch, writable, collaboration_key, protocol_version = ticket_state
    if not await asyncio.to_thread(
        store.epoch_matches,
        workspace_id,
        item_id,
        room_epoch,
        collaboration_key,
    ):
        await websocket.close(code=4409)
        return
    # Protocol v3 may send ACKs from the receive loop while the cross-instance
    # poller emits updates. Starlette does not permit concurrent websocket sends.
    collab_send_lock = asyncio.Lock()
    uses_cross_instance_events = protocol_version >= 3 and await asyncio.to_thread(
        store.supports_cross_instance_events,
        workspace_id,
    )
    event_cursor = await asyncio.to_thread(store.event_cursor, workspace_id, item_id) if uses_cross_instance_events else 0
    initial_updates = await asyncio.to_thread(store.load_updates, workspace_id, item_id, collaboration_key)
    if not uses_cross_instance_events:
        await hub.register(workspace_id, item_id, websocket)
    # Complete room setup before accepting. TestClient and fast real clients may
    # send and close immediately after the handshake; yielding to storage setup
    # after accept can otherwise let the final frame race socket teardown.
    try:
        await websocket.accept()
        for update in initial_updates:
            await websocket.send_bytes(update)
    except Exception:  # client disappeared during the handshake
        if not uses_cross_instance_events:
            await hub.unregister(workspace_id, item_id, websocket)
        return
    poll_task: asyncio.Task | None = None
    if uses_cross_instance_events:
        async def poll_cross_instance_updates() -> None:
            nonlocal event_cursor
            poll_delay = COLLAB_EVENT_POLL_MIN_SECONDS
            while True:
                had_events = False
                try:
                    epoch_is_current = await asyncio.to_thread(
                        store.epoch_matches,
                        workspace_id,
                        item_id,
                        room_epoch,
                        collaboration_key,
                    )
                    if not epoch_is_current:
                        async with collab_send_lock:
                            await websocket.close(code=4409)
                        return
                    events = await asyncio.to_thread(
                        store.events_since,
                        workspace_id,
                        item_id,
                        room_epoch,
                        event_cursor,
                        collaboration_key,
                    )
                    had_events = bool(events)
                    for next_cursor, remote_update_id, remote_payload in events:
                        event_cursor = max(event_cursor, next_cursor)
                        async with collab_send_lock:
                            await websocket.send_json({
                                "type": "collab.update",
                                "updateId": remote_update_id,
                                "payloadBase64": base64.b64encode(remote_payload).decode("ascii"),
                            })
                except DatabaseUnavailableError:
                    pass
                poll_delay = _next_event_poll_delay(
                    poll_delay,
                    had_events,
                    COLLAB_EVENT_POLL_MIN_SECONDS,
                    COLLAB_EVENT_POLL_MAX_SECONDS,
                )
                await asyncio.sleep(poll_delay)

        poll_task = asyncio.create_task(poll_cross_instance_updates())
    try:
        while True:
            message = await websocket.receive()
            msg_type = message.get("type")
            if msg_type == "websocket.disconnect":
                break
            payload = message.get("bytes")
            update_id: str | None = None
            if protocol_version >= 3:
                raw_text = message.get("text")
                if not isinstance(raw_text, str):
                    async with collab_send_lock:
                        await websocket.send_json({"type": "collab.error", "code": "binary_not_supported"})
                    continue
                try:
                    envelope = json.loads(raw_text)
                    update_id = str(envelope.get("updateId", ""))
                    encoded = str(envelope.get("payloadBase64", ""))
                    if envelope.get("type") != "collab.update" or not (8 <= len(update_id) <= 128):
                        raise ValueError("invalid collaborative envelope")
                    next_payload = base64.b64decode(encoded, validate=True)
                    if not next_payload or len(next_payload) > 8 * 1024 * 1024:
                        raise ValueError("invalid collaborative payload")
                except (ValueError, TypeError, json.JSONDecodeError):
                    async with collab_send_lock:
                        await websocket.send_json({"type": "collab.error", "code": "invalid_update"})
                    continue
            else:
                if not isinstance(payload, (bytes, bytearray)):
                    continue
                next_payload = bytes(payload)
            if not writable:
                # v1 clients may read the canonical room but must persist edits via
                # the revision-guarded REST markdown delta path.
                continue
            if protocol_version >= 3:
                try:
                    inserted = await anyio_to_thread.run_sync(partial(
                        store.append_update,
                        workspace_id,
                        item_id,
                        next_payload,
                        expected_epoch=room_epoch,
                        encryption_key=collaboration_key,
                        update_id=update_id,
                    ))
                except ValueError:
                    async with collab_send_lock:
                        await websocket.send_json({
                            "type": "collab.error",
                            "code": "invalid_update",
                            "updateId": update_id,
                        })
                    continue
            else:
                # Legacy test/extension clients can close immediately after their
                # final binary frame. Finish that frame inline so teardown cannot
                # cancel persistence; HTTP commits no longer call back into the
                # event loop while holding this room lock.
                inserted = store.append_update(
                    workspace_id,
                    item_id,
                    next_payload,
                    expected_epoch=room_epoch,
                    encryption_key=collaboration_key,
                    update_id=update_id,
                )
            if protocol_version >= 3 and update_id is not None:
                async with collab_send_lock:
                    await websocket.send_json({
                        "type": "collab.ack",
                        "updateId": update_id,
                        "roomEpoch": room_epoch,
                    })
                if inserted and not uses_cross_instance_events:
                    await hub.broadcast(
                        workspace_id,
                        item_id,
                        websocket,
                        json.dumps({
                            "type": "collab.update",
                            "updateId": update_id,
                            "payloadBase64": base64.b64encode(next_payload).decode("ascii"),
                        }, separators=(",", ":")),
                    )
            elif inserted:
                await hub.broadcast(workspace_id, item_id, websocket, next_payload)
    except WebSocketDisconnect:
        pass
    finally:
        if poll_task is not None:
            poll_task.cancel()
            try:
                await poll_task
            except asyncio.CancelledError:
                pass
        if not uses_cross_instance_events:
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
    state_payload = load_decrypted_state(record, body.password)
    members = state_payload.get("members") if isinstance(state_payload.get("members"), dict) else {}
    current = members.get(target_user_id) if isinstance(members.get(target_user_id), dict) else None
    current_revision = int(current.get("revision", 0)) if current else 0
    if current_revision != body.expected_revision:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="member revision conflict")
    before_member = dict(current) if current else {}
    member = upsert_workspace_member(state_payload, target_user_id, body.nickname)
    append_workspace_revision(
        state_payload,
        operation="member-profile",
        item_id=target_user_id,
        title=member["nickname"],
        before=before_member,
        after=member,
        actor_user_id=actor_user_id,
    )
    save_state(
        gateway,
        record,
        state_payload,
        body.password,
        owner_nickname=body.nickname if target_user_id == record.owner_user_id else None,
        actor_user_id=actor_user_id,
    )
    return ProfileResponse(
        ok=True,
        profile=ProfileBody(
            user_id=target_user_id,
            nickname=member["nickname"],
            display_name=display_name(member["nickname"], target_user_id),
            revision=int(member.get("revision", 0)),
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
        workspace_revision=int(state_payload.get("workspaceRevision", 0)),
        active_item_id=state_payload["activeDocId"],
        items=tree_items(state_payload),
    )


@app.post("/v1/workspaces/{workspace_id}/revisions", response_model=WorkspaceRevisionHistoryResponse)
def list_workspace_revision_history(
    workspace_id: str,
    body: WorkspacePasswordRequest,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceRevisionHistoryResponse:
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    revisions = list_workspace_revisions(state_payload)
    return WorkspaceRevisionHistoryResponse(
        ok=True,
        workspace_id=workspace_id,
        revisions=[
            {
                "id": event["id"],
                "operation": event["operation"],
                "item_id": event["itemId"],
                "title": event["title"],
                "before": event["before"],
                "after": event["after"],
                "actor_user_id": event.get("actorUserId"),
                "mutation_id": event.get("mutationId"),
                "source_revision_id": event.get("sourceRevisionId"),
                "timestamp": event["timestamp"],
            }
            for event in revisions
        ],
    )


def _inverse_history_text(current: str, before: str, after: str) -> str:
    if before == after:
        return current
    differ = diff_match_patch()
    patches = differ.patch_make(after, before)
    reverted, applied = differ.patch_apply(patches, current)
    if not all(applied):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="history rollback conflicts with newer document changes",
        )
    return reverted


@app.post(
    "/v1/workspaces/{workspace_id}/revisions/{revision_id}/revert",
    response_model=WorkspaceItemResponse,
)
def revert_workspace_revision(
    workspace_id: str,
    revision_id: str,
    body: WorkspaceRevisionMutationRequest,
    request: Request,
    _: None = Depends(require_backend_token),
    gateway: DatabaseGateway = Depends(get_gateway),
) -> WorkspaceItemResponse:
    actor_user_id, _, _ = actor_from_body(body, request, workspace_id, revision_id)
    record = require_workspace(gateway, workspace_id)
    state_payload = load_decrypted_state(record, body.password)
    mutation_id = client_mutation_id_from_body(body)
    recorded_item = recorded_mutation_item(
        state_payload,
        mutation_id,
        operation="history-revert",
        target_id=revision_id,
    )
    if recorded_item is not None:
        # An idempotent retry is observational only. The first successful call
        # already committed the new room epoch and canonical snapshot; clearing
        # it here would reopen the stale-client bootstrap race we just closed.
        return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=recorded_item)

    source = next(
        (event for event in list_workspace_revisions(state_payload) if event.get("id") == revision_id),
        None,
    )
    if source is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="history revision not found")
    item_id = str(source.get("itemId", ""))
    if not item_id or item_id == "workspace":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="history revision is not a document change")
    try:
        current_doc = require_expected_revision(state_payload, item_id, body.expected_revision)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found") from exc

    before_doc = dict(current_doc)
    source_before = source.get("before") if isinstance(source.get("before"), dict) else {}
    source_after = source.get("after") if isinstance(source.get("after"), dict) else {}
    operation = str(source.get("operation", ""))
    doc = current_doc
    body_changed = False

    if operation == "create":
        if bool(doc.get("inTrash", False)):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="created item is already in trash")
        doc["inTrash"] = True
        if state_payload.get("activeDocId") == item_id:
            state_payload["activeDocId"] = ""
            choose_active_item_id(state_payload)
    else:
        scalar_fields = {
            "title": "title",
            "pinned": "pinned",
            "inTrash": "inTrash",
            "parentId": "parentId",
            "orderKey": "orderKey",
            "orderRank": "orderRank",
        }
        for snapshot_key, doc_key in scalar_fields.items():
            before_value = source_before.get(snapshot_key)
            after_value = source_after.get(snapshot_key)
            if before_value == after_value:
                continue
            if doc.get(doc_key) != after_value:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"history rollback conflicts with newer {snapshot_key} changes",
                )
            doc[doc_key] = copy.deepcopy(before_value)

        if doc.get("kind") == "page" and source_before.get("markdown") != source_after.get("markdown"):
            doc["markdown"] = _inverse_history_text(
                str(doc.get("markdown", "")),
                str(source_before.get("markdown", "")),
                str(source_after.get("markdown", "")),
            )
            body_changed = doc.get("markdown") != before_doc.get("markdown")
        if doc.get("kind") in {"table", "board"} and source_before.get("content") != source_after.get("content"):
            current_json = json.dumps(doc.get("content"), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            before_json = json.dumps(source_before.get("content"), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            after_json = json.dumps(source_after.get("content"), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            reverted_json = _inverse_history_text(current_json, before_json, after_json)
            try:
                doc["content"] = json.loads(reverted_json)
            except json.JSONDecodeError as exc:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="structured history rollback conflict") from exc
            body_changed = doc.get("content") != before_doc.get("content")

    if doc == before_doc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="history revision is already reverted")
    doc["revision"] = int(before_doc.get("revision", 0)) + 1
    doc["updatedAt"] = now_iso()

    def commit_revert() -> dict:
        item = item_view(doc)
        record_mutation_item(
            state_payload,
            mutation_id,
            operation="history-revert",
            target_id=revision_id,
            item=item,
        )
        append_workspace_revision(
            state_payload,
            operation="history-revert",
            item_id=item_id,
            title=str(doc.get("title", "")),
            before=before_doc,
            after=doc,
            actor_user_id=actor_user_id,
            mutation_id=mutation_id,
            source_revision_id=revision_id,
        )
        save_state(gateway, record, state_payload, body.password, actor_user_id=actor_user_id)
        return item

    if body_changed and doc.get("kind") in {"page", "table", "board"}:
        collaboration_store = get_collaborative_update_store()
        canonical_snapshot = collaboration_store.canonical_snapshot(
            markdown=str(doc.get("markdown", "")) if doc.get("kind") == "page" else None,
            content=(doc.get("content") if isinstance(doc.get("content"), dict) else {})
            if doc.get("kind") in {"table", "board"}
            else None,
        )
        item = collaboration_store.reset_with_commit(
            workspace_id,
            item_id,
            commit_revert,
            canonical_snapshot,
            cached_workspace_collaboration_key(workspace_id, body.password),
        )
        _disconnect_collaborative_item_clients(workspace_id, item_id)
    else:
        item = commit_revert()
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item)


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
    current_revision = int(state_payload.get("workspaceRevision", 0))
    if current_revision != body.expected_revision:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="workspace settings revision conflict")
    before = {
        "title": get_workspace_title(state_payload, workspace_id),
        "revision": current_revision,
    }
    title = update_workspace_title(state_payload, body.title, workspace_id)
    revision = int(state_payload.get("workspaceRevision", 0))
    append_workspace_revision(
        state_payload,
        operation="workspace-settings",
        item_id="workspace",
        title=title,
        before=before,
        after={"title": title, "revision": revision},
        actor_user_id=actor_user_id,
    )
    save_state(gateway, record, state_payload, body.password, actor_user_id=actor_user_id)
    return WorkspaceSettingsResponse(ok=True, workspace_id=workspace_id, title=title, revision=revision)


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
    append_workspace_revision(
        state_payload,
        operation="create",
        item_id=doc["id"],
        title=doc.get("title", ""),
        before=None,
        after=doc,
        actor_user_id=au,
        mutation_id=mutation_id,
    )
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
        should_finish_structured_reset = bool(
            body.reset_collaborative_state
            or (
                body.collaborative_update is None
                and recorded_item.get("kind") in {"table", "board"}
                and body.content is not None
            )
        )
        if should_finish_structured_reset:
            if recorded_item.get("kind") not in {"table", "board"} or body.content is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="collaborative reset requires table or board content",
                )
            # The workspace write may have committed before a previous room
            # reset failed. An idempotent retry must finish that second half
            # instead of returning while the obsolete room is still live.
            get_collaborative_update_store().delete_snapshot(workspace_id, item_id)
            _disconnect_collaborative_item_clients(workspace_id, item_id)
        return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=recorded_item)
    collaborative_update: bytes | None = None
    try:
        cur = require_expected_revision(state_payload, item_id, body.expected_revision)
        before_doc = dict(cur)
        if body.collaborative_update is not None:
            kind = cur.get("kind")
            has_matching_body = (
                (kind == "page" and body.markdown is not None)
                or (kind in {"table", "board"} and body.content is not None)
            )
            if not has_matching_body:
                raise ValueError("collaborative_update requires matching document content")
            if not body.collaborative_epoch:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="client update required: collaborative room epoch is missing",
                )
            try:
                collaborative_update = base64.b64decode(body.collaborative_update, validate=True)
            except Exception as exc:  # noqa: BLE001
                raise ValueError("invalid collaborative update") from exc
        doc = update_doc(state_payload, item_id, body.title, body.markdown, body.content)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    if body.reset_collaborative_state and (
        doc.get("kind") not in {"table", "board"} or body.content is None
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="collaborative reset requires table or board content",
        )

    reset_structured_collaboration = bool(
        body.reset_collaborative_state
        or (
            collaborative_update is None
            and doc.get("kind") in {"table", "board"}
            and body.content is not None
            and body.content != before_doc.get("content")
        )
    )
    deferred_notifications: list[Callable[[], None]] = []

    def commit_doc(
        merged_markdown: str | None = None,
        merged_content: dict | None = None,
    ) -> dict:
        if merged_markdown is not None:
            doc["markdown"] = merged_markdown
        if merged_content is not None:
            doc["content"] = merged_content
        unchanged = (
            doc.get("title", "") == before_doc.get("title", "")
            and doc.get("markdown", "") == before_doc.get("markdown", "")
            and doc.get("content") == before_doc.get("content")
        )
        if unchanged:
            # A retry, duplicate editor callback, or idempotent CRDT state must not
            # consume quota by creating a revision containing two full snapshots.
            doc.clear()
            doc.update(before_doc)
            return item_view(doc)
        if int(doc.get("revision", 0)) == int(before_doc.get("revision", 0)):
            doc["revision"] = int(before_doc.get("revision", 0)) + 1
            doc["updatedAt"] = now_iso()
        item = item_view(doc)
        record_mutation_item(state_payload, mutation_id, operation="update", target_id=item_id, item=item)
        append_workspace_revision(
            state_payload,
            operation="update",
            item_id=item_id,
            title=doc.get("title", ""),
            before=before_doc,
            after=doc,
            actor_user_id=au,
            mutation_id=mutation_id,
        )
        save_state(
            gateway,
            record,
            state_payload,
            body.password,
            actor_user_id=au,
            deferred_notifications=deferred_notifications,
        )
        return item

    committed_update: bytes | None = None
    if collaborative_update is not None:
        try:
            is_structured_update = doc.get("kind") in {"table", "board"}
            committed_update, _, item = get_collaborative_update_store().commit_update(
                workspace_id,
                item_id,
                collaborative_update,
                commit_doc,
                expected_epoch=body.collaborative_epoch,
                encryption_key=cached_workspace_collaboration_key(workspace_id, body.password),
                commit_document=(
                    (lambda _markdown, content: commit_doc(merged_content=content))
                    if is_structured_update
                    else None
                ),
            )
        except HTTPException:
            raise
        except ValueError as exc:
            if "epoch conflict" in str(exc):
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid collaborative update") from exc
        except (CollaborativeRoomCorruptError, CollaborativeRoomTransientError):
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid collaborative update") from exc
    elif doc.get("kind") == "page" and body.markdown is not None:
        try:
            committed_update, _, item = get_collaborative_update_store().commit_markdown_change(
                workspace_id,
                item_id,
                str(before_doc.get("markdown", "")),
                doc.get("markdown", ""),
                commit_doc,
                encryption_key=cached_workspace_collaboration_key(workspace_id, body.password),
            )
        except HTTPException:
            raise
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    else:
        item = commit_doc()
    if reset_structured_collaboration:
        # Agent/plain REST structured writes and history inverses are
        # authoritative whole-document replacements. The previous room does
        # not contain that JSON change, so retaining it lets an idle client
        # repaint and save the obsolete state.
        get_collaborative_update_store().delete_snapshot(workspace_id, item_id)
        _disconnect_collaborative_item_clients(workspace_id, item_id)
    for notify in deferred_notifications:
        notify()
    if committed_update is not None:
        _broadcast_collaborative_update_from_http(workspace_id, item_id, committed_update)
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
    append_workspace_revision(state_payload, operation="pin", item_id=item_id, title=doc.get("title", ""), before=before_doc, after=doc, actor_user_id=au, mutation_id=mutation_id)
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
        doc = move_doc(
            state_payload, item_id, body.parent_id, body.order_key, body.order_rank
        )
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="item not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    item = item_view(doc)
    record_mutation_item(state_payload, mutation_id, operation="move", target_id=item_id, item=item)
    append_workspace_revision(state_payload, operation="move", item_id=item_id, title=doc.get("title", ""), before=before_doc, after=doc, actor_user_id=au, mutation_id=mutation_id)
    save_state(gateway, record, state_payload, body.password, actor_user_id=au)
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item)


@app.put("/v1/workspaces/{workspace_id}/items/{item_id}/trash", response_model=WorkspaceItemResponse)
def trash_workspace_item(
    workspace_id: str,
    item_id: str,
    body: WorkspaceRevisionMutationRequest,
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
    append_workspace_revision(state_payload, operation="trash", item_id=item_id, title=doc.get("title", ""), before=before_doc, after=doc, actor_user_id=au, mutation_id=mutation_id)
    save_state(gateway, record, state_payload, body.password, actor_user_id=au)
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item)


@app.put("/v1/workspaces/{workspace_id}/items/{item_id}/restore", response_model=WorkspaceItemResponse)
def restore_workspace_item(
    workspace_id: str,
    item_id: str,
    body: WorkspaceRevisionMutationRequest,
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
    append_workspace_revision(state_payload, operation="restore", item_id=item_id, title=doc.get("title", ""), before=before_doc, after=doc, actor_user_id=au, mutation_id=mutation_id)
    save_state(gateway, record, state_payload, body.password, actor_user_id=au)
    return WorkspaceItemResponse(ok=True, workspace_id=workspace_id, item=item)


@app.post("/v1/workspaces/{workspace_id}/items/{item_id}/hard-delete", response_model=WorkspaceItemResponse)
def hard_delete_workspace_item(
    workspace_id: str,
    item_id: str,
    body: WorkspaceRevisionMutationRequest,
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
    append_workspace_revision(state_payload, operation="hard-delete", item_id=item_id, title=doc.get("title", ""), before=before_doc, after=None, actor_user_id=au, mutation_id=mutation_id)
    save_state(gateway, record, state_payload, body.password, actor_user_id=au)
    get_collab_relay_hub().delete_snapshot(workspace_id, item_id)
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
        before_doc = dict(require_expected_revision(state_payload, item_id, body.expected_revision))
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
        deferred_notifications: list[Callable[[], None]] = []

        def commit_patch(merged_markdown: str | None = None) -> dict:
            nonlocal preview
            if merged_markdown is not None:
                doc["markdown"] = merged_markdown
                preview = merged_markdown
            item = item_view(doc)
            record_patch_mutation(
                state_payload,
                mutation_id,
                target_id=item_id,
                item=item,
                changed=changed,
                preview_markdown=preview,
            )
            append_workspace_revision(
                state_payload,
                operation="patch",
                item_id=item_id,
                title=doc.get("title", ""),
                before=before_doc,
                after=doc,
                actor_user_id=au,
                mutation_id=mutation_id,
            )
            save_state(
                gateway,
                record,
                state_payload,
                body.password,
                actor_user_id=au,
                deferred_notifications=deferred_notifications,
            )
            return item

        if doc.get("kind") == "page":
            try:
                committed_update, _, item = get_collaborative_update_store().commit_markdown_change(
                    workspace_id,
                    item_id,
                    str(before_doc.get("markdown", "")),
                    doc.get("markdown", ""),
                    commit_patch,
                    encryption_key=cached_workspace_collaboration_key(workspace_id, body.password),
                )
            except HTTPException:
                raise
            except ValueError as exc:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
            _broadcast_collaborative_update_from_http(workspace_id, item_id, committed_update)
        else:
            item = commit_patch()
        for notify in deferred_notifications:
            notify()
    else:
        item = item_view(doc)
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
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="whole-workspace replacement is disabled; use item mutation endpoints",
    )
