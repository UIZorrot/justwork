# Workspace Document Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** add first-class `Document`/`Table`/`Board` workspace item types while keeping the current Markdown document flow intact and preserving shared workspace collaboration features.

**Architecture:** keep the existing Markdown page path as the `Document` type, add a structured content model for `Table` and `Board`, and route each document kind to its own editor/view surface in the workbench. The backend becomes kind-aware so it can validate, persist, and migrate structured items without treating them as Markdown. Workspace membership, comments, messages, mentions, and tasks remain shared shell-level infrastructure.

**Tech Stack:** TypeScript, vanilla DOM workbench, Vite, Python FastAPI/Pydantic, unittest, node:test, Playwright-backed e2e scripts.

---

## File Map

- `backend/app/models.py`
  - extend workspace item request/response models so the backend can distinguish Markdown `Document` items from structured `Table` and `Board` items
  - add a structured `content` payload to non-Markdown items
- `backend/app/workspace_runtime.py`
  - normalize and migrate legacy `page` items into the new `Document` naming in the UI
  - create default payloads for `Table` and `Board`
  - keep Markdown auto-title stripping only for `Document`
- `backend/app/main.py`
  - route create/update/read operations by kind
  - keep search/outline/patch behavior Markdown-only in phase 1
- `backend/tests/test_workspace_runtime_migration.py`
  - cover migration, default payloads, and kind-specific normalization
- `backend/tests/test_backend_agent_api.py`
  - cover API-level create/update behavior for `Document`, `Table`, and `Board`
- `src/features/workspace/structured-document.ts`
  - shared structured-content primitives for `Table` and `Board`
- `src/features/workspace/table-state.ts`
  - table-specific data mutations and serialization helpers
- `src/features/workspace/board-state.ts`
  - board-specific data mutations and serialization helpers
- `src/features/workspace/table-view.ts`
  - DOM renderer and event wiring for the table document surface
- `src/features/workspace/board-view.ts`
  - DOM renderer and event wiring for the board document surface
- `src/features/workspace/structured-document.test.mjs`
  - source-contract tests for the shared structured model
- `src/features/workspace/table-state.test.mjs`
  - state mutation tests for table behavior
- `src/features/workspace/board-state.test.mjs`
  - state mutation tests for board behavior
- `src/pages/workbench/backend-workbench.ts`
  - branch the active editor/view by document kind
  - add `New Document`, `New Table`, and `New Board` creation actions
  - keep the existing Markdown collaboration path untouched for `Document`
- `src/pages/workbench/index.html`
  - add the three creation buttons and type-specific shell slots
- `src/pages/workbench/workbench.css`
  - style type badges, action row, and structured-view containers
- `src/shared/i18n.ts`
  - add labels for the three creation buttons and kind badges
- `scripts/workbench-backend-e2e.mjs`
  - verify creation, reopening, and list labeling for all three kinds

---

### Task 1: Make the backend kind-aware without breaking Markdown pages

**Files:**
- Modify: `backend/app/models.py`
- Modify: `backend/app/workspace_runtime.py`
- Modify: `backend/app/main.py`
- Modify: `backend/tests/test_workspace_runtime_migration.py`
- Modify: `backend/tests/test_backend_agent_api.py`

- [ ] **Step 1: Write the failing tests**

Add tests that lock the current Markdown behavior and the new kinds:

