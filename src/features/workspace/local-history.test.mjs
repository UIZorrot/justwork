import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

function createStorage() {
  const data = new Map();
  return {
    async get(key) {
      const keys = Array.isArray(key) ? key : [key];
      const result = {};
      for (const item of keys) {
        if (data.has(item)) {
          result[item] = data.get(item);
        }
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

test("local history skips no-op snapshots", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/local-history.ts");
  const snapshot = { title: "Doc", markdown: "hello" };
  assert.equal(mod.shouldRecordLocalHistoryEvent(snapshot, snapshot), false);
  assert.equal(
    mod.shouldRecordLocalHistoryEvent(snapshot, { ...snapshot, markdown: "hello world" }),
    true,
  );
});

test("local history builds revert patch from before snapshot", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/local-history.ts");
  const event = {
    id: "hist_1",
    workspaceId: "ws_1",
    op: "workspace.item.set",
    itemId: "doc_1",
    timestamp: "2026-05-11T00:00:00.000Z",
    title: "Doc",
    before: { title: "Old", markdown: "before" },
    after: { title: "Doc", markdown: "after" },
  };
  assert.equal(mod.isRevertableLocalHistoryEvent(event), true);
  assert.deepEqual(mod.buildLocalHistoryRevertPatch(event), {
    title: "Old",
    markdown: "before",
  });
});

test("local history allows structural move, pin, trash, and restore events to be reverted", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/local-history.ts");
  const base = {
    id: "hist_structural",
    workspaceId: "ws_1",
    itemId: "doc_1",
    timestamp: "2026-05-11T00:00:00.000Z",
    title: "Doc",
    after: {},
  };
  assert.equal(mod.isRevertableLocalHistoryEvent({ ...base, op: "workspace.item.move", before: { parentId: "folder_1" } }), true);
  assert.equal(mod.isRevertableLocalHistoryEvent({ ...base, op: "workspace.item.pin", before: { pinned: false } }), true);
  assert.equal(mod.isRevertableLocalHistoryEvent({ ...base, op: "workspace.item.trash", before: { inTrash: false } }), true);
  assert.equal(mod.isRevertableLocalHistoryEvent({ ...base, op: "workspace.item.restore", before: { inTrash: true } }), true);
  assert.equal(mod.isRevertableLocalHistoryEvent({ ...base, op: "workspace.item.create", before: {}, after: { inTrash: false } }), true);
});

test("local history trims to max events per workspace", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/local-history.ts");
  const storage = createStorage();
  const workspaceId = "ws_trim";
  for (let i = 0; i < mod.LOCAL_HISTORY_MAX_EVENTS + 5; i += 1) {
    await mod.appendLocalHistoryEvent(storage, {
      workspaceId,
      op: "workspace.item.set",
      itemId: "doc_1",
      title: "Doc",
      before: { markdown: `before-${i}` },
      after: { markdown: `after-${i}` },
      createdAt: new Date(Date.UTC(2026, 4, 11, 0, 0, i)).toISOString(),
    });
  }
  const events = await mod.listLocalHistoryEvents(storage, workspaceId);
  assert.equal(events.length, mod.LOCAL_HISTORY_MAX_EVENTS);
  assert.equal(events[0].after.markdown, `after-${mod.LOCAL_HISTORY_MAX_EVENTS + 4}`);
});

test("local history does not lose concurrent events", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/local-history.ts");
  const storage = createStorage();
  await Promise.all(Array.from({ length: 12 }, (_, index) => mod.appendLocalHistoryEvent(storage, {
    workspaceId: "ws_concurrent",
    op: "workspace.item.set",
    itemId: `doc_${index}`,
    title: `Doc ${index}`,
    before: { markdown: `before-${index}` },
    after: { markdown: `after-${index}` },
  })));
  const events = await mod.listLocalHistoryEvents(storage, "ws_concurrent");
  assert.equal(events.length, 12);
  assert.equal(new Set(events.map((event) => event.itemId)).size, 12);
});
