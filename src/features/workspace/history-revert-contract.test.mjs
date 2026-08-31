import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("history revert drains delayed saves and adopts the canonical collaborative state", async () => {
  const source = await readFile("src/pages/workbench/backend-workbench.ts", "utf8");
  const handlerStart = source.indexOf('revertBtn.addEventListener("click"');
  const handlerEnd = source.indexOf("historyList.appendChild(li)", handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);

  assert.match(handler, /await flushPendingDocSave\(ev\.itemId\)/);
  assert.match(handler, /await waitForDocSaveQueueToSettle\(ev\.itemId\)/);
  assert.match(handler, /session\.revertRevision\(ev\.id, current\.revision, revertMutationId\)/);
  assert.doesNotMatch(handler, /session\.saveItem/);
  assert.match(handler, /runHistoryRevertWithRetry/);
  assert.match(handler, /applyAuthoritativeCollaborativeState\(reverted\)/);
  assert.match(handler, /resetMarkdownCollaborator\(reverted\)/);
  assert.match(handler, /resetStructuredCollaborator\(reverted\)/);
  assert.match(handler, /dirtyDocIds\.delete\(ev\.itemId\)/);
  assert.match(handler, /removeBackendDocDraft\(workspaceId, ev\.itemId, Number\.MAX_SAFE_INTEGER\)/);
});

test("document saves use independent queues", async () => {
  const source = await readFile("src/pages/workbench/backend-workbench.ts", "utf8");

  assert.match(source, /const docSaveQueues = new Map<string, Promise<void>>\(\)/);
  assert.match(source, /docSaveQueues\.get\(request\.itemId\) \?\? Promise\.resolve\(\)/);
  assert.match(source, /docSaveQueues\.set\(request\.itemId, nextQueue\)/);
  assert.doesNotMatch(source, /let saveQueue: Promise<void>/);
});