```python
def test_create_doc_supports_table_and_board_kinds():
    state = make_initial_workspace_state("Untitled")
    table = create_doc(state, "table", "Table 1", ROOT_FOLDER_ID)
    board = create_doc(state, "board", "Board 1", ROOT_FOLDER_ID)

    assert table["kind"] == "table"
    assert board["kind"] == "board"
    assert table["content"]["columns"][0]["name"] == "Name"
    assert board["content"]["groupByFieldId"] == "status"


def test_normalize_workspace_state_preserves_non_markdown_kinds():
    state = {
        "activeDocId": "table_1",
        "docs": [
            {"id": ROOT_FOLDER_ID, "kind": "folder", "title": "Root", "markdown": "", "revision": 0, "updatedAt": "2026-05-11T00:00:00Z", "lastVisitedAt": "2026-05-11T00:00:00Z", "parentId": None, "pinned": False, "inTrash": False},
            {"id": "table_1", "kind": "table", "title": "Ops Sheet", "markdown": "", "content": {"columns": [], "rows": []}, "revision": 0, "updatedAt": "2026-05-11T00:00:00Z", "lastVisitedAt": "2026-05-11T00:00:00Z", "parentId": ROOT_FOLDER_ID, "pinned": False, "inTrash": False},
        ],
    }

    next_state = normalize_workspace_state(state)
    assert next(doc for doc in next_state["docs"] if doc["id"] == "table_1")["kind"] == "table"
```

Add an API-level test that posts a table and board item through the workspace create endpoint and expects the response item to include the same kind and a structured `content` payload.

- [ ] **Step 2: Run the tests and confirm they fail**

Run:

```powershell
python -m unittest backend.tests.test_workspace_runtime_migration backend.tests.test_backend_agent_api -v
```

Expected: failures showing `table` / `board` kinds are rejected or missing `content`.

- [ ] **Step 3: Implement the minimal backend changes**

Update the backend models and runtime so:

- `WorkspaceItem.kind` and `WorkspaceTreeItem.kind` accept `page`, `table`, `board`, and `folder`
- `WorkspaceItem` gains `content: dict[str, Any] | None = None`
- `WorkspaceItemCreateRequest.kind` accepts `page|table|board|folder`
- `create_doc(...)` in `workspace_runtime.py` creates:
  - a Markdown `page` item with `markdown=""` and `content=None`
  - a `table` item with `markdown=""` and a default table content payload
  - a `board` item with `markdown=""` and a default board content payload
- `strip_auto_title_heading(...)` still applies only to `page`
- `update_doc(...)` continues to accept `markdown` for `page`
- `update_doc(...)` accepts `content` for `table` and `board`, and rejects `markdown` updates for those kinds
- `main.py` keeps `search`, `outline`, and `patch` Markdown-only for `page` during phase 1 and returns a 400 for `table` / `board`

Use `page` internally as the current Markdown `Document` kind so the existing Markdown path does not need a rename sweep.

- [ ] **Step 4: Run the tests and confirm they pass**

Run:

```powershell
python -m unittest backend.tests.test_workspace_runtime_migration backend.tests.test_backend_agent_api -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add backend/app/models.py backend/app/workspace_runtime.py backend/app/main.py backend/tests/test_workspace_runtime_migration.py backend/tests/test_backend_agent_api.py
git commit -m "feat: add backend support for table and board docs"
```

---

### Task 2: Add shared structured-document primitives for table and board

**Files:**
- Create: `src/features/workspace/structured-document.ts`
- Create: `src/features/workspace/structured-document.test.mjs`
- Modify: `src/features/editor/types.ts`

- [ ] **Step 1: Write the failing tests**

Add a source-contract test that expects the shared module to exist and export helpers for both structured kinds:

```javascript
import assert from "node:assert/strict";
import test from "node:test";

test("structured document module exports the shared structured kinds", async () => {
  const mod = await importTsModule("src/features/workspace/structured-document.ts");
  assert.deepEqual(mod.DOCUMENT_KINDS, {
    page: "page",
    table: "table",
    board: "board",
  });
  assert.equal(typeof mod.createDefaultTableContent, "function");
  assert.equal(typeof mod.createDefaultBoardContent, "function");
});
```

Make the editor type file compile against the new notion that the workbench can mount either a Markdown editor or a structured document surface.

- [ ] **Step 2: Run the tests and confirm they fail**

Run:

```powershell
node --test src/features/workspace/structured-document.test.mjs
```

Expected: module-not-found or missing export failures.

- [ ] **Step 3: Implement the shared primitives**

