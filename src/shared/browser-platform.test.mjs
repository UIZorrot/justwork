import assert from "node:assert/strict";
import test from "node:test";

import { loadTranspiledModule } from "../features/workspace/test-module-loader.mjs";

test("web runtime assets resolve relative to the hosted app base path", async () => {
  const mod = await loadTranspiledModule("src/shared/browser-platform.ts");

  assert.equal(
    mod.resolveWebRuntimeUrl("vendor/vditor", "https://justwork.txzy.net/app/"),
    "https://justwork.txzy.net/app/vendor/vditor",
  );
  assert.equal(
    mod.resolveWebRuntimeUrl("/agent/SKILL.md", "https://justwork.txzy.net/app/?workspace=demo"),
    "https://justwork.txzy.net/app/agent/SKILL.md",
  );
});
