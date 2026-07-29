from typing import Any, Literal

from pydantic import BaseModel, Field


class WriteSigningEnvelope(BaseModel):
    actor_user_id: str | None = None
    client_mutation_id: str | None = None
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
    plan: Literal["free", "paid"] = "free"
    billing_status: str = "free"
    stripe_customer_id: str | None = None
    stripe_subscription_id: str | None = None


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
    plan: Literal["free", "paid"] = "free"
    billing_status: str = "free"


class WorkspaceCreateResponse(BaseModel):
    ok: bool
    workspace: WorkspaceSummary
    workspace_title: str
    workspace_revision: int = 0
    active_item_id: str
    items: list["WorkspaceTreeItem"]


class PaidWorkspaceBillingConfigResponse(BaseModel):
    ok: bool = True
    enabled: bool
    checkout_mode: Literal["payment", "subscription"]
    price_label: str
    storage_multiplier: int = 4
    history_limit: int = 1000
    custom_database_enabled: bool


class PaidWorkspaceCheckoutRequest(BaseModel):
    owner_user_id: str = Field(min_length=1)


class PaidWorkspaceCheckoutResponse(BaseModel):
    ok: bool = True
    checkout_session_id: str
    checkout_url: str


class PaidWorkspaceCheckoutStatusResponse(BaseModel):
    ok: bool = True
    checkout_session_id: str
    status: str
    paid: bool


class PaidWorkspaceCompleteRequest(BaseModel):
    checkout_session_id: str = Field(min_length=1)
    owner_user_id: str = Field(min_length=1)
    nickname: str = ""
    password: str = Field(min_length=1)
    title: str = "Untitled"
    custom_database_url: str | None = Field(default=None, max_length=2048)


class PaidCheckoutRecord(BaseModel):
    purchase_token: str
    owner_user_id: str
    checkout_session_id: str
    status: str
    stripe_customer_id: str | None = None
    stripe_subscription_id: str | None = None
    consumed_workspace_id: str | None = None
    created_at: str
    updated_at: str


class WorkspaceRouteRecord(BaseModel):
    workspace_id: str
    owner_user_id: str
    plan: Literal["paid"] = "paid"
    billing_status: str
    stripe_customer_id: str | None = None
    stripe_subscription_id: str | None = None
    database_url_ciphertext: str | None = None
    updated_at: str


class WorkspacePasswordRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)
    expected_revision: int | None = None


class WorkspaceRevisionMutationRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)
    expected_revision: int


class WorkspaceRelayJoinRequest(BaseModel):
    password: str = Field(min_length=1)


class WorkspaceCollabJoinRequest(BaseModel):
    password: str = Field(min_length=1)


class WorkspaceTreeItem(BaseModel):
    id: str
    title: str
    kind: Literal["page", "folder", "table", "board"]
    parent_id: str | None = None
    order_key: float = 0
    pinned: bool = False
    in_trash: bool = False
    revision: int = 0
    updated_at: str


class WorkspaceTreeResponse(BaseModel):
    ok: bool
    workspace_id: str
    workspace_title: str
    workspace_revision: int = 0
    active_item_id: str
    items: list[WorkspaceTreeItem]


class WorkspaceItem(BaseModel):
    id: str
    title: str
    markdown: str
    content: dict[str, Any] | None = None
    kind: Literal["page", "folder", "table", "board"]
    parent_id: str | None = None
    order_key: float = 0
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
    collaborative_update: str | None = None
    expected_revision: int


class WorkspaceItemCreateRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)
    kind: Literal["page", "folder", "table", "board"] = "page"
    title: str = "Untitled"
    parent_id: str | None = None
    client_item_id: str | None = None


class WorkspaceItemPinRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)
    pinned: bool
    expected_revision: int


class WorkspaceSettingsUpdateRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)
    title: str = ""
    expected_revision: int


class WorkspaceSettingsResponse(BaseModel):
    ok: bool
    workspace_id: str
    title: str
    revision: int


class ProfileUpdateRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)
    nickname: str = ""
    expected_revision: int


class ProfileBody(BaseModel):
    user_id: str
    nickname: str
    display_name: str
    revision: int = 0


class ProfileResponse(BaseModel):
    ok: bool
    profile: ProfileBody


class WorkspaceMemberBody(BaseModel):
    user_id: str
    nickname: str
    display_name: str
    joined_at: str
    updated_at: str
    revision: int = 0
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
    bootstrap_owner: bool = False


class WorkspaceRevisionEvent(BaseModel):
    id: str
    operation: str
    item_id: str
    title: str
    before: dict[str, Any]
    after: dict[str, Any]
    actor_user_id: str | None = None
    mutation_id: str | None = None
    timestamp: str


class WorkspaceRevisionHistoryResponse(BaseModel):
    ok: bool
    workspace_id: str
    revisions: list[WorkspaceRevisionEvent]


class WorkspaceItemMoveRequest(WriteSigningEnvelope):
    password: str = Field(min_length=1)
    parent_id: str | None = None
    order_key: float = 0
    expected_revision: int


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
    expected_revision: int


class WorkspacePatchResponse(BaseModel):
    ok: bool
    workspace_id: str
    item: WorkspaceItem
    changed: bool
    preview_markdown: str
