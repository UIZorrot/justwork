import assert from "node:assert/strict";
import test from "node:test";

import { loadTranspiledModule } from "./test-module-loader.mjs";

const doc = (id, orderKey, parentId = "root") => ({ id, orderKey, parentId, inTrash: false });

test("document order computes stable keys before, between and after siblings", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/document-order.ts");
  const docs = [doc("a", 0), doc("b", 1024), doc("c", 2048)];
  assert.equal(mod.orderKeyForInsertion(docs, "root", "a"), -1024);
  assert.equal(mod.orderKeyForInsertion(docs, "root", "b"), 512);
  assert.equal(mod.orderKeyForInsertion(docs, "root", null), 3072);
});

test("document order excludes the moving item from its target slot", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/document-order.ts");
  const docs = [doc("a", 0), doc("b", 1024), doc("c", 2048)];
  assert.equal(mod.orderKeyForInsertion(docs, "root", "a", "c"), -1024);
});
