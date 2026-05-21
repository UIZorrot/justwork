import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "../workspace/test-module-loader.mjs";

test("page edits in collaborative mode still require local dirty state and backend save", async () => {
  const mod = await loadTranspiledModule("src/features/collaboration/page-edit-persistence.ts");

  const localOnly = mod.planPageEditPersistence(false);
  assert.equal(localOnly.commitLocalEdit, true);
  assert.equal(localOnly.scheduleSave, true);

  const collaborative = mod.planPageEditPersistence(true);
  assert.equal(collaborative.commitLocalEdit, true);
  assert.equal(collaborative.scheduleSave, true);
});
