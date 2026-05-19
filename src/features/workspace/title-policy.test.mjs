import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

test("document titles keep visible spaces but fall back when blank", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/title-policy.ts");

  assert.equal(mod.displayTitleOrFallback("  My Doc  ", "Untitled document"), "  My Doc  ");
  assert.equal(mod.displayTitleOrFallback("   ", "Untitled document"), "Untitled document");
  assert.equal(mod.normalizeDocTitleInput("  My Doc  ", "Untitled document"), "  My Doc  ");
  assert.equal(mod.normalizeDocTitleInput("   ", "Untitled document"), "Untitled document");
});
