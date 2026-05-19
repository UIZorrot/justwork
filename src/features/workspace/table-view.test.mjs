import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

test("table workbook snapshots preserve stable row and column identifiers", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/structured-document.ts");

  const source = {
    kind: "table",
    frozenHeader: true,
    columns: [
      { id: "col_name", title: "Name", type: "text", width: 220 },
      { id: "col_status", title: "Status", type: "text", width: 180 },
    ],
    rows: [
      { id: "row_alpha", cells: { col_name: "Alpha", col_status: "Draft" } },
      { id: "row_beta", cells: { col_name: "Beta", col_status: "Done" } },
    ],
  };

  const workbookData = mod.tableContentToWorkbookData(source);
  const normalized = mod.normalizeStructuredDocumentContent("table", { workbookData });

  assert.deepEqual(
    normalized.columns.map((column) => column.id),
    ["col_name", "col_status"],
  );
  assert.deepEqual(
    normalized.rows.map((row) => row.id),
    ["row_alpha", "row_beta"],
  );
  assert.equal(normalized.rows[0].cells.col_status, "Draft");
});

test("table workbook snapshots keep formulas and freeze state", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/structured-document.ts");

  const workbookData = mod.tableContentToWorkbookData({
    kind: "table",
    frozenHeader: false,
    columns: [{ id: "col_formula", title: "Formula", type: "formula", width: 240 }],
    rows: [{ id: "row_formula", cells: { col_formula: "=SUM(1,2)" } }],
  });

  const normalized = mod.normalizeStructuredDocumentContent("table", { workbookData });

  assert.equal(normalized.frozenHeader, false);
  assert.equal(normalized.columns[0].type, "formula");
  assert.equal(normalized.rows[0].cells.col_formula, "=SUM(1,2)");
});
