import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("workbench keeps pending online deletes applied across remote tree refreshes", async () => {
  const workbench = await readFile(path.resolve("src/pages/workbench/backend-workbench.ts"), "utf8");

  for (const required of [
    "const replayLocalOperationJournal = (): void => {",
    "const replayed = applyWorkspaceOperationJournal(workspace, localOperationJournal);",
    "localOperationJournal = replayed.operations;",
    "const recordLocalEditOperation = (itemId: string, baseRevision: number, patch: OfflineMutationPatch): string => {",
    "recordLocalEditOperation(itemId, baseRevision, patch);",
    "removeLocalEditOperations(request.itemId);",
    "overlayDirtyDocsWithoutJournalEdits();",
    "recordLocalDeleteOperation(itemId, \"trash\");",
    "removeLocalOperation(localOperationId);",
  ]) {
    assert.equal(workbench.includes(required), true, `expected workbench to include ${required}`);
  }
});
