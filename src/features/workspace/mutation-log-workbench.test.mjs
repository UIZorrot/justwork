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

  const refreshBlock = /const refreshWorkspaceFromRemote = async \(\): Promise<void> => \{([\s\S]*?)\n    \};/.exec(workbench)?.[1] ?? "";
  assert.match(refreshBlock, /await replayStoredWorkspaceMutationLog\(\);/);
  assert.match(refreshBlock, /replayLocalOperationJournal\(\);[\s\S]*overlayDirtyDocs\(\);/);
  assert.doesNotMatch(refreshBlock, /if \(dirtyDocIds\.has\(summary\.id\)\) return;/);
  assert.match(
    refreshBlock,
    /if \(currentEpoch && canonicalState\.room_epoch !== currentEpoch\) \{[\s\S]*if \(!dirtyDocIds\.has\(summary\.id\)\) \{/,
  );
  assert.match(refreshBlock, /revision:\s*local\.revision/);
  assert.doesNotMatch(
    refreshBlock,
    /shouldPreferLocal && local[\s\S]*revision:\s*Math\.max\(local\.revision,\s*hydrated\.revision\)/,
  );

  const journalReplayBlock = /const replayLocalOperationJournal = \(\): void => \{([\s\S]*?)\n    \};/.exec(workbench)?.[1] ?? "";
  assert.doesNotMatch(journalReplayBlock, /dirtyDocIds\.delete/);
});
