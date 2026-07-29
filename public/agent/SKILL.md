# JustWork Agent Skill

Use this skill when an external Agent needs to control a JustWork workspace.

## Product Surface

## Backend API

JustWork Agent access is the fixed JustWork Backend plus OpenAPI. There is no registration step and no local product bridge. The browser extension and third-party Agents operate the same encrypted workspace through HTTP.

```text
GET /openapi.json
<BACKEND_URL>/openapi.json
<BACKEND_URL>/docs
<BACKEND_URL>/agent/SKILL.md
```

The calling system or human should provide:

- `BACKEND_URL`, normally the fixed JustWork Backend URL for the environment.
- `workspace_id` for an existing workspace.
- `workspace password` for decrypting the workspace payload during each request.

Do not ask the user to register an account. JustWork identity is key-based. The browser extension creates a local keypair and derives `userId` from the public key. Nicknames are display-only and may repeat; UI display should use `nickname@<userId last 4>`.

## Discovery

1. Read `GET /openapi.json`.
2. Use the schemas and paths in OpenAPI as the machine contract.
3. Use this `SKILL.md` as the workflow contract.
4. Send durable document operations to the Backend API.
5. If the Backend is offline, stop or queue only when the host application explicitly owns an offline pending queue.

## Workspace Flow

Create a workspace:

```http
POST /v1/workspaces
```

```json
{
  "owner_user_id": "user_abcdef1234",
  "nickname": "Alice",
  "password": "workspace-password",
  "title": "Project Plan"
}
```

Read the tree:

```http
POST /v1/workspaces/{workspace_id}/tree
```

```json
{
  "password": "workspace-password"
}
```

The tree response includes `workspace_title`, `workspace_revision`, and each item's
`revision` and `order_key`. Workspace metadata has its own revision and is separate
from page/folder/table/board item titles.

Rename the workspace:

```http
PUT /v1/workspaces/{workspace_id}/settings
```

```json
{
  "password": "workspace-password",
  "title": "Project Knowledge Base",
  "expected_revision": 2
}
```

Use `workspace_revision` from the latest tree response. A settings conflict must be
re-read and surfaced; do not overwrite the newer workspace name.

Read one item:

```http
POST /v1/workspaces/{workspace_id}/items/{item_id}
```

Update one item:

```http
PUT /v1/workspaces/{workspace_id}/items/{item_id}
```

```json
{
  "password": "workspace-password",
  "title": "Updated title",
  "markdown": "# Updated title\n\nNew content.",
  "expected_revision": 3
}
```

Every item mutation must send `expected_revision` from a prior read. If the Backend returns `conflict`, stop writing, re-read the item and tree, and ask the caller how to merge. Never auto-rebase or resolve a conflict using timestamps.

Create a page, folder, table/workbook, or board:

```http
POST /v1/workspaces/{workspace_id}/items
```

```json
{
  "password": "workspace-password",
  "kind": "page",
  "title": "API Contract",
  "parent_id": "root"
}
```

Valid `kind` values are `page`, `folder`, `table`, and `board`. A table's structured
content contains its sheets/workbook. `parent_id` must point to a folder; omit it or
use `"root"` for top-level items.

Move, pin, trash, restore, and hard-delete:

```http
PUT /v1/workspaces/{workspace_id}/items/{item_id}/move
PUT /v1/workspaces/{workspace_id}/items/{item_id}/pin
PUT /v1/workspaces/{workspace_id}/items/{item_id}/trash
PUT /v1/workspaces/{workspace_id}/items/{item_id}/restore
POST /v1/workspaces/{workspace_id}/items/{item_id}/hard-delete
```

Move bodies include `parent_id`, `order_key`, and `expected_revision`; preserve the
server order key when the order is not intentionally changing. Hard-delete is only
allowed for items already in the trash and rejects non-empty folders. Trash/restore
operate on a folder subtree. `root` and `welcome` are protected system items.

Search, outline, patch:

```http
POST /v1/workspaces/{workspace_id}/search
POST /v1/workspaces/{workspace_id}/items/{item_id}/outline
POST /v1/workspaces/{workspace_id}/items/{item_id}/patch
```

Use patch `dry_run: true` before applying risky changes. This is the dry-run path. A dry run returns `preview_markdown` and must not persist changes. When applying a patch, send `expected_revision`.

