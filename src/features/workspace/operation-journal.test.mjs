import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

function baseDoc(overrides) {
  return {
    id: "page-a",
    title: "Remote",
    markdown: "remote",
    content: null,
    revision: 3,
    updatedAt: "2026-06-14T00:00:00.000Z",
    lastVisitedAt: "",
    parentId: "root",
    pinned: false,
    inTrash: false,
    kind: "page",
    ...overrides,
  };
}

function baseState(docs = [baseDoc()]) {
  return {
    activeDocId: "page-a",
    workspaceTitle: "Workspace",
    workspaceDescription: "",
    docs,
  };
}

test("journal replays newer local edit operations over an older remote baseline", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/operation-journal.ts");

  const result = mod.applyWorkspaceOperationJournal(baseState(), [
    {
      id: "op-1",
      workspaceId: "ws-1",
      itemId: "page-a",
      kind: "edit",
      patch: { title: "Local", markdown: "local" },
      baseRevision: 3,
      localSeq: 1,
      createdAt: "2026-06-14T00:01:00.000Z",
    },
  ]);

  const doc = result.state.docs.find((entry) => entry.id === "page-a");
  assert.equal(doc.title, "Local");
  assert.equal(doc.markdown, "local");
  assert.equal(result.operations.length, 1);
});

test("journal preserves pending local edits when the remote version advances", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/operation-journal.ts");

  const result = mod.applyWorkspaceOperationJournal(baseState([
    baseDoc({
      revision: 4,
      updatedAt: "2026-06-14T00:02:00.000Z",
      title: "Remote newer",
      markdown: "remote newer",
    }),
  ]), [
    {
      id: "op-1",
      workspaceId: "ws-1",
      itemId: "page-a",
      kind: "edit",
      patch: { title: "Local stale", markdown: "local stale" },
      baseRevision: 3,
      localSeq: 1,
      createdAt: "2026-06-14T00:01:00.000Z",
    },
  ]);

  const doc = result.state.docs.find((entry) => entry.id === "page-a");
  assert.equal(doc.title, "Local stale");
  assert.equal(doc.markdown, "local stale");
  assert.equal(result.operations.length, 1);
});

test("journal replays delete operations over remote tree refreshes and clears confirmed operations", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/operation-journal.ts");

  const pendingTrash = mod.applyWorkspaceOperationJournal(baseState(), [
    {
      id: "op-1",
      workspaceId: "ws-1",
      itemId: "page-a",
      kind: "trash",
      localSeq: 1,
      createdAt: "2026-06-14T00:01:00.000Z",
    },
  ]);
  assert.equal(pendingTrash.state.docs.find((entry) => entry.id === "page-a").inTrash, true);
  assert.equal(pendingTrash.operations.length, 1);

  const confirmedTrash = mod.applyWorkspaceOperationJournal(baseState([
    baseDoc({ inTrash: true }),
  ]), pendingTrash.operations);
  assert.equal(confirmedTrash.state.docs.find((entry) => entry.id === "page-a").inTrash, true);
  assert.equal(confirmedTrash.operations.length, 0);

  const pendingHardDelete = mod.applyWorkspaceOperationJournal(baseState(), [
    {
      id: "op-2",
      workspaceId: "ws-1",
      itemId: "page-a",
      kind: "hard-delete",
      localSeq: 2,
      createdAt: "2026-06-14T00:02:00.000Z",
    },
  ]);
  assert.equal(pendingHardDelete.state.docs.some((entry) => entry.id === "page-a"), false);
  assert.equal(pendingHardDelete.operations.length, 1);
});

test("journal keeps pending local creates visible until the remote tree contains them", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/operation-journal.ts");
  const localSheet = baseDoc({
    id: "local-sheet-1",
    title: "New Sheet",
    kind: "table",
    content: { frozenHeader: false, columns: [], rows: [] },
    revision: 0,
    updatedAt: "2026-06-14T00:03:00.000Z",
  });

  const pending = mod.applyWorkspaceOperationJournal(baseState([baseDoc({ id: "root", kind: "folder" })]), [
    {
      id: "op-create",
      workspaceId: "ws-1",
      itemId: "local-sheet-1",
      kind: "create",
      doc: localSheet,
      localSeq: 1,
      createdAt: "2026-06-14T00:03:00.000Z",
    },
    {
      id: "op-edit",
      workspaceId: "ws-1",
      itemId: "local-sheet-1",
      kind: "edit",
      patch: { title: "Edited Sheet" },
      baseRevision: 0,
      localSeq: 2,
      createdAt: "2026-06-14T00:04:00.000Z",
    },
  ]);

  const doc = pending.state.docs.find((entry) => entry.id === "local-sheet-1");
  assert.equal(doc.title, "Edited Sheet");
  assert.equal(pending.state.activeDocId, "local-sheet-1");
  assert.equal(pending.operations.length, 2);

  const confirmed = mod.applyWorkspaceOperationJournal(baseState([
    baseDoc({ id: "root", kind: "folder" }),
    baseDoc({ id: "local-sheet-1", title: "Remote Sheet", kind: "table", revision: 0 }),
  ]), pending.operations);

  assert.equal(confirmed.state.docs.some((entry) => entry.id === "local-sheet-1"), true);
  assert.equal(confirmed.operations.map((operation) => operation.kind).includes("create"), false);
});
