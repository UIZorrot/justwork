# Workspace Image Sync Design

## Goal

Support image upload inside the existing JustWork workbench without storing image bytes in the backend database or any backend cache.

The system should:

- store image bytes in each browser client's local `IndexedDB`
- relay image bytes through the backend only while clients are online
- keep the existing encrypted workspace document model unchanged except for image references inside Markdown
- let members of the same workspace see uploaded images after they sync

## Non-Goals

- permanent server-side image storage
- CDN delivery
- offline recovery after every client that held an image has gone away
- browser-to-browser direct networking without the backend
- media management beyond images

## Existing Context

The current codebase already has:

- a Vditor-based editor in `src/features/editor/vditor/create-editor.ts`
- a toolbar that includes `upload` in `src/features/editor/vditor/wysiwyg-toolbar.ts`
- a workspace workbench entry point in `src/pages/workbench/backend-workbench.ts`
- a FastAPI backend in `backend/app/main.py`
- backend persistence in `backend/app/db_gateway.py` for workspace records only
- encrypted workspace payloads that currently store Markdown text, not binary assets

This design keeps that shape. The backend stays responsible for workspace coordination, but not for durable image storage.

## Recommended Approach

Use a workspace-scoped asset relay:

1. The editor intercepts image insert, paste, and drop events.
2. The browser stores the image blob in local `IndexedDB`.
3. The browser writes a stable internal image reference into Markdown.
4. The browser sends the image manifest and bytes to the backend relay.
5. The backend forwards the asset to all online peers in the same workspace.
6. Each peer stores the same blob locally in its own `IndexedDB`.

This gives shared visibility with no backend image persistence.

## Data Model

### Asset Identity

Use content-addressed asset IDs where practical:

- `asset_id` = `sha256` of the raw image bytes
- `workspace_id` identifies the room
- `mime_type`, `size_bytes`, `width`, `height`, `filename` are metadata only

Using the hash as the asset ID avoids duplicate storage when the same image is uploaded twice.

### Local Storage

Store assets in browser `IndexedDB`, not `localStorage`.

Suggested stores:

- `assets`
  - key: `workspace_id + asset_id`
  - value: raw bytes plus metadata
- `asset_refs`
  - key: `workspace_id + asset_id`
  - value: reference count and last-seen timestamps
- `relay_outbox`
  - queue for assets that were inserted locally but not yet confirmed by peers

### Markdown Reference Format

Use an internal URI scheme in Markdown:

```md
![alt text](jwasset://<workspace_id>/<asset_id>)
```

The renderer resolves `jwasset://` to a local `blob:` URL at render time.

This keeps workspace documents portable inside the current system while avoiding server-hosted URLs.

## Browser Architecture

### 1. Asset Store

Create a browser-side asset store module, likely under `src/features/workspace/assets/`.

Responsibilities:

- persist image blobs in `IndexedDB`
- load blobs by `workspace_id` and `asset_id`
- compute and verify `sha256`
- maintain reference counts
- garbage-collect unreferenced assets after a grace period

### 2. Editor Integration

Extend `createWysiwygEditor` in `src/features/editor/vditor/create-editor.ts` to install a custom image pipeline.

Responsibilities:

- intercept toolbar upload
- intercept paste and drag-and-drop image input
- convert images into assets
- insert `jwasset://` references into the document
- trigger relay sync after local persistence succeeds

The current `upload` toolbar item can stay. Its behavior changes from "send to remote upload URL" to "store locally, then relay to peers".

### 3. Render Resolver

Add a resolver that converts `jwasset://...` references into renderable `blob:` URLs.

Responsibilities:

- resolve from local `IndexedDB`
- cache transient `blob:` URLs during the active session
- show a placeholder if the asset is missing locally
- request re-transfer from peers when a reference is missing

### 4. Workbench Session Orchestration

Extend `src/pages/workbench/backend-workbench.ts` so that a workspace session owns an asset relay client.

Responsibilities:

