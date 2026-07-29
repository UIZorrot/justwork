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

test("workspace mutation log keeps pending local edits over newer remote refreshes", async () => {
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

  const retained = mod.applyWorkspaceMutationLog(baseState([
    baseDoc({
      revision: 4,
      updatedAt: "2026-07-05T00:03:00.000Z",
      title: "Remote newer",
      markdown: "remote newer",
    }),
  ]), applied.mutations);
  assert.equal(retained.state.docs.find((entry) => entry.id === "page-a").title, "Local");
  assert.equal(retained.state.docs.find((entry) => entry.id === "page-a").markdown, "local");
  assert.equal(retained.state.docs.find((entry) => entry.id === "page-a").revision, 3);
  assert.equal(retained.mutations.length, 1);
});

test("workspace mutation log keeps move and pin operations over stale tree refreshes until acknowledged", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/mutation-log.ts");
  const mutations = [
    {
      id: "move-1",
      workspaceId: "ws-1",
      itemId: "page-a",
      kind: "move",
      patch: { parentId: "folder-a" },
      baseRevision: 3,
      clientSeq: 1,
      createdAt: "2026-07-05T00:01:00.000Z",
      status: "pending",
    },
    {
      id: "pin-1",
      workspaceId: "ws-1",
      itemId: "page-a",
      kind: "pin",
      patch: { pinned: true },
      baseRevision: 3,
      clientSeq: 2,
      createdAt: "2026-07-05T00:01:01.000Z",
      status: "pending",
    },
  ];

  const replayed = mod.applyWorkspaceMutationLog(baseState(), mutations);
  const local = replayed.state.docs.find((entry) => entry.id === "page-a");
  assert.equal(local.parentId, "folder-a");
  assert.equal(local.pinned, true);
  assert.equal(replayed.mutations.length, 2);

  const acknowledged = mod.applyWorkspaceMutationLog(baseState([
    baseDoc({ parentId: "folder-a", pinned: true, revision: 4 }),
  ]), replayed.mutations);
  assert.equal(acknowledged.mutations.length, 0);
});

test("a newer structural operation replaces an older pending operation with its own mutation id", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/mutation-log.ts");
  const first = mod.enqueueWorkspaceMutation([], {
    id: "move-1",
    workspaceId: "ws-1",
    itemId: "page-a",
    kind: "move",
    patch: { parentId: "folder-a" },
    baseRevision: 3,
    clientSeq: 1,
    createdAt: "2026-07-05T00:01:00.000Z",
    status: "pending",
  });
  const second = mod.enqueueWorkspaceMutation(first, {
    id: "move-2",
    workspaceId: "ws-1",
    itemId: "page-a",
    kind: "move",
    patch: { parentId: "folder-b" },
    baseRevision: 3,
    clientSeq: 2,
    createdAt: "2026-07-05T00:01:01.000Z",
    status: "pending",
  });

  assert.equal(second.length, 1);
  assert.equal(second[0].id, "move-2");
  assert.equal(second[0].patch.parentId, "folder-b");
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

test("workspace mutation log does not lose concurrent writes", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/mutation-log.ts");
  const storage = createStorage();
  await Promise.all(Array.from({ length: 12 }, (_, index) => mod.enqueueStoredWorkspaceMutation(storage, {
    id: `m${index}`,
    workspaceId: "ws-1",
    itemId: `page-${index}`,
    kind: "edit",
    patch: { title: `Title ${index}` },
    baseRevision: 1,
    clientSeq: 1,
    createdAt: `2026-07-05T00:01:${String(index).padStart(2, "0")}.000Z`,
    status: "pending",
  })));

  const stored = await mod.loadWorkspaceMutationLog(storage, "ws-1");
  assert.equal(stored.length, 12);
  assert.equal(new Set(stored.map((entry) => entry.clientSeq)).size, 12);
});
