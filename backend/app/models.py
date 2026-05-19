from typing import Any, Literal

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
    workspace_title: str
    active_item_id: str
    items: list["WorkspaceTreeItem"]


class WorkspacePasswordRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)


class WorkspaceRelayJoinRequest(BaseModel):
    password: str = Field(min_length=1)


class WorkspaceCollabJoinRequest(BaseModel):
    password: str = Field(min_length=1)


class WorkspaceTreeItem(BaseModel):
    id: str
    title: str
    kind: Literal["page", "folder", "table", "board"]
    parent_id: str | None = None
    pinned: bool = False
    in_trash: bool = False
    revision: int = 0
    updated_at: str


class WorkspaceTreeResponse(BaseModel):
    ok: bool
    workspace_id: str
    workspace_title: str
    active_item_id: str
    items: list[WorkspaceTreeItem]


class WorkspaceItem(BaseModel):
    id: str
    title: str
    markdown: str
    content: dict[str, Any] | None = None
    kind: Literal["page", "folder", "table", "board"]
    parent_id: str | None = None
    pinned: bool = False
    in_trash: bool = False
    revision: int = 0
    updated_at: str


class WorkspaceItemResponse(BaseModel):
    ok: bool
    workspace_id: str
    item: WorkspaceItem


class WorkspaceShareCreateResponse(BaseModel):
    ok: bool
    workspace_id: str
    item_id: str
    share_url: str


class ShareViewRequest(BaseModel):
    password: str = Field(min_length=1)


class ShareViewResponse(BaseModel):
    ok: bool
    workspace_id: str
    item: WorkspaceItem


class WorkspaceItemUpdateRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)
    title: str | None = None
    markdown: str | None = None
    content: dict[str, Any] | None = None
    expected_revision: int | None = None


class WorkspaceItemCreateRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)
    kind: Literal["page", "folder", "table", "board"] = "page"
    title: str = "Untitled"
    parent_id: str | None = None
    client_item_id: str | None = None


class WorkspaceItemPinRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)
    pinned: bool


class WorkspaceSettingsUpdateRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)
    title: str = ""


class WorkspaceSettingsResponse(BaseModel):
    ok: bool
    workspace_id: str
    title: str


class ProfileUpdateRequest(WriteSigningEnvelope):
    password: str | None = None
    nickname: str = ""


class ProfileBody(BaseModel):
    user_id: str
    nickname: str
    display_name: str


class ProfileResponse(BaseModel):
    ok: bool
    profile: ProfileBody


class WorkspaceMemberBody(BaseModel):
    user_id: str
    nickname: str
    display_name: str
    joined_at: str
    updated_at: str
    is_owner: bool = False


class WorkspaceMembersResponse(BaseModel):
    ok: bool
    workspace_id: str
    members: list[WorkspaceMemberBody]


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


class WorkspaceCollabJoinResponse(BaseModel):
    ok: bool
    workspace_id: str
    item_id: str
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
    kind: Literal["page", "folder", "table", "board"]
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
