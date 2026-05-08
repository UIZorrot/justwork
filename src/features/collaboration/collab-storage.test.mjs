import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workbench restores collaborative markdown from local snapshot before backend paint", async () => {
  const storageSource = await readFile("src/features/collaboration/collab-storage.ts", "utf8");
  assert.match(storageSource, /saveCollaborativeSnapshot/);
  assert.match(storageSource, /loadCollaborativeSnapshot/);
  assert.match(storageSource, /removeCollaborativeSnapshot/);
  assert.match(storageSource, /COLLABORATIVE_MARKDOWN_SNAPSHOT_PREFIX/);

  const workbenchSource = await readFile("src/pages/workbench/backend-workbench.ts", "utf8");
  assert.match(workbenchSource, /createMarkdownCollaborator/);
  assert.match(workbenchSource, /loadCollaborativeSnapshot/);
  assert.match(workbenchSource, /saveCollaborativeSnapshot/);
  assert.match(workbenchSource, /hydrateDocWithCollaborativeSnapshot/);
});
