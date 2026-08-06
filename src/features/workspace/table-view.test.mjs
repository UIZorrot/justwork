import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
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

test("table view does not disable Univer auto focus", async () => {
  const source = await readFile(path.resolve("src/features/workspace/table-view.ts"), "utf8");

  assert.equal(
    source.includes("disableAutoFocus: true"),
    false,
    "sheet cells must be allowed to focus into edit mode",
  );
});

test("table add-sheet control uses a compact plus and portals its popover above Univer", async () => {
  const source = await readFile(path.resolve("src/features/workspace/table-view.ts"), "utf8");
  const css = await readFile(path.resolve("src/pages/workbench/workbench.css"), "utf8");

  assert.match(source, /sheetComposerToggle\.textContent = "\+"/);
  assert.match(source, /sheetComposerToggle\.setAttribute\("aria-label", options\.labels\?\.addSheet/);
  assert.match(source, /host\.append\(sheetFooter, sheetComposerPopover\)/);
  assert.match(source, /sheetComposerPopover\.dataset\.open = sheetComposerOpen/);
  assert.match(source, /positionSheetComposerPopover\(\)/);
  assert.match(css, /\.structured-sheet-composer-popover \{[\s\S]*?z-index: 50/);
  assert.match(css, /\.structured-sheet-composer-popover\[data-open="true"\]/);
});

test("table view defers external workbook replacement while a local cell edit is settling", async () => {
  const source = await readFile(path.resolve("src/features/workspace/table-view.ts"), "utf8");

  assert.match(source, /const EXTERNAL_UPDATE_IDLE_MS = 700/);
  assert.match(source, /addEventListener\("beforeinput", markUncommittedEditorInput, true\)/);
  assert.match(source, /hasUncommittedEditorInput = true/);
  assert.match(source, /lastLocalCommandAt = Date\.now\(\)/);
  assert.match(source, /if \(hasUncommittedEditorInput \|\| emitTimer !== null \|\| remainingIdleMs > 0\)/);
  assert.match(source, /const stableSnapshot = currentWorkbook\.save\(\)/);
  assert.match(source, /const boundSnapshot = workbook\.save\(\)/);
  assert.match(source, /deferredExternalContent = normalized/);
  assert.match(source, /const selectionState = captureWorkbookSelection\(\)/);
  assert.match(source, /restoreWorkbookSelection\(workbook, selectionState\)/);
  assert.match(source, /restoreWorkbookSelection\(currentWorkbook, pendingSelectionRestore\)/);
});

test("table view makes one Ctrl+A select the complete active worksheet", async () => {
  const source = await readFile(path.resolve("src/features/workspace/table-view.ts"), "utf8");

  assert.match(source, /const selectEntireWorksheet = \(event: KeyboardEvent\)/);
  assert.match(source, /sheet\.getMaxRows\(\)/);
  assert.match(source, /sheet\.getMaxColumns\(\)/);
  assert.match(source, /currentWorkbook\.setActiveRange\(sheet\.getRange\(/);
  assert.match(source, /event\.stopImmediatePropagation\(\)/);
  assert.match(source, /removeEventListener\("keydown", selectEntireWorksheet, true\)/);
});
