from typing import Any

from pydantic import BaseModel, Field


class WriteSigningEnvelope(BaseModel):
    actor_user_id: str | None = None
    public_key: dict[str, Any] | None = None
    signature: str | None = None
    nonce: str | None = None
    timestamp: str | None = None
    body_hash: str | None = None


class HealthResponse(BaseModel):
    ok: bool = True
    mode: str = "backend-gateway"


class WorkspaceRecord(BaseModel):
    workspace_id: str = Field(min_length=1)
    owner_user_id: str = Field(min_length=1)
    owner_nickname: str = ""
    encrypted_payload: str = Field(min_length=1)
    updated_at: str = Field(min_length=1)


class WorkspaceUpsertRequest(BaseModel):
    workspace_id: str = Field(min_length=1)
    owner_user_id: str = Field(min_length=1)
    owner_nickname: str = ""
    encrypted_payload: str = Field(min_length=1)
    updated_at: str = Field(min_length=1)


class WorkspaceGetResponse(BaseModel):
    ok: bool
    workspace: WorkspaceRecord | None = None


class ErrorBody(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    ok: bool = False
    error: ErrorBody


class WorkspaceCreateRequest(BaseModel):
    owner_user_id: str = Field(min_length=1)
    nickname: str = ""
    password: str = Field(min_length=1)
    title: str = "Untitled"


class WorkspaceSummary(BaseModel):
    workspace_id: str
    owner_user_id: str
    owner_nickname: str
    owner_display_name: str
    encrypted_payload: str
    updated_at: str


class WorkspaceCreateResponse(BaseModel):
    ok: bool
    workspace: WorkspaceSummary
    active_item_id: str
    items: list["WorkspaceTreeItem"]


class WorkspacePasswordRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)


class WorkspaceRelayJoinRequest(BaseModel):
    password: str = Field(min_length=1)


class WorkspaceTreeItem(BaseModel):
    id: str
    title: str
    kind: str
    parent_id: str | None = None
    pinned: bool = False
    in_trash: bool = False
    revision: int = 0
    updated_at: str


class WorkspaceTreeResponse(BaseModel):
    ok: bool
    workspace_id: str
    active_item_id: str
    items: list[WorkspaceTreeItem]


class WorkspaceItem(BaseModel):
    id: str
    title: str
    markdown: str
    kind: str
    parent_id: str | None = None
    pinned: bool = False
    in_trash: bool = False
    revision: int = 0
    updated_at: str


class WorkspaceItemResponse(BaseModel):
    ok: bool
    workspace_id: str
    item: WorkspaceItem


class WorkspaceItemUpdateRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)
    title: str | None = None
    markdown: str | None = None
    expected_revision: int | None = None
    expected_revision: int | None = None


class WorkspaceItemCreateRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)
    kind: str = Field(pattern="^(page|folder)$")
    title: str = "Untitled"
    parent_id: str | None = None


class WorkspaceItemPinRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)
    pinned: bool


class ProfileUpdateRequest(WriteSigningEnvelope):
    nickname: str = ""


class ProfileBody(BaseModel):
    user_id: str
    nickname: str
    display_name: str


class ProfileResponse(BaseModel):
    ok: bool
    profile: ProfileBody


class WorkspaceQuotaBody(BaseModel):
    plan: str
    used_bytes: int
    limit_bytes: int
    usage_ratio: float


class WorkspaceQuotaResponse(BaseModel):
    ok: bool
    workspace_id: str
    quota: WorkspaceQuotaBody


class WorkspaceRelayJoinResponse(BaseModel):
    ok: bool
    workspace_id: str
    ticket: str
    expires_at: str


class WorkspaceItemMoveRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)
    parent_id: str | None = None


class WorkspaceSearchRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)
    query: str = Field(min_length=1)


class WorkspaceSearchResult(BaseModel):
    id: str
    title: str
    kind: str
    parent_id: str | None = None
    score: int
    excerpt: str


class WorkspaceSearchResponse(BaseModel):
    ok: bool
    workspace_id: str
    results: list[WorkspaceSearchResult]


class OutlineHeading(BaseModel):
    level: int
    text: str
    line: int


class WorkspaceOutlineResponse(BaseModel):
    ok: bool
    workspace_id: str
    item_id: str
    headings: list[OutlineHeading]


class WorkspacePatchRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)
    find: str = Field(min_length=1)
    replace: str = ""
    dry_run: bool = True
    expected_revision: int | None = None


class WorkspacePatchResponse(BaseModel):
    ok: bool
    workspace_id: str
    item: WorkspaceItem
    changed: bool
    preview_markdown: str


class HistoryEvent(BaseModel):
    id: str
    op: str
    item_id: str
    timestamp: str
    title: str
    before_markdown: str
    after_markdown: str
    actor_user_id: str | None = None
    signed: bool = False
    signature_digest: str | None = None


class WorkspaceHistoryResponse(BaseModel):
    ok: bool
    workspace_id: str
    events: list[HistoryEvent]
