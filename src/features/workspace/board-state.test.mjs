import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

test("board state helpers manage lanes, cards, template inheritance, and moves immutably", async () => {
  const documents = await loadTranspiledModule("src/features/workspace/structured-document.ts");
  const mod = await loadTranspiledModule("src/features/workspace/board-state.ts");

  const base = documents.createDefaultBoardContent();
  const firstColumnId = base.columns[0].id;

  const withCard = mod.addBoardCard(base, firstColumnId, "Draft spec");
  const firstCardId = withCard.cards.at(-1).id;
  assert.equal(withCard.columns[0].cardIds.at(-1), firstCardId);
  assert.equal(base.columns[0].cardIds.length, 1);
  assert.equal(withCard.cards.at(-1).fields.length, withCard.template.fields.length);

  const updatedTitle = mod.updateBoardCardTitle(withCard, firstCardId, "Draft module spec");
  assert.equal(updatedTitle.cards.find((card) => card.id === firstCardId).title, "Draft module spec");

  const updatedField = mod.updateBoardCardField(
    updatedTitle,
    firstCardId,
    updatedTitle.cards.find((card) => card.id === firstCardId).fields[0].id,
    { value: "Keep it normalized" },
  );
  assert.equal(updatedField.cards.find((card) => card.id === firstCardId).fields[0].value, "Keep it normalized");

  const withSecondColumn = mod.addBoardColumn(updatedField, "Done");
  const secondColumnId = withSecondColumn.columns.at(-1).id;
  assert.equal(withSecondColumn.columns.length, 4);

  const moved = mod.moveBoardCard(withSecondColumn, firstCardId, secondColumnId, 0);
  assert.equal(moved.columns[0].cardIds.includes(firstCardId), false);
  assert.equal(moved.columns.at(-1).cardIds[0], firstCardId);

  const renamedColumn = mod.renameBoardColumn(moved, secondColumnId, "Shipped");
  assert.equal(renamedColumn.columns.at(-1).title, "Shipped");

  const addedTemplateField = mod.addBoardTemplateField(renamedColumn, "Owner");
  const inheritedCard = addedTemplateField.cards.find((card) => card.id === firstCardId);
  assert.equal(inheritedCard.fields.some((field) => field.name === "Owner"), true);
});

test("board columns can all be removed without resetting defaults", async () => {
  const documents = await loadTranspiledModule("src/features/workspace/structured-document.ts");
  const mod = await loadTranspiledModule("src/features/workspace/board-state.ts");

  let current = documents.createDefaultBoardContent();
  for (const column of [...current.columns]) {
    current = mod.removeBoardColumn(current, column.id);
  }

  assert.equal(current.columns.length, 0);
  assert.equal(current.cards.length, 0);
  assert.equal(current.template.fields.length, 2);
});

test("adding a board column creates a template-backed starter card", async () => {
  const documents = await loadTranspiledModule("src/features/workspace/structured-document.ts");
  const mod = await loadTranspiledModule("src/features/workspace/board-state.ts");

  const base = documents.createDefaultBoardContent();
  const updated = mod.addBoardColumn(base, "Review");
  const addedColumn = updated.columns.at(-1);

  assert.equal(addedColumn.title, "Review");
  assert.equal(addedColumn.cardIds.length, 1);
  const starterCardId = addedColumn.cardIds[0];
  const starterCard = updated.cards.find((card) => card.id === starterCardId);
  assert.ok(starterCard);
  assert.equal(starterCard.fields.length, updated.template.fields.length);
  assert.deepEqual(
    starterCard.fields.map((field) => field.name),
    updated.template.fields.map((field) => field.name),
  );
});
