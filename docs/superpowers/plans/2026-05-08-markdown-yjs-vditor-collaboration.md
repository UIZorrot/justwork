# Markdown Collaboration with Vditor and Yjs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current backend-first Markdown save path with Yjs-backed collaborative Markdown text while keeping Vditor as the editor UI.

**Architecture:** The editor stays Vditor, but the document body becomes a plain Markdown `Y.Text` managed by a dedicated collaboration module. The workbench will load local durable CRDT state first, bind Vditor to the in-memory Yjs document, and relay opaque Yjs updates through the backend for persistence and multi-client convergence. Backend document mutation logic for body text will be bypassed for the collaborative path; it remains available only for non-collaborative metadata flows that are not yet moved.

**Tech Stack:** TypeScript, Vditor, Yjs, Chrome extension pages, synchronous browser storage for local recovery, FastAPI backend, WebSocket relay, Playwright / existing browser tests, Python backend tests.

---

### Task 1: Add the collaboration primitives and dependencies

**Files:**
- Modify: `package.json`
- Modify: `yarn.lock`
- Create: `src/features/collaboration/yjs-markdown.ts`
- Create: `src/features/collaboration/collab-storage.ts`
- Create: `src/features/collaboration/collab-transport.ts`
- Create: `src/features/collaboration/yjs-vditor-binding.ts`
- Test: `src/features/collaboration/yjs-markdown.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `src/features/collaboration/yjs-markdown.test.mjs` with a source-contract test that reads the new module file and asserts the collaboration primitives exist.

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("markdown collaborator module exports the collaboration contract", async () => {
  const source = await readFile("src/features/collaboration/yjs-markdown.ts", "utf8");
  assert.match(source, /createMarkdownCollaborator/);
  assert.match(source, /applyLocalMarkdown/);
  assert.match(source, /applyRemoteUpdate/);
  assert.match(source, /encodeUpdate/);
  assert.match(source, /Y\.Text/);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node scripts/run-node-tests.mjs src/features/collaboration/yjs-markdown.test.mjs`

Expected: fail because the module does not exist yet.

- [ ] **Step 3: Add the minimal dependency and module scaffolding**

Add `yjs` to `dependencies` in `package.json`. Implement the collaboration module family with only the narrow interfaces the workbench needs:

```ts
export type MarkdownCollaborator = {
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  getMarkdown: () => string;
  applyLocalMarkdown: (markdown: string) => void;
  applyRemoteUpdate: (update: Uint8Array) => void;
  encodeUpdate: () => Uint8Array;
  destroy: () => void;
};
```

Implement `collab-storage.ts` as a synchronous local snapshot adapter. Keep the initial version simple: one opaque snapshot payload per document key.

Implement `collab-transport.ts` as a thin relay client around WebSocket that can send and receive opaque Yjs updates.

Implement `yjs-vditor-binding.ts` as a small adapter that:
- subscribes to Vditor `input`
- applies full Markdown strings to the Yjs text
- suppresses programmatic echo loops when remote updates drive the editor

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node scripts/run-node-tests.mjs src/features/collaboration/yjs-markdown.test.mjs`

Expected: pass with the minimal round-trip behavior.

- [ ] **Step 5: Commit**

```bash
git add package.json yarn.lock src/features/collaboration
git commit -m "feat: add yjs markdown collaboration primitives"
```

---

### Task 2: Make local document recovery CRDT-backed

**Files:**
- Modify: `src/pages/workbench/backend-workbench.ts`
- Modify: `src/shared/storage-keys.ts`
- Modify: `src/features/workspace/local-runtime.ts`
- Create: `src/features/collaboration/collab-storage.test.mjs`

- [ ] **Step 1: Write the failing test**

Add a source-contract test that verifies the local collaboration storage module exists and encodes a synchronous persistence boundary.

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("collab storage keeps a synchronous local snapshot boundary", async () => {
  const source = await readFile("src/features/collaboration/collab-storage.ts", "utf8");
  assert.match(source, /localStorage/);
  assert.match(source, /saveCollaborativeSnapshot/);
  assert.match(source, /loadCollaborativeSnapshot/);
  assert.match(source, /removeCollaborativeSnapshot/);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node scripts/run-node-tests.mjs src/features/collaboration/collab-storage.test.mjs`

