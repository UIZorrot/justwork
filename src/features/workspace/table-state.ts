import {
  createDefaultTableContent,
  createStructuredId,
  normalizeStructuredDocumentContent,
  type TableColumnType,
  type TableDocumentContent,
} from "./structured-document";

function cloneTable(content: TableDocumentContent): TableDocumentContent {
  return {
    kind: "table",
    frozenHeader: content.frozenHeader,
    columns: content.columns.map((column) => ({ ...column })),
    rows: content.rows.map((row) => ({
      id: row.id,
      cells: { ...row.cells },
    })),
  };
}

export function addTableColumn(
  content: TableDocumentContent,
  title = "Column",
  type: TableColumnType = "text",
  width = 220,
): TableDocumentContent {
  const next = cloneTable(content);
  const columnId = createStructuredId("col");
  next.columns.push({
    id: columnId,
    title: title.trim() || "Column",
    type,
    width: Math.max(140, width),
  });
  next.rows = next.rows.map((row) => ({
    ...row,
    cells: {
      ...row.cells,
      [columnId]: "",
    },
  }));
  return next;
}

export function renameTableColumn(content: TableDocumentContent, columnId: string, title: string): TableDocumentContent {
  const next = cloneTable(content);
  next.columns = next.columns.map((column) => (
    column.id === columnId ? { ...column, title: title.trim() || column.title } : column
  ));
  return next;
}

export function resizeTableColumn(content: TableDocumentContent, columnId: string, width: number): TableDocumentContent {
  const next = cloneTable(content);
  next.columns = next.columns.map((column) => (
    column.id === columnId ? { ...column, width: Math.max(140, Math.round(width)) } : column
  ));
  return next;
}

export function updateTableCell(
  content: TableDocumentContent,
  rowId: string,
  columnId: string,
  value: string,
): TableDocumentContent {
  const next = cloneTable(content);
  next.rows = next.rows.map((row) => (
    row.id === rowId
      ? {
          ...row,
          cells: {
            ...row.cells,
            [columnId]: value,
          },
        }
      : row
  ));
  return next;
}

export function addTableRow(content: TableDocumentContent): TableDocumentContent {
  const next = cloneTable(content);
  const rowId = createStructuredId("row");
  const cells: Record<string, string> = {};
  for (const column of next.columns) {
    cells[column.id] = "";
  }
  next.rows.push({ id: rowId, cells });
  return next;
}

export function removeTableRow(content: TableDocumentContent, rowId: string): TableDocumentContent {
  const next = cloneTable(content);
  next.rows = next.rows.filter((row) => row.id !== rowId);
  return next.rows.length > 0 ? next : {
    ...next,
    rows: createDefaultTableContent().rows.map((row) => ({
      id: row.id,
      cells: Object.fromEntries(next.columns.map((column) => [column.id, row.cells[column.id] ?? ""])),
    })),
  };
}

export function removeTableColumn(content: TableDocumentContent, columnId: string): TableDocumentContent {
  const next = cloneTable(content);
  next.columns = next.columns.filter((column) => column.id !== columnId);
  if (next.columns.length === 0) {
    return normalizeStructuredDocumentContent("table", {}) as TableDocumentContent;
  }
  next.rows = next.rows.map((row) => {
    const cells: Record<string, string> = {};
    for (const column of next.columns) {
      cells[column.id] = row.cells[column.id] ?? "";
    }
    return { ...row, cells };
  });
  return next;
}

export function setTableFrozenHeader(content: TableDocumentContent, frozenHeader: boolean): TableDocumentContent {
  return {
    ...cloneTable(content),
    frozenHeader,
  };
}

export function pasteTableRange(
  content: TableDocumentContent,
  anchorRowIndex: number,
  anchorColumnIndex: number,
  rawText: string,
): TableDocumentContent {
  const lines = rawText.replace(/\r/g, "").split("\n").filter((line, index, values) => (
    line.length > 0 || index < values.length - 1
  ));
  if (lines.length === 0) return cloneTable(content);
  let next = cloneTable(content);
  while (next.rows.length < anchorRowIndex + lines.length) {
    next = addTableRow(next);
  }
  const maxColumnsNeeded = Math.max(...lines.map((line) => line.split("\t").length));
  while (next.columns.length < anchorColumnIndex + maxColumnsNeeded) {
    next = addTableColumn(next, `Column ${next.columns.length + 1}`);
  }
  lines.forEach((line, rowOffset) => {
    const cells = line.split("\t");
    const row = next.rows[anchorRowIndex + rowOffset];
    cells.forEach((value, columnOffset) => {
      const column = next.columns[anchorColumnIndex + columnOffset];
      row.cells[column.id] = value;
    });
  });
  return next;
}
