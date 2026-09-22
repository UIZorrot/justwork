import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

function storage(initial = {}) {
  const values = structuredClone(initial);
  return {
    async get(key) { return key in values ? { [key]: structuredClone(values[key]) } : {}; },
    async set(patch) { Object.assign(values, structuredClone(patch)); },
  };
}

test("drafts survive a new page session without an extension message receiver", async () => {
  const { createBackendDraftStore } = await loadTranspiledModule("src/features/workspace/backend-draft-store.ts");
  const durable = storage();
  await createBackendDraftStore(durable).upsert("w", "a", { markdown: "offline text" }, 3);
  assert.equal((await createBackendDraftStore(durable).get("w", "a")).markdown, "offline text");
});

test("concurrent tabs preserve different documents and merge partial edits", async () => {
  const { createBackendDraftStore } = await loadTranspiledModule("src/features/workspace/backend-draft-store.ts");
  const durable = storage();
  const a = createBackendDraftStore(durable);
  const b = createBackendDraftStore(durable);
  await Promise.all([
    a.upsert("w", "a", { markdown: "first" }, 1),
    b.upsert("w", "b", { markdown: "second" }, 1),
    b.upsert("w", "a", { title: "new title" }, 1),
  ]);
  assert.equal((await a.get("w", "a")).markdown, "first");
  assert.equal((await a.get("w", "a")).title, "new title");
  assert.equal((await a.get("w", "b")).markdown, "second");
});

test("acknowledging an old save cannot remove a newer edit", async () => {
  const { createBackendDraftStore } = await loadTranspiledModule("src/features/workspace/backend-draft-store.ts");
  const store = createBackendDraftStore(storage());
  const old = await store.upsert("w", "a", { markdown: "old" }, 1);
  await Promise.all([
    store.upsert("w", "a", { markdown: "new" }, 1),
    store.remove("w", "a", old.seq),
  ]);
  assert.equal((await store.get("w", "a")).markdown, "new");
});

test("acknowledged migrated drafts do not resurrect from legacy session storage", async () => {
  const { createBackendDraftStore } = await loadTranspiledModule("src/features/workspace/backend-draft-store.ts");
  const { STORAGE_KEYS } = await loadTranspiledModule("src/shared/storage-keys.ts");
  const legacy = storage({ [STORAGE_KEYS.BACKEND_DOC_DRAFTS]: {
    "w::a": { workspaceId: "w", itemId: "a", markdown: "old", seq: 42 },
  } });
  const durable = storage();
  const store = createBackendDraftStore(durable, legacy);
  assert.equal((await store.get("w", "a")).seq, 42);
  await store.remove("w", "a", 42);
  assert.equal(await createBackendDraftStore(durable, legacy).get("w", "a"), null);
});

test("a failed durable write is reported and does not poison later saves", async () => {
  const { createBackendDraftStore } = await loadTranspiledModule("src/features/workspace/backend-draft-store.ts");
  const durable = storage();
  const set = durable.set;
  durable.set = async () => { throw new Error("quota exceeded"); };
  const store = createBackendDraftStore(durable);
  await assert.rejects(store.upsert("w", "a", { markdown: "text" }), /quota/);
  durable.set = set;
  await store.upsert("w", "a", { markdown: "recovered" });
  assert.equal((await store.get("w", "a")).markdown, "recovered");
});
