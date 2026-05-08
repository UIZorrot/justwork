# Markdown Collaboration with Vditor and Yjs

> **Goal:** make Markdown document editing collaborative, offline-safe, and refresh-safe without replacing Vditor or introducing any rich-text semantics into the sync layer.

**Architecture:** the workbench keeps Vditor as the editor UI, but the document body becomes a Yjs-backed Markdown string. The collaborative truth source is `Y.Text`; Vditor is only a local input/rendering surface. The backend no longer owns Markdown mutation logic for document bodies. Instead, it relays opaque Yjs updates, persists them, and broadcasts them to other connected clients.

**Tech Stack:** Vditor, Yjs, Chrome extension pages, a durable local browser store for CRDT state, the existing Python backend, WebSocket or an equivalent live relay channel, and TypeScript.

---

## Problem Statement

The current workbench save model is backend-first and UI-blocking. It causes typing lag, stale sidebar state, and data loss on refresh when the local draft path loses a race.

That model is wrong for collaborative editing. A collaborative text editor needs:

1. A local state that survives refresh and offline edits.
2. A merge model that can reconcile concurrent edits from multiple clients.
3. A backend that relays and persists collaborative updates without trying to interpret Markdown as application data.

The sync layer must treat Markdown as plain text, not as rich text or structured blocks. Characters such as `***`, fences, headings, lists, and link syntax are part of the canonical document and must survive round-trips unchanged unless the editor itself intentionally normalizes them.

## Goals

- Keep Vditor as the editor and preview surface.
- Sync only Markdown source text, not rich-text structure.
- Support concurrent editing from multiple clients through CRDT merging.
- Preserve local edits across refresh, reconnect, and temporary backend failure.
- Keep the backend as a relay and persistence layer, not a Markdown mutation engine.
- Avoid input lag and avoid blocking UI updates on backend round-trips.

## Non-Goals

- Replacing Vditor with another editor.
- Introducing a rich-text collaboration model.
- Rewriting non-body metadata flows into CRDTs in the first pass.
- Designing custom Markdown semantics or parsing rules in the sync layer.
- Changing the backend into an application-aware document transformer.

## Proposed Model

### 1. Yjs Owns the Markdown Body

Each collaborative document gets its own `Y.Doc` with a single `Y.Text` field that stores the full Markdown body.

Rules:

- `Y.Text` contains exact Markdown source text.
- The sync layer does not parse or interpret Markdown syntax.
- Vditor renders and edits the string, but it is not the source of truth.
- Remote updates are applied to `Y.Text`, then reflected back into Vditor.

This keeps the collaboration model simple: plain text with CRDT merging.

### 2. Vditor Becomes a Thin Adapter

The editor adapter translates between Vditor change events and `Y.Text` operations.

Rules:

- Local user edits update the Yjs document.
- Remote Yjs updates update Vditor.
- Programmatic editor updates must not loop back into the local change handler.
- The adapter must preserve the exact Markdown string emitted by the editor.
- The adapter should avoid full-document replacement on every keystroke when a smaller text diff can be applied safely.

The adapter is responsible for caret and selection stability during remote updates, but it does not add document semantics.

### 3. Local Durability Is Separate From Backend Sync

The local client must keep a durable copy of the current Yjs state so refresh does not lose edits.

Recommended boundary:

- Use synchronous `localStorage` or another synchronous browser-owned store for the local write-ahead snapshot of the Yjs state.
- Keep the latest local CRDT snapshot per document.
- Restore the Yjs document from that local snapshot before backend sync starts.

The exact storage implementation can be a thin wrapper over browser local storage or another synchronous browser-owned store, but it must not rely on an async best-effort queue as the only durability boundary.

### 4. Backend Relays Opaque CRDT Updates

The backend is not the Markdown source of truth. It stores and forwards opaque Yjs updates.

Backend responsibilities:

- Accept collaborative updates from connected clients.
- Persist the raw update stream or periodic snapshots.
- Broadcast incoming updates to other clients in the same workspace/document.
- Return enough history or state to bootstrap a new client.

Backend non-responsibilities:

- No Markdown parsing for collaborative body state.
- No content-aware merge logic for body text.
- No backend-side rewrite of user text.

### 5. Presence Is Separate

Cursor, selection, and online presence are awareness data, not document data.

Rules:

- Awareness updates are ephemeral.
- Awareness is not persisted as the document body.
- Losing awareness on reconnect is acceptable.
- Presence must not interfere with Markdown persistence.

## Data Flow

### Initial Load

1. Load the local durable Yjs snapshot for the active document.
2. Create or restore the in-memory `Y.Doc`.
3. Mount Vditor with the current Markdown string.
4. Connect to the backend relay channel.
5. Exchange sync state vectors and apply remote updates.
6. Render the merged document.

