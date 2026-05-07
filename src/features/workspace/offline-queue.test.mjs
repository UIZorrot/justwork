import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const queuePath = path.resolve("src/features/workspace/offline-queue.ts");
const storageKeysPath = path.resolve("src/shared/storage-keys.ts");
const i18nPath = path.resolve("src/shared/i18n.ts");

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
