import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

test("optimistic create patches merge local title, markdown, and content before promotion", async () => {
  const documents = await loadTranspiledModule("src/features/workspace/structured-document.ts");
  const mod = await loadTranspiledModule("src/features/workspace/optimistic-create-patches.ts");

  const pending = new Map();
  const optimisticId = "optimistic_doc_1";
  const content = documents.createDefaultBoardContent();
  const editedContent = {
    ...content,
    cards: [],
    columns: content.columns.map((column) => ({ ...column, cardIds: [] })),
  };

  mod.stageOptimisticCreatePatch(pending, optimisticId, { title: "Draft title" });
  mod.stageOptimisticCreatePatch(pending, optimisticId, { markdown: "# Draft\n" });
  mod.stageOptimisticCreatePatch(pending, optimisticId, { content: editedContent });

  const createdDoc = {
    id: "doc_real_1",
    kind: "board",
    title: "Untitled board",
    markdown: "",
    content,
    revision: 1,
    updatedAt: "2026-05-14T10:00:00.000Z",
    lastVisitedAt: "2026-05-14T10:00:00.000Z",
    parentId: "root",
    pinned: false,
    inTrash: false,
  };

  const promoted = mod.promoteOptimisticCreateDoc(pending, optimisticId, createdDoc);
  assert.equal(promoted.doc.title, "Draft title");
  assert.equal(promoted.doc.markdown, "# Draft\n");
  assert.deepEqual(promoted.doc.content, editedContent);
  assert.deepEqual(promoted.patch, {
    title: "Draft title",
    markdown: "# Draft\n",
    content: editedContent,
  });
  assert.equal(pending.has(optimisticId), false);
});
