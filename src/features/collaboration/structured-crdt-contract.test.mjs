import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTranspiledModule } from "../workspace/test-module-loader.mjs";

test("structured collaboration stores stable-id rows, cells, and cards as nested CRDT entries", async () => {
  const source = await readFile("src/features/collaboration/yjs-structured.ts", "utf8");
  const workbench = await readFile("src/pages/workbench/backend-workbench.ts", "utf8");

  assert.match(source, /KEYED_ARRAY_TYPE/);
  assert.match(source, /stableArrayEntryKey/);
  assert.match(source, /\["items", new Y\.Map/);
  assert.match(source, /syncYMap\(existing/);
  assert.match(workbench, /getStructuredCollaboratorForDoc\(doc\)/);
  assert.match(workbench, /collaborator\.applyLocalContent\(nextContent\)/);
  assert.match(workbench, /structuredCollaborator\.applyRemoteUpdate\(update\)/);
});

test("concurrent edits to different cells converge without replacing either row", async () => {
  const structured = await loadTranspiledModule("src/features/collaboration/yjs-structured.ts");
  const documents = await loadTranspiledModule("src/features/workspace/structured-document.ts");
  const seed = structured.createStructuredCollaborator({
    kind: "table",
    initialContent: documents.createDefaultTableContent(),
  });
  const left = structured.createStructuredCollaborator({ kind: "table" });
  const right = structured.createStructuredCollaborator({ kind: "table" });
  left.applyRemoteUpdate(seed.encodeUpdate());
  right.applyRemoteUpdate(seed.encodeUpdate());
  const leftUpdates = [];
  const rightUpdates = [];
  left.onUpdate((update, origin) => { if (origin === "local") leftUpdates.push(update); });
  right.onUpdate((update, origin) => { if (origin === "local") rightUpdates.push(update); });

  const leftContent = structuredClone(left.getContent());
  const leftSheetId = leftContent.workbookData.sheetOrder[0];
  leftContent.workbookData.sheets[leftSheetId].cellData[1][0].v = "left";
  left.applyLocalContent(leftContent);
  const rightContent = structuredClone(right.getContent());
  const rightSheetId = rightContent.workbookData.sheetOrder[0];
  rightContent.workbookData.sheets[rightSheetId].cellData[1][1].v = "right";
  right.applyLocalContent(rightContent);
  for (const update of leftUpdates) right.applyRemoteUpdate(update);
  for (const update of rightUpdates) left.applyRemoteUpdate(update);

  assert.deepEqual(left.getContent(), right.getContent());
  assert.equal(left.getContent().rows[0].cells.col_name, "left");
  assert.equal(left.getContent().rows[0].cells.col_notes, "right");
  seed.destroy();
  left.destroy();
  right.destroy();
});
