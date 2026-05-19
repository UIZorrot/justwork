import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

test("table state helpers manage rows, columns, and cells immutably", async () => {
  const documents = await loadTranspiledModule("src/features/workspace/structured-document.ts");
  const mod = await loadTranspiledModule("src/features/workspace/table-state.ts");

  const base = documents.createDefaultTableContent();
  const originalColumnId = base.columns[0].id;
  const originalRowId = base.rows[0].id;

  const withSecondColumn = mod.addTableColumn(base, "Status");
  assert.equal(base.columns.length, 2);
  assert.equal(withSecondColumn.columns.length, 3);
  const secondColumnId = withSecondColumn.columns[2].id;
  assert.equal(withSecondColumn.rows[0].cells[secondColumnId], "");

  const renamed = mod.renameTableColumn(withSecondColumn, secondColumnId, "Stage");
  assert.equal(renamed.columns[2].title, "Stage");

  const updated = mod.updateTableCell(renamed, originalRowId, secondColumnId, "Draft");
  assert.equal(updated.rows[0].cells[secondColumnId], "Draft");

  const withSecondRow = mod.addTableRow(updated);
  assert.equal(withSecondRow.rows.length, 2);
  assert.deepEqual(Object.keys(withSecondRow.rows[1].cells).sort(), withSecondRow.columns.map((column) => column.id).sort());

  const removedRow = mod.removeTableRow(withSecondRow, originalRowId);
  assert.equal(removedRow.rows.length, 1);
  assert.equal(removedRow.rows[0].id, withSecondRow.rows[1].id);

  const removedColumn = mod.removeTableColumn(removedRow, originalColumnId);
  assert.equal(removedColumn.columns.length, 2);
  assert.equal(removedColumn.columns.at(-1).id, secondColumnId);
  assert.equal(Object.keys(removedColumn.rows[0].cells).includes(secondColumnId), true);
});

test("table column titles are trimmed on create and rename", async () => {
  const documents = await loadTranspiledModule("src/features/workspace/structured-document.ts");
  const mod = await loadTranspiledModule("src/features/workspace/table-state.ts");

  const base = documents.createDefaultTableContent();
  const added = mod.addTableColumn(base, "  Status  ");
  assert.equal(added.columns.at(-1).title, "Status");

  const renamed = mod.renameTableColumn(added, added.columns.at(-1).id, "  Stage  ");
  assert.equal(renamed.columns.at(-1).title, "Stage");
});
