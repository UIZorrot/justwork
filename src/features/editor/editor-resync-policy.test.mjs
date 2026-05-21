import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "../workspace/test-module-loader.mjs";

test("editor resync policy skips reset when markdown is unchanged", async () => {
  const mod = await loadTranspiledModule("src/features/editor/editor-resync-policy.ts");
  assert.equal(mod.shouldResyncEditorMarkdown("abc", "abc"), false);
});

test("editor resync policy allows reset when markdown changed", async () => {
  const mod = await loadTranspiledModule("src/features/editor/editor-resync-policy.ts");
  assert.equal(mod.shouldResyncEditorMarkdown("abc", "abcd"), true);
});
