import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("page collaboration waits for a canonical CRDT lineage before binding the editor", async () => {
  const source = await readFile("src/pages/workbench/backend-workbench.ts", "utf8");

  assert.match(source, /::crdt-v2::/);
  const bindBlock = /const bindEditorToActiveDoc = \(\): void => \{([\s\S]*?)\n    \};/.exec(source)?.[1] ?? "";
  assert.match(
    bindBlock,
    /if \(!collaborationReadyDocIds\.has\(active\.id\)\) \{[\s\S]*?editor\.bindCollaborator\(undefined\);[\s\S]*?setCollaborationSurfacePending\(active, true\);[\s\S]*?return;/,
  );
  assert.doesNotMatch(
    bindBlock,
    /startCollaborativeTransport\(active\)[\s\S]{0,120}setCollaborationSurfacePending\(active, false\)/,
  );
  assert.doesNotMatch(source, /applyLocalMarkdown\(hydrated(?:Markdown|\.markdown)\)/);
});

test("structured documents use revision-guarded persistence instead of whole-array realtime replacement", async () => {
  const source = await readFile("src/pages/workbench/backend-workbench.ts", "utf8");
  const transportBlock = /const startCollaborativeTransport = async \(doc: WorkspaceDoc\): Promise<void> => \{([\s\S]*?)\n    \};/.exec(source)?.[1] ?? "";

  assert.match(transportBlock, /if \(doc\.kind !== "page"/);
  assert.match(transportBlock, /setCollaborationSurfacePending\(doc, true\);[\s\S]*?Promise\.all/);
  assert.doesNotMatch(transportBlock, /createStructuredCollaborator/);
});
