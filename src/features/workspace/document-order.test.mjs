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

test("concurrent insertions receive deterministic unique ranks without float midpoints", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/document-order.ts");
  const docs = [
    { ...doc("a", 0), orderRank: "40000000000000000000000000000000" },
    { ...doc("b", 1024), orderRank: "c0000000000000000000000000000000" },
  ];
  const left = mod.orderRankForInsertion(docs, "root", "b");
  const right = mod.orderRankForInsertion(docs, "root", "b");
  assert.notEqual(left, right);
  assert.ok(left > docs[0].orderRank && left < docs[1].orderRank);
  assert.ok(right > docs[0].orderRank && right < docs[1].orderRank);
  assert.notEqual(mod.compareDocumentOrder(
    { ...doc("x", 0), orderRank: left },
    { ...doc("y", 0), orderRank: right },
  ), 0);
});