The local snapshot must be available before any remote update can overwrite the editor.

### Local Typing

1. Vditor emits a Markdown value change.
2. The adapter computes a text update against the current Yjs text.
3. The adapter applies the change to `Y.Text` inside a Yjs transaction.
4. The Yjs doc emits the resulting update.
5. The local durable snapshot is refreshed.
6. The update is queued for backend relay.

Typing must stay responsive even if the backend is slow or offline.

### Remote Update

1. Another client sends a Yjs update to the backend.
2. The backend relays that update to connected peers.
3. The local client applies the update to `Y.Text`.
4. The adapter pushes the new Markdown string into Vditor if the editor is not already showing that state.
5. Selection and caret state are restored when possible.

Remote updates must not trigger a save loop back into the local input path.

### Refresh and Reconnect

1. The page reloads or the backend connection drops.
2. The local durable snapshot is restored first.
3. Any queued local changes that were not yet acknowledged remain in the Yjs state.
4. When the backend becomes available again, the client resynchronizes using Yjs state vectors and update exchange.

Refresh must never discard the latest local Markdown text.

## Conflict Handling

Yjs resolves concurrent Markdown text edits at the CRDT layer.

Rules:

- Concurrent inserts and deletes are merged by Yjs.
- No backend revision conflict should be shown for Markdown body text in the collaborative path.
- If the adapter cannot map a Vditor edit cleanly, it should fall back to a full text patch against `Y.Text`, not to a backend overwrite.
- Metadata conflicts for non-body fields can continue to use the existing revisioned API until those fields are explicitly moved into collaboration.

## Markdown Fidelity Rules

The collaboration layer must treat the following as raw text and preserve them as text:

- headings such as `# Title`
- emphasis markers such as `*`, `**`, and `***`
- lists and checkboxes
- code fences and inline code
- links and image markdown
- tables

The adapter may reflect whatever normalization Vditor itself performs when it emits a Markdown string, but the sync layer must not add its own Markdown parser or formatter.

## Local Persistence Strategy

The local durability layer stores the latest recoverable Yjs state for each open document.

Implementation rules:

- Persist the document state as a CRDT snapshot or equivalent merged update payload.
- Restore from that snapshot before connecting to the backend.
- Keep the storage format opaque to the rest of the workbench.
- Do not use the backend save pipeline as the only persistence path.

The local snapshot is the safety net that prevents "typed text disappears on refresh."

## Backend Sync Strategy

The backend relay should be a collaborative transport, not a document business-logic engine.

Recommended shape:

- A snapshot/bootstrap endpoint for initial document state.
- A live bidirectional relay channel for updates.
- Server-side persistence of opaque Yjs update bytes or compacted snapshots.
- Optional server-side pruning/compaction when update history grows too large.

The transport can be WebSocket-first. If a fallback transport is needed later, it must preserve the same opaque update contract.

## Testing Strategy

Add tests for the Yjs Markdown path:

- A local Markdown edit survives refresh after the editor closes.
- Two clients editing the same document converge on the same Markdown text.
- A remote update does not re-enter the local input loop.
- Markdown markers such as `***`, fenced code, and list syntax survive round-trips unchanged.
- Offline edits are restored locally before reconnect.
- Presence data does not affect the persisted Markdown body.

Add browser-level tests for the core product flow:

- Open the same document in two pages.
- Type text in page A.
- Verify page B receives the change without a full refresh.
- Disconnect page A from the backend.
- Type more text.
- Refresh page A.
- Verify the latest local text is still present.

## Implementation Boundaries

Likely files to change:

- `src/features/editor/vditor/create-editor.ts`
- `src/features/editor/types.ts`
- `src/pages/workbench/backend-workbench.ts`
- `src/features/backend/client.ts`
- `backend/app/main.py`
- `backend/app/models.py`
- `backend/app/workspace_runtime.py`
- `src/shared/storage-keys.ts`

Likely new modules:

- `src/features/collaboration/yjs-markdown.ts`
- `src/features/collaboration/yjs-vditor-binding.ts`
- `src/features/collaboration/collab-storage.ts`
- `src/features/collaboration/collab-transport.ts`
- `backend/app/collab_store.py`

These modules should stay small and should separate editor adaptation, durability, and transport.

## Success Criteria

- Vditor remains the visible editor.
- The document body is collaborative Markdown text, not rich text.
- Refreshing the page no longer loses the latest local Markdown.
- Concurrent edits from multiple clients converge without manual backend conflict resolution.
- The backend relays and persists opaque CRDT updates, but never rewrites Markdown body content.
- The user never has to think about the sync layer while typing.