History:

```http
POST /v1/workspaces/{workspace_id}/revisions
```

Revision history is append-only and bounded. To undo an event, read the current item,
then submit the explicit inverse update/move/pin/trash/restore with the current
`expected_revision`. There is no history rewrite or rebase endpoint.

Profile nickname:

```http
GET /v1/workspaces/{workspace_id}/profile
PUT /v1/workspaces/{workspace_id}/profile
```

Profile reads return a member `revision`. Profile updates require `password`,
`nickname`, and that value as `expected_revision`; on conflict, re-read instead of
overwriting another client.

## Operation Mapping

Paid workspace creation is a user-facing Stripe Checkout flow. Agents must not call
the free `POST /v1/workspaces` endpoint and then claim paid quota, invent a Checkout
Session ID, or place database credentials in Stripe metadata. A paid workspace is
created only through `/v1/billing/paid-workspace/checkout` followed by
`/v1/workspaces/paid/complete` after server-side payment verification.

- `profile.get` -> `GET /v1/workspaces/{workspace_id}/profile`
- `profile.update` -> `PUT /v1/workspaces/{workspace_id}/profile`
- `workspace.create` -> `POST /v1/workspaces`
- `workspace.unlock` -> password-bearing workspace calls
- `workspace.tree.get` -> `POST /v1/workspaces/{workspace_id}/tree`
- `workspace.settings.update` -> `PUT /v1/workspaces/{workspace_id}/settings`
- `workspace.item.get` -> `POST /v1/workspaces/{workspace_id}/items/{item_id}`
- `workspace.item.create` -> `POST /v1/workspaces/{workspace_id}/items`
- `workspace.item.set` -> `PUT /v1/workspaces/{workspace_id}/items/{item_id}`
- `workspace.item.move` -> `PUT /v1/workspaces/{workspace_id}/items/{item_id}/move`
- `workspace.item.pin` -> `PUT /v1/workspaces/{workspace_id}/items/{item_id}/pin`
- `workspace.item.trash` -> `PUT /v1/workspaces/{workspace_id}/items/{item_id}/trash`
- `workspace.item.restore` -> `PUT /v1/workspaces/{workspace_id}/items/{item_id}/restore`
- `workspace.item.hard_delete` -> `POST /v1/workspaces/{workspace_id}/items/{item_id}/hard-delete`
- `doc.search` -> `POST /v1/workspaces/{workspace_id}/search`
- `doc.outline` -> `POST /v1/workspaces/{workspace_id}/items/{item_id}/outline`
- `doc.patch` -> `POST /v1/workspaces/{workspace_id}/items/{item_id}/patch`
- `history.list` -> `POST /v1/workspaces/{workspace_id}/revisions`
- `history.revert` -> no direct endpoint; submit the explicit revision-guarded inverse item operation
- `identity.sign` -> sign mutating requests when the caller has a local identity keypair

## Signed Writes

When the caller holds a local P-256 keypair (same derivation as the browser extension), **attach** these JSON fields next to the normal password/business fields on mutating workspace calls:

```text
actor_user_id
public_key
signature
nonce
timestamp
body_hash
```

Signing details (canonical JSON for `body_hash`, line-separated UTF-8 message, `target_id` rules, DER+b64url signature) are normative in repo **`docs/agent.md`**. Reference algorithms live in `@justwork/security` (`canonicalJson`, `computeWriteBodyHash`, `signUtf8Message`, `buildWriteSigningMessage`).

Unsigned writes still succeed for MVP (password only); history records `signed: false` and omits actor attribution. Prefer signing whenever a keypair exists.

Do not invent `actor_user_id`, signatures, or public keys. If you cannot sign, say so explicitly.

## Error Handling

- `invalid_workspace_password`: stop and ask for the correct workspace password.
- `conflict`: stop writes, re-read state, and merge intentionally. Do not overwrite silently.
- Network offline or timeout: do not claim persistence. A GUI host may show `offline` and keep a local pending queue; a headless Agent should retry later or return a clear offline result.
- Permission failures: stop and ask the caller for updated workspace access.

## Security Notes

- Workspace payload is encrypted at rest.
- The Backend may decrypt during the request lifecycle, but must not persist the workspace password.
- Do not request private keys from users in chat.
- Do not fabricate document state when lock/auth checks fail.
