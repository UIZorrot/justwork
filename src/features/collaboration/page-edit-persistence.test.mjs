import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "../workspace/test-module-loader.mjs";

test("page edits in collaborative mode still require local dirty state and backend save", async () => {
  const mod = await loadTranspiledModule("src/features/collaboration/page-edit-persistence.ts");

  const localOnly = mod.planPageEditPersistence(false);
  assert.equal(localOnly.commitLocalEdit, true);
  assert.equal(localOnly.scheduleSave, true);

  const collaborativePending = mod.planPageEditPersistence(true, false);
  assert.equal(collaborativePending.commitLocalEdit, true);
  assert.equal(collaborativePending.scheduleSave, false);

  const collaborative = mod.planPageEditPersistence(true, true);
  assert.equal(collaborative.commitLocalEdit, true);
  assert.equal(collaborative.scheduleSave, true);
});

test("editor initialization callbacks do not create a document save", async () => {
  const mod = await loadTranspiledModule("src/features/collaboration/page-edit-persistence.ts");

  assert.equal(mod.isMeaningfulPageEdit("", ""), false);
  assert.equal(mod.isMeaningfulPageEdit("", "\n"), false);
  assert.equal(mod.isMeaningfulPageEdit("\n", "  \n"), false);
  assert.equal(mod.isMeaningfulPageEdit("same", "same"), false);
  assert.equal(mod.isMeaningfulPageEdit("before", "after"), true);
});

test("collaborative markdown never falls back to a whole-text REST save", async () => {
  const mod = await loadTranspiledModule("src/features/collaboration/page-edit-persistence.ts");

  assert.equal(mod.shouldPersistCollaborativeMarkdown(false, false, 0), true);
  assert.equal(mod.shouldPersistCollaborativeMarkdown(true, false, 0), true);
  assert.equal(mod.shouldPersistCollaborativeMarkdown(true, true, 1), true);
  assert.equal(mod.shouldPersistCollaborativeMarkdown(true, true, 0), false);
});
