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

test("journal drops stale local edits when the remote version is newer than the operation", async () => {
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
  assert.equal(doc.title, "Remote newer");
  assert.equal(doc.markdown, "remote newer");
  assert.equal(result.operations.length, 0);
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