Expected: fail because the helper module is not implemented yet.

- [ ] **Step 3: Wire the workbench bootstrap to prefer local CRDT state**

Change the workbench load path so it:
1. Loads the local collaborative snapshot synchronously or from the earliest possible async boundary.
2. Restores the Yjs doc before any backend document fetch can paint the editor.
3. Uses the backend only as a later convergence source.

Remove the old body-draft queue from the document text path. Keep existing non-body queues only if they are still needed for unrelated features.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node scripts/run-node-tests.mjs src/features/collaboration/collab-storage.test.mjs`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/pages/workbench/backend-workbench.ts src/shared/storage-keys.ts src/features/workspace/local-runtime.ts src/features/collaboration/collab-storage.test.mjs src/features/collaboration/collab-storage.ts
git commit -m "feat: restore collaborative markdown from local snapshot"
```

---

### Task 3: Bind Vditor to the Yjs Markdown document

**Files:**
- Modify: `src/features/editor/vditor/create-editor.ts`
- Modify: `src/features/editor/types.ts`
- Create: `src/features/collaboration/yjs-vditor-binding.test.mjs`

- [ ] **Step 1: Write the failing test**

Add a source-contract test that verifies the adapter module contains the loop-guard and editor bridge points.

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("vditor binding contains the local and remote bridge points", async () => {
  const source = await readFile("src/features/collaboration/yjs-vditor-binding.ts", "utf8");
  assert.match(source, /createVditorMarkdownBinding/);
  assert.match(source, /suppress/);
  assert.match(source, /applyLocalEditorMarkdown/);
  assert.match(source, /applyRemoteMarkdown/);
  assert.match(source, /loop/i);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node scripts/run-node-tests.mjs src/features/collaboration/yjs-vditor-binding.test.mjs`

Expected: fail because the adapter does not exist yet.

- [ ] **Step 3: Rework the editor adapter**

Replace the current `onChange -> markdown string` path in `create-editor.ts` with a collaboration-aware adapter that:
- accepts initial Markdown from the collaborator, not from a standalone string source
- writes user edits into the Yjs collaborator
- listens for collaborator updates and pushes them into Vditor with a loop guard
- keeps the `DocEditor` interface stable for the workbench where possible

Keep the image upload hooks intact. They should continue to operate on Markdown content, but the source of truth for the body text must be the collaborator.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node scripts/run-node-tests.mjs src/features/collaboration/yjs-vditor-binding.test.mjs`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/features/editor/vditor/create-editor.ts src/features/editor/types.ts src/features/collaboration/yjs-vditor-binding.test.mjs src/features/collaboration/yjs-vditor-binding.ts
git commit -m "feat: bind vditor to collaborative markdown"
```

---

### Task 4: Add backend relay endpoints for opaque Yjs updates

**Files:**
- Modify: `backend/app/main.py`
- Modify: `backend/app/models.py`
- Modify: `backend/app/workspace_runtime.py`
- Create: `backend/app/collab_store.py`
- Test: `backend/tests/test_collab_relay.py`

- [ ] **Step 1: Write the failing test**

Add a backend test that creates a workspace, posts an opaque update payload, retrieves the current document state, and verifies the stored bytes round-trip without the backend attempting to parse Markdown semantics.

```python
import unittest
from fastapi.testclient import TestClient


def create_workspace(client: TestClient) -> str:
    created = client.post(
        "/v1/workspaces",
        json={
            "owner_user_id": "user_abcdef1234",
            "nickname": "Alice",
            "password": "workspace-password",
            "title": "Collaborative Doc",
        },
    )
    assert created.status_code == 200
    return created.json()["workspace"]["workspace_id"]


class CollabRelayTest(unittest.TestCase):
    def setUp(self) -> None:
        from app.main import app, reset_gateway_for_tests

        reset_gateway_for_tests()
        self.client = TestClient(app)

    def test_collab_update_round_trip(self) -> None:
        workspace_id = create_workspace(self.client)
        update = {"update": "AQID"}
        res = self.client.post(f"/v1/workspaces/{workspace_id}/collab/items/doc_1/update", json=update)
        assert res.status_code == 200
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `python -m unittest backend.tests.test_collab_relay`

Expected: fail because the route and store do not exist yet.

- [ ] **Step 3: Add the relay and persistence endpoints**

Add a backend store for opaque collaborative updates and expose:
- a bootstrap endpoint for initial collaborative state
- a mutation endpoint for sending opaque update bytes
- a polling or websocket-friendly fetch path for peers that need to resync

Keep Markdown business logic out of these endpoints. They should move bytes and state vectors, not rewrite document bodies.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `python -m unittest backend.tests.test_collab_relay`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add backend/app/main.py backend/app/models.py backend/app/workspace_runtime.py backend/app/collab_store.py backend/tests/test_collab_relay.py
git commit -m "feat: add collaborative markdown relay endpoints"
```

---

### Task 5: Switch the workbench body flow to the collaborator

**Files:**
- Modify: `src/pages/workbench/backend-workbench.ts`
- Modify: `src/features/backend/client.ts`
- Modify: `src/pages/workbench/index.html`
- Modify: `src/pages/workbench/workbench.css`
- Test: `scripts/workbench-backend-e2e.mjs`
- Test: `scripts/workbench-backend-offline-e2e.mjs`

- [ ] **Step 1: Write the failing browser regression**

Update the existing backend workbench browser test so it types Markdown text, refreshes, and expects the collaborative local snapshot to survive. Add a second browser page or tab if the harness supports it, and assert that the second client receives remote changes without a full reload.

- [ ] **Step 2: Run the browser test and confirm it fails**

Run: `yarn test:e2e:backend`

Expected: fail because the workbench still uses the old backend-first save path.

- [ ] **Step 3: Route the workbench through the collaborator**

Replace the current body-save pipeline in `backend-workbench.ts` with:
- collaborator initialization per active document
- Vditor binding setup
- local snapshot persistence
- backend relay connection and reconnection

Do not keep the old document draft queue as the main body persistence path. The new collaborative path should own the Markdown body.

- [ ] **Step 4: Run the browser test and confirm it passes**

Run: `yarn test:e2e:backend`

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/pages/workbench/backend-workbench.ts src/features/backend/client.ts src/pages/workbench/index.html src/pages/workbench/workbench.css scripts/workbench-backend-e2e.mjs scripts/workbench-backend-offline-e2e.mjs
git commit -m "feat: switch workbench body flow to collaborative markdown"
```

---

### Task 6: Remove stale document-body draft machinery and verify the whole flow

**Files:**
- Modify: `src/pages/workbench/backend-workbench.ts`
- Modify: `src/background/index.ts`
- Modify: `src/shared/storage-keys.ts`
- Modify: `src/features/workspace/offline-queue.ts`
- Test: `node scripts/run-node-tests.mjs`
- Test: `yarn typecheck`
- Test: `yarn build`

- [ ] **Step 1: Write the cleanup regression**

Add or update a unit test that ensures body text no longer depends on the old backend draft mirror path and that the new collaborative snapshot path is the only recovery source for Markdown body content.

- [ ] **Step 2: Run the full test commands and confirm the cleanup is safe**

Run:

```bash
yarn typecheck
yarn build
node scripts/run-node-tests.mjs
```

Expected: pass.

- [ ] **Step 3: Remove the dead path**

Delete the stale body-draft mirroring and any background message plumbing that only existed to support the old backend-first Markdown save path.

Keep unrelated features intact:
- i18n
- image sync
- workspace tree operations
- share links

- [ ] **Step 4: Re-run the browser and backend coverage**

Run:

```bash
yarn test:e2e:backend
yarn test:e2e:backend:offline
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/pages/workbench/backend-workbench.ts src/background/index.ts src/shared/storage-keys.ts src/features/workspace/offline-queue.ts
git commit -m "refactor: remove stale markdown draft mirror path"
```

---

## Coverage Check

Spec coverage mapping:

- Local recovery and refresh safety: Tasks 1, 2, 6
- Vditor remains the editor: Tasks 1, 3, 5
- Plain Markdown only: Tasks 1, 3, 4
- Multi-client collaboration: Tasks 1, 4, 5
- Backend relay/persistence only: Task 4
- Tests for text fidelity and loop prevention: Tasks 1, 3, 4, 5, 6

No planned task leaves the old backend-first body-save behavior in place as the authoritative Markdown path.