Create `structured-document.ts` with:

- `DOCUMENT_KINDS`
- `StructuredDocumentKind`
- `StructuredFieldType`
- `StructuredFieldDefinition`
- `StructuredRecord`
- `createDefaultTableContent()`
- `createDefaultBoardContent()`
- `isStructuredDocumentKind(kind)`

The shared module should define the common record/field model once and reuse it from table and board code.

Update `src/features/editor/types.ts` only as far as needed to let the workbench type its editor/view union cleanly. Do not force the Markdown editor to understand structured content.

- [ ] **Step 4: Run the tests and confirm they pass**

Run:

```powershell
node --test src/features/workspace/structured-document.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/features/workspace/structured-document.ts src/features/workspace/structured-document.test.mjs src/features/editor/types.ts
git commit -m "feat: add shared structured document primitives"
```

---

### Task 3: Build the Table document state and view

**Files:**
- Create: `src/features/workspace/table-state.ts`
- Create: `src/features/workspace/table-state.test.mjs`
- Create: `src/features/workspace/table-view.ts`
- Modify: `src/pages/workbench/backend-workbench.ts`

- [ ] **Step 1: Write the failing tests**

Add state tests that prove the table shape supports rows, columns, and edits:

```javascript
test("table state creates a default Name column and supports cell edits", async () => {
  const mod = await importTsModule("src/features/workspace/table-state.ts");
  const table = mod.createDefaultTableContent();

  assert.equal(table.columns[0].name, "Name");
  assert.equal(table.rows.length, 0);

  const next = mod.addTableRow(table);
  assert.equal(next.rows.length, 1);
  assert.equal(next.rows[0].cells[table.columns[0].id], "");
});
```

Add a source-contract test that expects the workbench to branch on `kind === "table"` and mount a table surface instead of Vditor.

- [ ] **Step 2: Run the tests and confirm they fail**

Run:

```powershell
node --test src/features/workspace/table-state.test.mjs
```

Expected: missing module or missing function failures.

- [ ] **Step 3: Implement the Table model and view**

Create `table-state.ts` with:

- `createDefaultTableContent()`
- `addTableColumn(...)`
- `addTableRow(...)`
- `updateTableCell(...)`
- `renameTableColumn(...)`
- `serializeTableContent(...)` and `parseTableContent(...)` if the workbench needs a stable wire format

Create `table-view.ts` with a DOM surface that:

- renders a header row and editable cells
- exposes an `onChange(content)` callback
- keeps the table view isolated from the Markdown editor
- shows an empty state and an `Add row` action when there are no rows

Update `backend-workbench.ts` so a selected `table` item mounts the table view, and the normal Markdown collaboration path is only used for `page`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run:

```powershell
node --test src/features/workspace/table-state.test.mjs
```

Then run:

```powershell
yarn typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/features/workspace/table-state.ts src/features/workspace/table-state.test.mjs src/features/workspace/table-view.ts src/pages/workbench/backend-workbench.ts
git commit -m "feat: add table document surface"
```

---

### Task 4: Build the Board document state and view

**Files:**
- Create: `src/features/workspace/board-state.ts`
- Create: `src/features/workspace/board-state.test.mjs`
- Create: `src/features/workspace/board-view.ts`
- Modify: `src/pages/workbench/backend-workbench.ts`

- [ ] **Step 1: Write the failing tests**

Add state tests that prove the board shape supports grouped cards and field-driven lanes:

```javascript
test("board state creates a default status field and supports moving cards", async () => {
  const mod = await importTsModule("src/features/workspace/board-state.ts");
  const board = mod.createDefaultBoardContent();

  assert.equal(board.groupByFieldId, "status");
  assert.equal(board.cards.length, 0);

  const next = mod.addBoardCard(board);
  assert.equal(next.cards.length, 1);
});
```

Add a source-contract test that expects the workbench to branch on `kind === "board"` and mount a board surface instead of Vditor.