- connect to the backend relay when a workspace unlocks
- announce locally stored assets that belong to the open workspace
- listen for peer assets and store them locally
- disconnect and stop syncing when the workspace locks or closes

## Backend Architecture

Add a relay layer to `backend/app/main.py` without touching `backend/app/db_gateway.py`.

### Relay Session

The backend should expose a short-lived join step:

- client authenticates using the existing workspace session context
- backend issues an in-memory relay ticket
- client opens a WebSocket connection using that ticket

The relay ticket is not stored in the database.

### Relay Hub

Maintain an in-memory map of active workspace rooms:

- room key: `workspace_id`
- members: connected sockets
- no image bytes on disk
- no image bytes in the database

### Relay Behavior

The backend should forward these event types:

- `asset.manifest`
- `asset.chunk`
- `asset.request`
- `asset.ack`
- `asset.missing`
- `relay.join`
- `relay.leave`

Forwarding rules:

- broadcast to other connected clients in the same workspace
- do not persist payloads after delivery
- drop disconnected peers immediately
- return errors for invalid workspace access or malformed payloads

## Synchronization Flow

### Upload Flow

1. User inserts an image.
2. The browser reads the file blob.
3. The browser computes `sha256`.
4. The browser stores the blob and metadata in `IndexedDB`.
5. The browser inserts `jwasset://workspace_id/asset_id` into Markdown.
6. The browser sends `asset.manifest` and `asset.chunk` messages to the relay.
7. Peers receive the asset, store it locally, and ack completion.

### Render Flow

1. The Markdown renderer sees `jwasset://...`.
2. The resolver checks local `IndexedDB`.
3. If present, it creates a `blob:` URL and renders the image.
4. If missing, it renders a placeholder and emits `asset.request`.
5. Any peer that has the asset responds with the bytes.

### Join Flow

1. A client unlocks the workspace.
2. The workbench starts the relay client.
3. The client announces what assets it already has.
4. The relay fan-outs missing asset requests to peers.
5. Peers resend any requested assets they have locally.

## Cleanup Strategy

Because the backend does not cache assets, the browser must manage local growth carefully.

Rules:

- increment `asset_refs` when Markdown starts referencing an asset
- decrement `asset_refs` when the reference disappears from a saved document
- keep unreferenced assets for a short grace period to survive undo and reconnects
- delete assets whose ref count reaches zero and whose grace period expired

This keeps the local store bounded without requiring backend persistence.

## Error Handling

### Missing Asset

If a client opens a document whose `jwasset://` reference is not in local `IndexedDB`:

- show a broken-image placeholder
- retry request from peers
- keep the Markdown reference intact
- do not rewrite the document just because the blob is missing

### Relay Unavailable

If the backend relay is offline:

- local edits still persist to `IndexedDB`
- the document still saves with `jwasset://` references
- the UI should show that image sync is delayed

### Hash Mismatch

If a received asset's hash does not match the advertised `sha256`:

- discard the payload
- ask peers for retransmission
- do not store corrupted bytes

### Duplicate Asset

If the same `sha256` already exists locally:

- skip rewriting the bytes
- only update reference counters and timestamps

## Security Notes

- Keep image bytes out of backend persistence.
- Prefer end-to-end encryption later if the workspace model needs confidentiality for images as well as Markdown.
- Do not trust metadata from peers without verifying the byte hash locally.
- Keep relay tickets short-lived.

This design reduces backend cost, but it does not give server-side durability. That is an explicit tradeoff.

## Implementation Targets

Likely file changes:

- `src/features/editor/vditor/create-editor.ts`
- `src/pages/workbench/backend-workbench.ts`
- new browser asset modules under `src/features/workspace/assets/`
- `backend/app/main.py`
- `backend/app/models.py`
- tests for browser asset storage, relay sync, and missing-asset recovery

## Verification

The implementation should be considered done only when these pass:

- local browser test: upload image in one client, render in a second client in the same workspace
- local browser test: missing asset shows placeholder and recovers after relay resend
- backend test: relay accepts valid workspace join and rejects invalid access
- backend test: relay does not write image bytes to disk or database

