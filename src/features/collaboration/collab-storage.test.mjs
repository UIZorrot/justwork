import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("collab storage keeps a synchronous local snapshot boundary", async () => {
  const storageSource = await readFile("src/features/collaboration/collab-storage.ts", "utf8");
  assert.match(storageSource, /getBrowserLocalStorage/);
  assert.match(storageSource, /saveCollaborativeSnapshot/);
  assert.match(storageSource, /loadCollaborativeSnapshot/);
  assert.match(storageSource, /removeCollaborativeSnapshot/);
  assert.match(storageSource, /COLLABORATIVE_MARKDOWN_SNAPSHOT_PREFIX/);

  const runtimeSource = await readFile("src/features/workspace/local-runtime.ts", "utf8");
  assert.match(runtimeSource, /globalThis\.localStorage/);
});

test("workbench restores collaborative markdown before backend paint", async () => {
  const workbenchSource = await readFile("src/pages/workbench/backend-workbench.ts", "utf8");
  assert.match(workbenchSource, /createMarkdownCollaborator/);
  assert.match(workbenchSource, /bindCollaborator/);
  assert.doesNotMatch(workbenchSource, /hydrateDocWithCollaborativeSnapshot\(/);
});