- [ ] **Step 2: Run the tests and confirm they fail**

Run:

```powershell
node --test src/features/workspace/board-state.test.mjs
```

Expected: missing module or missing function failures.

- [ ] **Step 3: Implement the Board model and view**

Create `board-state.ts` with:

- `createDefaultBoardContent()`
- `addBoardCard(...)`
- `moveBoardCard(...)`
- `updateBoardCardField(...)`
- `setBoardGroupByField(...)`
- `serializeBoardContent(...)` and `parseBoardContent(...)` if needed for persistence

Create `board-view.ts` with a DOM surface that:

- renders lanes based on the grouped field
- exposes an `onChange(content)` callback
- allows cards to move between lanes
- shows an empty state and an `Add card` action when there are no cards

Update `backend-workbench.ts` so a selected `board` item mounts the board view, and the normal Markdown collaboration path is only used for `page`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run:

```powershell
node --test src/features/workspace/board-state.test.mjs
```

Then run:

```powershell
yarn typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/features/workspace/board-state.ts src/features/workspace/board-state.test.mjs src/features/workspace/board-view.ts src/pages/workbench/backend-workbench.ts
git commit -m "feat: add board document surface"
```

---

### Task 5: Wire the workbench creation UI, kind badges, and regression coverage

**Files:**
- Modify: `src/pages/workbench/backend-workbench.ts`
- Modify: `src/pages/workbench/index.html`
- Modify: `src/pages/workbench/workbench.css`
- Modify: `src/shared/i18n.ts`
- Modify: `scripts/workbench-backend-e2e.mjs`
- Modify: `backend/tests/test_backend_agent_api.py`

- [ ] **Step 1: Write the failing tests**

Add a source-contract test or e2e assertion that the workbench exposes three creation actions:

- `New Document`
- `New Table`
- `New Board`

Add an e2e assertion that:

1. creating a Markdown document still opens the existing Vditor surface
2. creating a Table document opens the table surface
3. creating a Board document opens the board surface
4. the document list shows a visible kind badge or label for each item
5. reopening the workspace preserves the kind and reopens the correct surface

The e2e script should live in `scripts/workbench-backend-e2e.mjs` so it runs through the existing backend-backed browser flow.

- [ ] **Step 2: Run the tests and confirm they fail**

Run:

```powershell
yarn test:e2e:backend
```

Expected: missing buttons, missing type badges, or wrong surface selection.

- [ ] **Step 3: Implement the workbench wiring**

Update the workbench shell so:

- `index.html` contains the three creation buttons in the creation area
- `workbench.css` styles a visible kind badge or icon for each item in the tree/list
- `i18n.ts` adds strings for the three kinds and the creation actions
- `backend-workbench.ts` routes `page` items to the current Markdown/Vditor flow, `table` items to the table surface, and `board` items to the board surface
- `backend-workbench.ts` creates new items through three explicit actions instead of a single generic "new" action
- `backend-workbench.ts` keeps the existing workspace member/message shell intact and does not let the new kinds break it

Keep the Markdown path untouched for the existing document type. The new types should be additive and visible, not a rename of the current page editor.

- [ ] **Step 4: Run the tests and confirm they pass**

Run:

```powershell
yarn typecheck
yarn test:e2e:backend
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/pages/workbench/backend-workbench.ts src/pages/workbench/index.html src/pages/workbench/workbench.css src/shared/i18n.ts scripts/workbench-backend-e2e.mjs backend/tests/test_backend_agent_api.py
git commit -m "feat: add document type creation and routing"
```

---

## Self-Review Checklist

- Markdown `Document` remains the existing `page` path and is not removed.
- `Table` and `Board` are first-class new kinds, not Markdown aliases.
- Backend model changes include a structured `content` payload for non-Markdown items.
- Markdown-only operations stay Markdown-only in phase 1.
- The workbench creation UI exposes three explicit actions.
- The plan has concrete tests, concrete files, and concrete verification commands.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-11-workspace-document-types.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
