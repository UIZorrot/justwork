# Backend Document Sync Redesign

> **Goal:** Make workbench editing durable under refresh, offline, and slow backend conditions by moving document state to a local write-ahead journal and treating backend writes as background synchronization.

**Architecture:** The workbench becomes local-first. Every edit is written immediately to a durable local journal, then queued for backend synchronization through a separate outbox. The UI renders from in-memory state overlaid with the local journal, while the backend remains the canonical remote replica that is updated asynchronously and repaired in the background.

**Tech Stack:** Chrome extension pages, `chrome.storage.local`, `localStorage` for synchronous local journaling, the existing backend HTTP API, TypeScript, and the current workbench/editor runtime.

---

## Problem Statement

The current save path still depends on asynchronous storage mirroring and backend round-trips. That creates two unacceptable behaviors:

1. Fresh edits can disappear on refresh if the local draft has not finished mirroring.
2. The editor and sidebar can wait on backend refreshes even when the user expects a pure client-side interaction.

The redesign must guarantee that the user's latest text is recoverable after refresh even if backend sync has not happened yet.

## Goals

- Preserve the latest local text across page refreshes.
- Let typing stay responsive when the backend is slow or offline.
- Keep backend sync eventually consistent, not user-blocking.
- Avoid overwriting in-progress local edits when background refreshes arrive.
- Keep the implementation understandable and testable.

## Non-Goals

- Real-time multi-user collaboration.
- Rich merge UI for conflicting branches of the same document.
- Cross-device draft replication.
- Replacing the backend API or encrypted workspace model.

## Proposed Model

### 1. Local Write-Ahead Journal

Use a synchronous browser-owned journal for unsaved workbench text. The journal stores the latest full snapshot for each edited document, plus a monotonic sequence number and timestamp.

This journal is the durability boundary. If the page refreshes, the next load must be able to reconstruct the unsaved text from this journal before any backend request completes.

Implementation rule:

- Local journaling happens in the same input path that updates in-memory UI state.
- Journal writes must not wait for backend completion.
- Journal cleanup happens only after a backend commit is acknowledged and the journal entry is no longer needed.

### 2. Background Outbox

Backend writes move into a single per-document outbox entry that always represents the latest local snapshot for that document.

Implementation rule:

- Do not enqueue one network write per keystroke.
- Merge successive edits to the same document into one pending outbox record.
- Flush outbox records sequentially.
- Use the document revision that is current when the flush begins, not the revision captured by the original keystroke.

### 3. Overlay on Bootstrap

On page load:

1. Load the local journal first.
2. Load the backend tree and active document metadata.
3. Overlay journal content onto matching backend docs.
4. Render immediately.
5. Start background outbox flushing and background tree repair.

This ensures the user sees their latest draft before any slow network path can override it.

## Data Flow

### Editing

When the user types:

1. Update in-memory UI state.
2. Write the full local draft snapshot into the local journal synchronously.
3. Merge the doc into the outbox as the latest pending remote write.
4. Schedule backend flush after a short idle delay.

The UI must not depend on the backend commit finishing before it reflects the edit.

### Saving

When the outbox flush runs:

1. Read the current doc revision from in-memory state.
2. Send the latest merged patch or full snapshot to the backend.
3. On success, update only the canonical metadata that changed remotely.
4. Keep the local journal until the backend snapshot has caught up or until the entry is explicitly acknowledged as safe to clear.

### Refresh and Reopen

When the workbench reloads:

1. Read the local journal synchronously.
2. Rebuild the active doc and sidebar from the journal plus backend tree.
3. If a journal entry exists for the active doc, prefer it over the backend copy.
4. Do not require a backend save to preserve the local text.

## Conflict Handling

- If the backend returns a revision conflict, keep the local journal entry.
- Mark the document as needing reconciliation, but do not discard local text.
- If the backend is offline or returns transient failures, keep the outbox entry and retry later.
- Background tree refreshes must never overwrite a dirty local draft with a stale backend copy.

## Cleanup Rules

- Remove journal entries only after a backend commit succeeds and the local draft is no longer dirty.
- Remove outbox entries only after the backend has acknowledged the latest snapshot.
- Prune deleted documents from both the journal and the outbox.
- Keep the journal bounded to the current workspace and remove abandoned workspace records when a workspace is hard-deleted or switched away permanently.

## Testing Strategy

Add tests for the local journal and outbox behavior:

- A fresh edit survives a simulated page reload before backend sync finishes.
- Two quick edits to the same document collapse into one outbox record.
- A backend conflict keeps the local draft intact.
- Offline edits remain recoverable after refresh.
- A background refresh does not overwrite a dirty draft.

Add a browser-level regression test for the core user flow:

- Type text.
- Refresh the page.
- Reopen the same document.
- Verify the latest local text is still present.

## Implementation Boundaries

Likely files to change:

- `src/pages/workbench/backend-workbench.ts`
- `src/features/workspace/offline-queue.ts`
- `src/background/index.ts`
- `src/shared/storage-keys.ts`
- `backend/tests/test_backend_agent_api.py`

Likely new modules:

- `src/features/workspace/draft-journal.ts`
- `src/features/workspace/outbox.ts`

These modules should stay small and focused. The workbench should orchestrate them, not reimplement persistence policy inline.

## Success Criteria

- Refreshing the workbench no longer loses unsaved typing.
- Typing stays responsive even when backend sync is delayed.
- Backend sync still converges eventually without blocking the UI.
- Tests prove that local recovery works before any backend round-trip completes.
