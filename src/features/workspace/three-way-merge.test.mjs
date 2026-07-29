import assert from "node:assert/strict";
import test from "node:test";

import { loadTranspiledModule } from "./test-module-loader.mjs";

test("three-way merge combines independent sheet cell edits", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/three-way-merge.ts");
  const base = { workbookData: { sheets: { one: { cellData: { 0: { 0: { v: "a" }, 1: { v: "b" } } } } } } };
  const local = structuredClone(base);
  local.workbookData.sheets.one.cellData[0][0].v = "local";
  const remote = structuredClone(base);
  remote.workbookData.sheets.one.cellData[0][1].v = "remote";

  const result = mod.mergeSyncValue(base, local, remote, "content");
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.value.workbookData.sheets.one.cellData[0][0].v, "local");
  assert.equal(result.value.workbookData.sheets.one.cellData[0][1].v, "remote");
});

test("three-way merge rejects concurrent edits to the same field", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/three-way-merge.ts");
  const result = mod.mergeSyncValue({ title: "base" }, { title: "local" }, { title: "remote" }, "content");
  assert.deepEqual(result.conflicts, ["content.title"]);
  assert.equal(result.value.title, "remote");
});

test("three-way merge combines independent stable-id rows", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/three-way-merge.ts");
  const base = [{ id: "a", title: "A" }, { id: "b", title: "B" }];
  const local = [{ id: "a", title: "Local A" }, { id: "b", title: "B" }];
  const remote = [{ id: "a", title: "A" }, { id: "b", title: "Remote B" }];
  const result = mod.mergeSyncValue(base, local, remote, "rows");
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.value.map((entry) => entry.title), ["Local A", "Remote B"]);
});
