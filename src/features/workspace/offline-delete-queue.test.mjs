import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

function createMemoryStorage() {
  const state = new Map();
  return {
    async get(key) {
      if (typeof key === "string") {
        return { [key]: state.get(key) };
      }
      return {};
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        state.set(key, value);
      }
    },
  };
}

test("enqueueOfflineDeleteMutation keeps one destructive action per item and lets hard delete supersede trash", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/offline-delete-queue.ts");
  const storage = createMemoryStorage();

  await mod.enqueueOfflineDeleteMutation(storage, {
    id: "m1",
    workspaceId: "ws-1",
    itemId: "doc-1",
    kind: "trash",
    createdAt: "2026-05-13T00:00:00.000Z",
  });
  await mod.enqueueOfflineDeleteMutation(storage, {
    id: "m2",
    workspaceId: "ws-1",
    itemId: "doc-1",
    kind: "hard-delete",
    createdAt: "2026-05-13T00:01:00.000Z",
  });

  const queued = await mod.loadOfflineDeleteMutations(storage);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].id, "m2");
  assert.equal(queued[0].kind, "hard-delete");
});

test("removeOfflineDeleteMutation removes only the targeted action", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/offline-delete-queue.ts");
  const storage = createMemoryStorage();

  await mod.enqueueOfflineDeleteMutation(storage, {
    id: "m1",
    workspaceId: "ws-1",
    itemId: "doc-1",
    kind: "trash",
    createdAt: "2026-05-13T00:00:00.000Z",
  });
  await mod.enqueueOfflineDeleteMutation(storage, {
    id: "m2",
    workspaceId: "ws-1",
    itemId: "doc-2",
    kind: "trash",
    createdAt: "2026-05-13T00:01:00.000Z",
  });

  await mod.removeOfflineDeleteMutation(storage, "m1");
  const queued = await mod.loadOfflineDeleteMutations(storage);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].id, "m2");
});

test("applyOfflineDeleteMutationsToDocs overlays queued trash and hard delete onto the local tree", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/offline-delete-queue.ts");
  const state = {
    activeDocId: "page-a",
    workspaceTitle: "Workspace",
    workspaceDescription: "",
    docs: [
      { id: "root", title: "Root", markdown: "", content: null, revision: 0, updatedAt: "", lastVisitedAt: "", parentId: null, pinned: false, inTrash: false, kind: "folder" },
      { id: "folder-a", title: "Folder", markdown: "", content: null, revision: 0, updatedAt: "", lastVisitedAt: "", parentId: "root", pinned: false, inTrash: false, kind: "folder" },
      { id: "page-a", title: "Alpha", markdown: "", content: null, revision: 0, updatedAt: "", lastVisitedAt: "", parentId: "folder-a", pinned: true, inTrash: false, kind: "page" },
      { id: "page-b", title: "Beta", markdown: "", content: null, revision: 0, updatedAt: "", lastVisitedAt: "", parentId: "root", pinned: false, inTrash: false, kind: "page" },
    ],
  };

  const next = mod.applyOfflineDeleteMutationsToDocs(state, [
    { id: "m1", workspaceId: "ws-1", itemId: "folder-a", kind: "trash", createdAt: "2026-05-13T00:00:00.000Z" },
    { id: "m2", workspaceId: "ws-1", itemId: "page-b", kind: "hard-delete", createdAt: "2026-05-13T00:01:00.000Z" },
  ]);

  assert.equal(next.docs.find((doc) => doc.id === "folder-a").inTrash, true);
  assert.equal(next.docs.find((doc) => doc.id === "page-a").inTrash, true);
  assert.equal(next.docs.some((doc) => doc.id === "page-b"), false);
});

test("enqueueOfflineDeleteMutation lets restore replace a queued trash action for the same item", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/offline-delete-queue.ts");
  const storage = createMemoryStorage();

  await mod.enqueueOfflineDeleteMutation(storage, {
    id: "m1",
    workspaceId: "ws-1",
    itemId: "doc-1",
    kind: "trash",
    createdAt: "2026-05-13T00:00:00.000Z",
  });
  await mod.enqueueOfflineDeleteMutation(storage, {
    id: "m2",
    workspaceId: "ws-1",
    itemId: "doc-1",
    kind: "restore",
    createdAt: "2026-05-13T00:01:00.000Z",
  });

  const queued = await mod.loadOfflineDeleteMutations(storage);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].id, "m2");
  assert.equal(queued[0].kind, "restore");
});

test("applyOfflineDeleteMutationsToDocs lets queued restore clear a prior trash overlay", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/offline-delete-queue.ts");
  const state = {
    activeDocId: "page-a",
    workspaceTitle: "Workspace",
    workspaceDescription: "",
    docs: [
      { id: "root", title: "Root", markdown: "", content: null, revision: 0, updatedAt: "", lastVisitedAt: "", parentId: null, pinned: false, inTrash: false, kind: "folder" },
      { id: "folder-a", title: "Folder", markdown: "", content: null, revision: 0, updatedAt: "", lastVisitedAt: "", parentId: "root", pinned: false, inTrash: false, kind: "folder" },
      { id: "page-a", title: "Alpha", markdown: "", content: null, revision: 0, updatedAt: "", lastVisitedAt: "", parentId: "folder-a", pinned: true, inTrash: true, kind: "page" },
    ],
  };

  const next = mod.applyOfflineDeleteMutationsToDocs(state, [
    { id: "m1", workspaceId: "ws-1", itemId: "folder-a", kind: "trash", createdAt: "2026-05-13T00:00:00.000Z" },
    { id: "m2", workspaceId: "ws-1", itemId: "folder-a", kind: "restore", createdAt: "2026-05-13T00:01:00.000Z" },
  ]);

  assert.equal(next.docs.find((doc) => doc.id === "folder-a").inTrash, false);
  assert.equal(next.docs.find((doc) => doc.id === "page-a").inTrash, false);
});
