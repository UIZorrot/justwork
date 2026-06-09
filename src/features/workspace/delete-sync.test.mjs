import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

test("discardPendingDocSave clears timer, removes pending save, and blocks future saves", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/delete-sync.ts");
  const pendingDocSaves = new Map();
  const blocked = new Set();
  const cleared = [];
  pendingDocSaves.set("page-a", { timer: 42 });

  mod.discardPendingDocSave(pendingDocSaves, blocked, "page-a", (timer) => cleared.push(timer));

  assert.deepEqual(cleared, [42]);
  assert.equal(pendingDocSaves.has("page-a"), false);
  assert.equal(blocked.has("page-a"), true);
});

test("shouldSkipDocSave rejects blocked, missing, and trashed docs", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/delete-sync.ts");
  const blocked = new Set(["page-a"]);

  assert.equal(mod.shouldSkipDocSave(blocked, "page-a", { inTrash: false }), true);
  assert.equal(mod.shouldSkipDocSave(new Set(), "page-b", null), true);
  assert.equal(mod.shouldSkipDocSave(new Set(), "page-c", { inTrash: true }), true);
  assert.equal(mod.shouldSkipDocSave(new Set(), "page-d", { inTrash: false }), false);
});

test("waitForPendingDocSavesToSettle waits for save queues and swallows queue failures", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/delete-sync.ts");
  const events = [];
  const queue = Promise.resolve().then(() => {
    events.push("settled");
  });

  await mod.waitForPendingDocSavesToSettle(queue);
  await mod.waitForPendingDocSavesToSettle(Promise.reject(new Error("queue failed")));

  assert.deepEqual(events, ["settled"]);
});
