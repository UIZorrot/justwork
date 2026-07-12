import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

const queuePath = path.resolve("src/features/workspace/offline-queue.ts");
const storageKeysPath = path.resolve("src/shared/storage-keys.ts");
const i18nPath = path.resolve("src/shared/i18n.ts");

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

test("offline queue has a bounded persistence contract and the sync conflict copy is localized", async () => {
  await access(queuePath);
  const queue = await readFile(queuePath, "utf8");
  const storageKeys = await readFile(storageKeysPath, "utf8");
  const i18n = await readFile(i18nPath, "utf8");

  assert.match(storageKeys, /OFFLINE_MUTATION_QUEUE/);
  assert.match(queue, /OfflineMutation/);
  assert.match(queue, /expectedRevision/);
  assert.match(queue, /enqueueOfflineMutation/);
  assert.match(queue, /removeOfflineMutation/);
  assert.match(queue, /mergeOfflineMutation/);
  assert.equal(queue.includes("password"), false);

  assert.match(i18n, /Offline, waiting to sync/);
  assert.match(i18n, /离线，待同步/);
  assert.match(i18n, /Conflict with another change/);
  assert.match(i18n, /与其他修改冲突/);
});

test("offline edit queue mirrors pending edits into the unified workspace mutation log", async () => {
  const queue = await loadTranspiledModule("src/features/workspace/offline-queue.ts");
  const log = await loadTranspiledModule("src/features/workspace/mutation-log.ts");
  const storage = createStorage();

  await queue.enqueueOfflineMutation(storage, {
    id: "offline-1",
    workspaceId: "ws-1",
    itemId: "page-a",
    patch: { title: "Local" },
    expectedRevision: 3,
    createdAt: "2026-07-05T00:01:00.000Z",
  });

  const mutations = await log.loadWorkspaceMutationLog(storage, "ws-1");
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].id, "offline-1");
  assert.equal(mutations[0].kind, "edit");
  assert.equal(mutations[0].baseRevision, 3);
  assert.deepEqual(mutations[0].patch, { title: "Local" });
});

test("offline edit queue removal and workspace clear keep the unified mutation log in sync", async () => {
  const queue = await loadTranspiledModule("src/features/workspace/offline-queue.ts");
  const log = await loadTranspiledModule("src/features/workspace/mutation-log.ts");
  const storage = createStorage();

  await queue.enqueueOfflineMutation(storage, {
    id: "offline-1",
    workspaceId: "ws-1",
    itemId: "page-a",
    patch: { title: "Local" },
    expectedRevision: 3,
    createdAt: "2026-07-05T00:01:00.000Z",
  });
  await queue.enqueueOfflineMutation(storage, {
    id: "offline-2",
    workspaceId: "ws-2",
    itemId: "page-b",
    patch: { title: "Other" },
    expectedRevision: 1,
    createdAt: "2026-07-05T00:01:00.000Z",
  });

  await queue.removeOfflineMutation(storage, "offline-1");
  assert.deepEqual(await log.loadWorkspaceMutationLog(storage, "ws-1"), []);

  await queue.clearOfflineMutationsForWorkspace(storage, "ws-2");
  assert.deepEqual(await log.loadWorkspaceMutationLog(storage, "ws-2"), []);
});
