import assert from "node:assert/strict";
import test from "node:test";

import { loadTranspiledModule } from "../workspace/test-module-loader.mjs";

test("room epoch accepts only snapshots from the same canonical lineage", async () => {
  const mod = await loadTranspiledModule("src/features/collaboration/room-epoch.ts");

  assert.equal(mod.shouldResetCollaborativeLineage(undefined, undefined, "epoch-a"), false);
  assert.equal(mod.shouldResetCollaborativeLineage(undefined, "epoch-a", "epoch-a"), false);
  assert.equal(mod.shouldResetCollaborativeLineage("epoch-a", "epoch-a", "epoch-a"), false);
  assert.equal(mod.shouldResetCollaborativeLineage("epoch-a", "epoch-a", "epoch-b"), true);
  assert.equal(mod.shouldResetCollaborativeLineage(undefined, "epoch-a", "epoch-b"), true);
});
