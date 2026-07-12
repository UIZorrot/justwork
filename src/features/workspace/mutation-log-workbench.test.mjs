import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("workbench replays the persisted workspace mutation log during initial load and remote refresh", async () => {
  const workbench = await readFile(path.resolve("src/pages/workbench/backend-workbench.ts"), "utf8");

  assert.match(workbench, /loadWorkspaceMutationLog/);
  assert.match(workbench, /applyWorkspaceMutationLog/);
  assert.match(workbench, /replaceStoredWorkspaceMutationLogForWorkspace/);
  assert.match(workbench, /const replayStoredWorkspaceMutationLog = async \(\): Promise<void> => \{/);
  assert.match(workbench, /await replayStoredWorkspaceMutationLog\(\);/);

  const refreshBlock = /const persistRefreshTree = async \(\): Promise<void> => \{([\s\S]*?)\n    \};/.exec(workbench)?.[1] ?? "";
  assert.match(refreshBlock, /await replayStoredWorkspaceMutationLog\(\);/);
});
