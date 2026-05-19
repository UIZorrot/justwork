import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

test("structured document defaults and normalization cover table and board content", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/structured-document.ts");

  const table = mod.createDefaultTableContent();
  assert.equal(table.kind, "table");
  assert.equal(table.frozenHeader, true);
  assert.equal(table.columns.length, 2);
  assert.equal(table.rows.length, 1);
  assert.equal(typeof table.workbookData, "object");
  assert.equal(typeof table.rows[0].cells[table.columns[0].id], "string");
  assert.equal(typeof table.columns[0].width, "number");

  const board = mod.createDefaultBoardContent();
  assert.equal(board.kind, "board");
  assert.equal(board.columns.length, 3);
  assert.equal(board.template.fields.length, 2);
  assert.equal(board.columns[0].title, "To do");
  assert.equal(board.cards.length, 1);

  const normalizedTable = mod.normalizeStructuredDocumentContent("table", {
    frozenHeader: false,
    columns: [{ id: "col_a", title: "Name", type: "text", width: 180 }],
    rows: [{ id: "row_a", cells: { col_a: "Alice", extra: "ignored" } }],
  });
  assert.equal(normalizedTable.kind, "table");
  assert.equal(normalizedTable.frozenHeader, false);
  assert.deepEqual(normalizedTable.columns, [{ id: "col_a", title: "Name", type: "text", width: 180 }]);
  assert.deepEqual(normalizedTable.rows, [{ id: "row_a", cells: { col_a: "Alice" } }]);
  assert.equal(typeof normalizedTable.workbookData, "object");

  const normalizedBoard = mod.normalizeStructuredDocumentContent("board", {
    template: {
      columnId: "template_lane",
      title: "Card template",
      cardTitle: "Default card",
      fields: [{ id: "field_a", name: "Summary", defaultValue: "" }],
    },
    columns: [{ id: "doing", title: "Doing", color: "#aabbcc", cardIds: ["card_a", "ghost"] }],
    cards: [{ id: "card_a", title: "Ship", fields: [{ id: "field_instance", templateFieldId: "field_a", name: "Old", value: "42" }] }],
  });
  assert.deepEqual(normalizedBoard, {
    kind: "board",
    template: {
      columnId: "template_lane",
      title: "Card template",
      cardTitle: "Default card",
      fields: [{ id: "field_a", name: "Summary", defaultValue: "" }],
    },
    columns: [{ id: "doing", title: "Doing", color: "#aabbcc", cardIds: ["card_a"] }],
    cards: [{
      id: "card_a",
      title: "Ship",
      fields: [{ id: "field_instance", templateFieldId: "field_a", name: "Summary", value: "42" }],
    }],
  });

  assert.equal(mod.isStructuredDocumentContent(normalizedTable), true);
  assert.equal(mod.isStructuredDocumentContent(normalizedBoard), true);
  assert.equal(mod.isStructuredDocumentContent({ kind: "other" }), false);
});

test("table workbook snapshots round-trip through structured normalization", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/structured-document.ts");

  const source = {
    kind: "table",
    frozenHeader: true,
    columns: [
      { id: "col_a", title: "Name", type: "text", width: 180 },
      { id: "col_b", title: "Formula", type: "formula", width: 260 },
    ],
    rows: [
      { id: "row_a", cells: { col_a: "Alice", col_b: "=SUM(1,2)" } },
      { id: "row_b", cells: { col_a: "Bob", col_b: "3" } },
    ],
  };

  const workbookData = mod.tableContentToWorkbookData(source);
  const normalized = mod.normalizeStructuredDocumentContent("table", { workbookData });

  assert.equal(normalized.kind, "table");
  assert.equal(normalized.frozenHeader, true);
  assert.deepEqual(
    normalized.columns.map((column) => ({ id: column.id, title: column.title, type: column.type, width: column.width })),
    source.columns,
  );
  assert.deepEqual(normalized.rows, source.rows);
  assert.equal(typeof normalized.workbookData, "object");
});

test("table workbook normalization preserves additional named worksheets", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/structured-document.ts");

  const content = mod.createDefaultTableContent();
  const workbookData = mod.tableContentToWorkbookData(content);
  workbookData.sheetOrder = ["sheet_1", "sheet_2"];
  workbookData.sheets.sheet_2 = {
    id: "sheet_2",
    name: "Wallet Management",
    hidden: 0,
    rowCount: 200,
    columnCount: 40,
    zoomRatio: 1,
    scrollTop: 0,
    scrollLeft: 0,
    defaultColumnWidth: 120,
    defaultRowHeight: 36,
    mergeData: [],
    cellData: { "0": { "0": { v: "Child sheet" } } },
    rowData: { "0": { h: 36 } },
    columnData: {},
    rowHeader: { width: 52, hidden: 0 },
    columnHeader: { height: 32, hidden: 0 },
    showGridlines: 1,
    gridlinesColor: "#d7dbe0",
    rightToLeft: 0,
  };

  const normalized = mod.normalizeStructuredDocumentContent("table", { workbookData });
  const roundTrip = mod.tableContentToWorkbookData(normalized);

  assert.deepEqual(roundTrip.sheetOrder, ["sheet_1", "sheet_2"]);
  assert.equal(roundTrip.sheets.sheet_2.name, "Wallet Management");
  assert.equal(roundTrip.sheets.sheet_2.cellData["0"]["0"].v, "Child sheet");
});

test("table workbook naming resolves duplicate child sheet names", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/structured-document.ts");

  assert.equal(
    mod.resolveUniqueWorksheetName(["Sheet", "Sheet 2", "Backlog"], "Sheet"),
    "Sheet 3",
  );
  assert.equal(
    mod.resolveUniqueWorksheetName(["Sheet", "Sheet 2", "Backlog"], "Roadmap"),
    "Roadmap",
  );
  assert.equal(
    mod.resolveUniqueWorksheetName(["Sheet"], ""),
    "Sheet 2",
  );
});
