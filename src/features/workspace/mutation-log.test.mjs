import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

function baseDoc(overrides = {}) {
  return {
    id: "page-a",
    title: "Remote",
    markdown: "remote",
    content: null,
    revision: 3,
    updatedAt: "2026-07-05T00:00:00.000Z",
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

function createStorage() {
  const data = new Map();
  return {
    async get(key) {
      const keys = Array.isArray(key) ? key : [key];
      const result = {};
      for (const item of keys) {
        if (data.has(item)) result[item] = data.get(item);
      }
      return result;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        data.set(key, value);
      }
    },
  };
}

test("workspace mutation log merges pending edits per item while preserving the first base revision", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/mutation-log.ts");

  const first = mod.enqueueWorkspaceMutation([], {
    id: "m1",
    workspaceId: "ws-1",
    itemId: "page-a",
    kind: "edit",
    patch: { title: "Local title" },
    baseRevision: 3,
    clientSeq: 1,
    createdAt: "2026-07-05T00:01:00.000Z",
    status: "pending",
  });
  const second = mod.enqueueWorkspaceMutation(first, {
    id: "m2",
    workspaceId: "ws-1",
    itemId: "page-a",
    kind: "edit",
    patch: { markdown: "local body" },
    baseRevision: 4,
    clientSeq: 2,
    createdAt: "2026-07-05T00:02:00.000Z",
    status: "pending",
  });

  assert.equal(second.length, 1);
  assert.equal(second[0].id, "m1");
  assert.deepEqual(second[0].patch, { title: "Local title", markdown: "local body" });
  assert.equal(second[0].baseRevision, 3);
  assert.equal(second[0].clientSeq, 2);
});

test("workspace mutation log lets destructive mutations supersede pending edits for the same item", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/mutation-log.ts");

  const current = [
    {
      id: "m1",
      workspaceId: "ws-1",
      itemId: "page-a",
      kind: "edit",
      patch: { markdown: "local body" },
      baseRevision: 3,
      clientSeq: 1,
      createdAt: "2026-07-05T00:01:00.000Z",
      status: "pending",
    },
  ];
  const next = mod.enqueueWorkspaceMutation(current, {
    id: "m2",
    workspaceId: "ws-1",
    itemId: "page-a",
    kind: "trash",
    clientSeq: 2,
    createdAt: "2026-07-05T00:02:00.000Z",
    status: "pending",
  });

  assert.deepEqual(next.map((entry) => entry.kind), ["trash"]);
});

test("workspace mutation log replays local mutations over remote refreshes and drops stale edits", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/mutation-log.ts");

  const applied = mod.applyWorkspaceMutationLog(baseState(), [
    {
      id: "m1",
      workspaceId: "ws-1",
      itemId: "page-a",
      kind: "edit",
      patch: { title: "Local", markdown: "local" },
      baseRevision: 3,
      clientSeq: 1,
      createdAt: "2026-07-05T00:01:00.000Z",
      status: "pending",
    },
  ]);
  assert.equal(applied.state.docs.find((entry) => entry.id === "page-a").title, "Local");
  assert.equal(applied.mutations.length, 1);

  const dropped = mod.applyWorkspaceMutationLog(baseState([
    baseDoc({
      revision: 4,
      updatedAt: "2026-07-05T00:03:00.000Z",
      title: "Remote newer",
      markdown: "remote newer",
    }),
  ]), applied.mutations);
  assert.equal(dropped.state.docs.find((entry) => entry.id === "page-a").title, "Remote newer");
  assert.equal(dropped.mutations.length, 0);
});

test("workspace mutation conflict decision is centralized and timestamp based for now", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/mutation-log.ts");

  assert.equal(
    mod.resolveWorkspaceMutationConflict(
      { createdAt: "2026-07-05T00:02:00.000Z" },
      { updatedAt: "2026-07-05T00:01:00.000Z" },
    ).action,
    "retry-local",
  );
  assert.equal(
    mod.resolveWorkspaceMutationConflict(
      { createdAt: "2026-07-05T00:01:00.000Z" },
      { updatedAt: "2026-07-05T00:02:00.000Z" },
    ).action,
    "accept-remote",
  );
});

test("workspace mutation log persists through one explicit storage queue", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/mutation-log.ts");
  const storage = createStorage();

  await mod.enqueueStoredWorkspaceMutation(storage, {
    id: "m1",
    workspaceId: "ws-1",
    itemId: "page-a",
    kind: "edit",
    patch: { title: "Local" },
    baseRevision: 3,
    clientSeq: 1,
    createdAt: "2026-07-05T00:01:00.000Z",
    status: "pending",
  });
  await mod.enqueueStoredWorkspaceMutation(storage, {
    id: "m2",
    workspaceId: "ws-2",
    itemId: "page-b",
    kind: "edit",
    patch: { title: "Other" },
    baseRevision: 1,
    clientSeq: 1,
    createdAt: "2026-07-05T00:01:00.000Z",
    status: "pending",
  });

  const ws1 = await mod.loadWorkspaceMutationLog(storage, "ws-1");
  assert.equal(ws1.length, 1);
  assert.equal(ws1[0].workspaceId, "ws-1");

  await mod.removeStoredWorkspaceMutation(storage, "m1");
  assert.deepEqual(await mod.loadWorkspaceMutationLog(storage, "ws-1"), []);
});
