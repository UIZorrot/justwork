export type StructuredDocumentKind = "table" | "board";

export type TableColumnType = "text" | "formula";

export type TableColumn = {
  id: string;
  title: string;
  type: TableColumnType;
  width: number;
};

export type TableRow = {
  id: string;
  cells: Record<string, string>;
};

export type TableDocumentContent = {
  kind: "table";
  frozenHeader: boolean;
  columns: TableColumn[];
  rows: TableRow[];
  workbookData?: Record<string, unknown>;
};

export type BoardTemplateField = {
  id: string;
  name: string;
  defaultValue: string;
};

export type BoardCardField = {
  id: string;
  templateFieldId: string | null;
  name: string;
  value: string;
};

export type BoardCardStatus = "todo" | "doing" | "done" | "paused";

export type BoardCard = {
  id: string;
  title: string;
  status: BoardCardStatus;
  fields: BoardCardField[];
};

export type BoardColumn = {
  id: string;
  title: string;
  color: string;
  cardIds: string[];
};

export type BoardTemplateDefinition = {
  columnId: string;
  title: string;
  cardTitle: string;
  cardIds: string[];
  fields: BoardTemplateField[];
};

export type BoardDocumentContent = {
  kind: "board";
  template: BoardTemplateDefinition;
  columns: BoardColumn[];
  cards: BoardCard[];
};

export type StructuredDocumentContent = TableDocumentContent | BoardDocumentContent;

export const BOARD_COLUMN_COLORS = [
  "#f3c969",
  "#9dd0ff",
  "#a9e7b3",
  "#efb1cf",
  "#c7b8ff",
  "#ffb38a",
] as const;

export const BOARD_CARD_STATUSES: BoardCardStatus[] = ["todo", "doing", "done", "paused"];

const DEFAULT_TABLE_COLUMN_WIDTH = 140;
const DEFAULT_TABLE_WORKBOOK_NAME = "Sheet";
const DEFAULT_TABLE_APP_VERSION = "justwork-univer";
const DEFAULT_TABLE_DEFAULT_ROW_HEIGHT = 36;
const DEFAULT_TABLE_ROW_HEADER_WIDTH = 52;
const DEFAULT_TABLE_COLUMN_HEADER_HEIGHT = 32;
const DEFAULT_TABLE_EXTRA_ROWS = 120;
const DEFAULT_TABLE_EXTRA_COLUMNS = 26;

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asTrimmedString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asPresentString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function normalizeColumnWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TABLE_COLUMN_WIDTH;
  return Math.max(140, Math.round(value));
}

function normalizeTableColumnType(value: unknown): TableColumnType {
  return value === "formula" ? "formula" : "text";
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createStructuredId(
  prefix: "col" | "row" | "column" | "card" | "field" | "template",
): string {
  return makeId(prefix);
}

export function resolveUniqueWorksheetName(existingNames: string[], requestedName: string): string {
  const normalizedExisting = new Set(
    existingNames
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
  const baseName = requestedName.trim() || DEFAULT_TABLE_WORKBOOK_NAME;
  if (!normalizedExisting.has(baseName)) return baseName;
  let suffix = 2;
  while (normalizedExisting.has(`${baseName} ${suffix}`)) {
    suffix += 1;
  }
  return `${baseName} ${suffix}`;
}

export function cloneBoardTemplateFieldToCardField(field: BoardTemplateField): BoardCardField {
  return {
    id: createStructuredId("field"),
    templateFieldId: field.id,
    name: field.name,
    value: field.defaultValue,
  };
}

export function createBoardCardFromTemplate(
  template: BoardTemplateDefinition,
  title = "Untitled card",
): BoardCard {
  return {
    id: createStructuredId("card"),
    title: title.trim() || "Untitled card",
    status: "todo",
    fields: template.fields.map((field) => cloneBoardTemplateFieldToCardField(field)),
  };
}

export function cloneBoardCardPrototype(card: BoardCard): BoardCard {
  return {
    id: createStructuredId("card"),
    title: card.title.trim() || "Untitled card",
    status: card.status,
    fields: card.fields.map((field) => ({
      id: createStructuredId("field"),
      templateFieldId: field.templateFieldId,
      name: field.name,
      value: field.value,
    })),
  };
}

function normalizeBoardCardStatus(value: unknown): BoardCardStatus {
  return value === "doing" || value === "done" || value === "paused" ? value : "todo";
}

export function reconcileBoardCardWithTemplate(
  card: BoardCard,
  template: BoardTemplateDefinition,
): BoardCard {
  const existingByTemplateId = new Map<string, BoardCardField>();
  const customFields: BoardCardField[] = [];
  for (const field of card.fields) {
    if (field.templateFieldId) {
      existingByTemplateId.set(field.templateFieldId, field);
    } else {
      customFields.push(field);
    }
  }
  const nextFields = template.fields.map((templateField) => {
    const existing = existingByTemplateId.get(templateField.id);
    if (!existing) {
      return cloneBoardTemplateFieldToCardField(templateField);
    }
    return {
      ...existing,
      name: templateField.name,
    };
  });
  return {
    ...card,
    fields: [...nextFields, ...customFields],
  };
}

export function boardCardSummary(card: BoardCard, maxItems = 3): string[] {
  const items = card.fields
    .map((field) => `${field.name}: ${field.value}`.trim())
    .filter((entry) => entry !== ":" && entry.length > 0)
    .slice(0, maxItems);
  return items;
}

function defaultTableColumns(): TableColumn[] {
  return [
    { id: "col_name", title: "Name", type: "text", width: 180 },
    { id: "col_notes", title: "Notes", type: "text", width: 220 },
  ];
}

function defaultTableRows(): TableRow[] {
  return [
    {
      id: "row_1",
      cells: {
        col_name: "Untitled row",
        col_notes: "",
      },
    },
  ];
}

function workbookBoolean(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function asIntegerKeySet(value: unknown): number[] {
  if (!value || typeof value !== "object") return [];
  return Object.keys(value as Record<string, unknown>)
    .map((key) => Number.parseInt(key, 10))
    .filter((key) => Number.isInteger(key) && key >= 0)
    .sort((left, right) => left - right);
}

function cellStringValue(value: unknown): string {
  const record = asRecord(value);
  if (typeof record.f === "string" && record.f.length > 0) return record.f;
  if (typeof record.v === "string") return record.v;
  if (typeof record.v === "number" || typeof record.v === "boolean") return String(record.v);
  return "";
}

function createWorkbookCell(value: string): Record<string, unknown> {
  if (!value) return { v: "" };
  if (value.startsWith("=")) {
    return { f: value };
  }
  return { v: value };
}

function getPrimaryWorksheet(workbookData: Record<string, unknown>): Record<string, unknown> | null {
  const sheets = asRecord(workbookData.sheets);
  const sheetOrder = Array.isArray(workbookData.sheetOrder) ? workbookData.sheetOrder : [];
  for (const sheetId of sheetOrder) {
    if (typeof sheetId !== "string") continue;
    const sheet = sheets[sheetId];
    if (sheet && typeof sheet === "object") {
      return asRecord(sheet);
    }
  }
  const fallback = Object.values(sheets).find((sheet) => sheet && typeof sheet === "object");
  return fallback ? asRecord(fallback) : null;
}

export function tableContentToWorkbookData(content: TableDocumentContent): Record<string, unknown> {
  const existing = content.workbookData ? cloneJson(content.workbookData) : {};
  const existingSheets = asRecord(existing.sheets);
  const existingSheetOrder = Array.isArray(existing.sheetOrder)
    ? existing.sheetOrder.filter((sheetId): sheetId is string => typeof sheetId === "string" && sheetId.trim().length > 0)
    : [];
  const existingSheet = getPrimaryWorksheet(existing);
  const workbookId = asTrimmedString(existing.id, createStructuredId("template"));
  const sheetId = asTrimmedString(existingSheet?.id, "sheet_1");
  const sheetName = asTrimmedString(existingSheet?.name, DEFAULT_TABLE_WORKBOOK_NAME);
  const columnData: Record<string, unknown> = {};
  const rowData: Record<string, unknown> = {
    "0": { h: DEFAULT_TABLE_DEFAULT_ROW_HEIGHT },
  };
  const headerCells: Record<string, unknown> = {};
  const cellData: Record<string, unknown> = {
    "0": headerCells,
  };

  content.columns.forEach((column, columnIndex) => {
    columnData[String(columnIndex)] = {
      w: column.width,
      custom: {
        justworkColumnId: column.id,
        justworkColumnType: column.type,
      },
    };
    headerCells[String(columnIndex)] = createWorkbookCell(column.title);
  });

  content.rows.forEach((row, rowIndex) => {
    const sheetRowIndex = rowIndex + 1;
    rowData[String(sheetRowIndex)] = {
      custom: {
        justworkRowId: row.id,
      },
    };
    const sheetRow: Record<string, unknown> = {};
    content.columns.forEach((column, columnIndex) => {
      sheetRow[String(columnIndex)] = createWorkbookCell(row.cells[column.id] ?? "");
    });
    cellData[String(sheetRowIndex)] = sheetRow;
  });

  const columnCount = Math.max(content.columns.length + DEFAULT_TABLE_EXTRA_COLUMNS, content.columns.length || 1);
  const rowCount = Math.max(content.rows.length + 1 + DEFAULT_TABLE_EXTRA_ROWS, content.rows.length + 1);
  const preservedSheetIds = existingSheetOrder.filter((existingId) => existingId !== sheetId && typeof existingSheets[existingId] === "object");
  const preservedSheets = Object.fromEntries(
    preservedSheetIds.map((existingId) => [existingId, cloneJson(existingSheets[existingId] as Record<string, unknown>)]),
  );

  return {
    id: workbookId,
    name: asTrimmedString(existing.name, DEFAULT_TABLE_WORKBOOK_NAME),
    appVersion: typeof existing.appVersion === "string" ? existing.appVersion : DEFAULT_TABLE_APP_VERSION,
    locale: typeof existing.locale === "string" ? existing.locale : "zhCN",
    styles: asRecord(existing.styles),
    sheetOrder: [sheetId, ...preservedSheetIds],
    sheets: {
      ...preservedSheets,
      [sheetId]: {
        id: sheetId,
        name: sheetName,
        tabColor: typeof existingSheet?.tabColor === "string" ? existingSheet.tabColor : "",
        hidden: typeof existingSheet?.hidden === "number" ? existingSheet.hidden : 0,
        freeze: {
          xSplit: 0,
          ySplit: content.frozenHeader ? 1 : 0,
          startRow: content.frozenHeader ? 1 : 0,
          startColumn: 0,
        },
        rowCount,
        columnCount,
        zoomRatio: typeof existingSheet?.zoomRatio === "number" ? existingSheet.zoomRatio : 1,
        scrollTop: typeof existingSheet?.scrollTop === "number" ? existingSheet.scrollTop : 0,
        scrollLeft: typeof existingSheet?.scrollLeft === "number" ? existingSheet.scrollLeft : 0,
        defaultColumnWidth: typeof existingSheet?.defaultColumnWidth === "number"
          ? existingSheet.defaultColumnWidth
          : DEFAULT_TABLE_COLUMN_WIDTH,
        defaultRowHeight: typeof existingSheet?.defaultRowHeight === "number"
          ? existingSheet.defaultRowHeight
          : DEFAULT_TABLE_DEFAULT_ROW_HEIGHT,
        mergeData: Array.isArray(existingSheet?.mergeData) ? existingSheet.mergeData : [],
        cellData,
        rowData,
        columnData,
        rowHeader: {
          width: typeof asRecord(existingSheet?.rowHeader).width === "number"
            ? (asRecord(existingSheet?.rowHeader).width as number)
            : DEFAULT_TABLE_ROW_HEADER_WIDTH,
          hidden: typeof asRecord(existingSheet?.rowHeader).hidden === "number"
            ? (asRecord(existingSheet?.rowHeader).hidden as number)
            : 0,
        },
        columnHeader: {
          height: typeof asRecord(existingSheet?.columnHeader).height === "number"
            ? (asRecord(existingSheet?.columnHeader).height as number)
            : DEFAULT_TABLE_COLUMN_HEADER_HEIGHT,
          hidden: typeof asRecord(existingSheet?.columnHeader).hidden === "number"
            ? (asRecord(existingSheet?.columnHeader).hidden as number)
            : 0,
        },
        showGridlines: typeof existingSheet?.showGridlines === "number" ? existingSheet.showGridlines : 1,
        gridlinesColor: typeof existingSheet?.gridlinesColor === "string" ? existingSheet.gridlinesColor : "#d7dbe0",
        rightToLeft: typeof existingSheet?.rightToLeft === "number" ? existingSheet.rightToLeft : 0,
        defaultStyle: existingSheet?.defaultStyle,
        custom: existingSheet?.custom,
      },
    },
    defaultStyle: existing.defaultStyle,
    resources: existing.resources,
    custom: existing.custom,
  };
}

function extractTableFromWorkbookData(workbookData: Record<string, unknown>): {
  frozenHeader: boolean;
  columns: TableColumn[];
  rows: TableRow[];
} {
  const worksheet = getPrimaryWorksheet(workbookData);
  if (!worksheet) {
    return {
      frozenHeader: true,
      columns: defaultTableColumns(),
      rows: defaultTableRows(),
    };
  }

  const worksheetCellData = asRecord(worksheet.cellData);
  const worksheetColumnData = asRecord(worksheet.columnData);
  const worksheetRowData = asRecord(worksheet.rowData);
  const headerRow = asRecord(worksheetCellData["0"]);

  let maxColumnIndex = -1;
  for (const key of asIntegerKeySet(worksheetColumnData)) maxColumnIndex = Math.max(maxColumnIndex, key);
  for (const key of asIntegerKeySet(headerRow)) maxColumnIndex = Math.max(maxColumnIndex, key);
  for (const rowIndex of asIntegerKeySet(worksheetCellData)) {
    const row = asRecord(worksheetCellData[String(rowIndex)]);
    for (const key of asIntegerKeySet(row)) maxColumnIndex = Math.max(maxColumnIndex, key);
  }

  const defaultColumns = defaultTableColumns();
  const columnCount = Math.max(maxColumnIndex + 1, defaultColumns.length);
  const columns: TableColumn[] = [];
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const columnRecord = asRecord(worksheetColumnData[String(columnIndex)]);
    const custom = asRecord(columnRecord.custom);
    const fallback = defaultColumns[columnIndex] ?? {
      id: `col_${columnIndex + 1}`,
      title: `Column ${columnIndex + 1}`,
      type: "text" as const,
      width: DEFAULT_TABLE_COLUMN_WIDTH,
    };
    columns.push({
      id: asTrimmedString(custom.justworkColumnId, fallback.id),
      title: asPresentString(cellStringValue(headerRow[String(columnIndex)]), fallback.title),
      type: normalizeTableColumnType(custom.justworkColumnType),
      width: normalizeColumnWidth(columnRecord.w ?? fallback.width),
    });
  }

  let maxRowIndex = 0;
  for (const rowIndex of asIntegerKeySet(worksheetCellData)) {
    if (rowIndex > 0) maxRowIndex = Math.max(maxRowIndex, rowIndex);
  }
  for (const rowIndex of asIntegerKeySet(worksheetRowData)) {
    if (rowIndex > 0) maxRowIndex = Math.max(maxRowIndex, rowIndex);
  }
  if (maxRowIndex === 0) maxRowIndex = 1;

  const rows: TableRow[] = [];
  for (let rowIndex = 1; rowIndex <= maxRowIndex; rowIndex += 1) {
    const rowRecord = asRecord(worksheetCellData[String(rowIndex)]);
    const rowMeta = asRecord(worksheetRowData[String(rowIndex)]);
    const custom = asRecord(rowMeta.custom);
    const cells: Record<string, string> = {};
    columns.forEach((column, columnIndex) => {
      cells[column.id] = cellStringValue(rowRecord[String(columnIndex)]);
    });
    rows.push({
      id: asTrimmedString(custom.justworkRowId, `row_${rowIndex}`),
      cells,
    });
  }

  const freeze = asRecord(worksheet.freeze);
  return {
    frozenHeader: Number(freeze.ySplit ?? 0) > 0 || Number(freeze.startRow ?? 0) > 0,
    columns,
    rows,
  };
}

export function createDefaultTableContent(): TableDocumentContent {
  const content: TableDocumentContent = {
    kind: "table",
    frozenHeader: true,
    columns: defaultTableColumns(),
    rows: defaultTableRows(),
  };
  return {
    ...content,
    workbookData: tableContentToWorkbookData(content),
  };
}

export function createDefaultBoardContent(): BoardDocumentContent {
  const template: BoardTemplateDefinition = {
    columnId: "template_lane",
    title: "Card template",
    cardTitle: "Untitled card",
    cardIds: [],
    fields: [
      { id: "template_summary", name: "Summary", defaultValue: "" },
      { id: "template_details", name: "Details", defaultValue: "" },
    ],
  };
  const templateCard = createBoardCardFromTemplate(template, template.cardTitle);
  template.cardIds = [templateCard.id];
  const starterCard = cloneBoardCardPrototype(templateCard);
  return {
    kind: "board",
    template,
    columns: [
      { id: "todo", title: "To do", color: BOARD_COLUMN_COLORS[0], cardIds: [starterCard.id] },
      { id: "doing", title: "Doing", color: BOARD_COLUMN_COLORS[1], cardIds: [] },
      { id: "done", title: "Done", color: BOARD_COLUMN_COLORS[2], cardIds: [] },
    ],
    cards: [templateCard, starterCard],
  };
}

export function isStructuredDocumentContent(value: unknown): value is StructuredDocumentContent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    (Array.isArray(record.rows) && Array.isArray(record.columns)) ||
    (Array.isArray(record.columns) && Array.isArray(record.cards) && typeof record.template === "object")
  );
}

function normalizeTableColumn(value: unknown, index: number): TableColumn {
  const record = asRecord(value);
  return {
    id: asTrimmedString(record.id, `col_${index + 1}`),
    title: asPresentString(record.title, `Column ${index + 1}`),
    type: normalizeTableColumnType(record.type),
    width: normalizeColumnWidth(record.width),
  };
}

function normalizeTableRow(value: unknown, columns: TableColumn[], index: number): TableRow {
  const record = asRecord(value);
  const cellsInput = asRecord(record.cells);
  const cells: Record<string, string> = {};
  for (const column of columns) {
    cells[column.id] = typeof cellsInput[column.id] === "string" ? (cellsInput[column.id] as string) : "";
  }
  return {
    id: asTrimmedString(record.id, `row_${index + 1}`),
    cells,
  };
}

function normalizeBoardTemplateField(value: unknown, index: number): BoardTemplateField {
  const record = asRecord(value);
  return {
    id: asTrimmedString(record.id, `template_field_${index + 1}`),
    name: asPresentString(record.name, `Field ${index + 1}`),
    defaultValue: typeof record.defaultValue === "string" ? record.defaultValue : "",
  };
}

function normalizeBoardCardField(value: unknown, index: number): BoardCardField {
  const record = asRecord(value);
  const templateFieldId = typeof record.templateFieldId === "string" && record.templateFieldId.trim()
    ? record.templateFieldId
    : null;
  return {
    id: asTrimmedString(record.id, `field_${index + 1}`),
    templateFieldId,
    name: asPresentString(record.name, `Field ${index + 1}`),
    value: typeof record.value === "string" ? record.value : "",
  };
}

function normalizeBoardCard(value: unknown, index: number, template: BoardTemplateDefinition): BoardCard {
  const record = asRecord(value);
  const fieldsInput = Array.isArray(record.fields)
    ? record.fields
    : typeof record.description === "string"
      ? template.fields.map((field, fieldIndex) => ({
          id: `legacy_field_${index + 1}_${fieldIndex + 1}`,
          templateFieldId: field.id,
          name: field.name,
          value: fieldIndex === 0 ? record.description : "",
        }))
      : [];
  const fields = fieldsInput.map((field, fieldIndex) => normalizeBoardCardField(field, fieldIndex));
  return reconcileBoardCardWithTemplate(
    {
      id: asTrimmedString(record.id, `card_${index + 1}`),
      title: typeof record.title === "string" ? record.title : "",
      status: normalizeBoardCardStatus(record.status),
      fields,
    },
    template,
  );
}

function normalizeBoardColumn(value: unknown, index: number, availableCardIds: Set<string>): BoardColumn {
  const record = asRecord(value);
  const rawCardIds = Array.isArray(record.cardIds) ? record.cardIds : [];
  const cardIds = rawCardIds
    .filter((cardId): cardId is string => typeof cardId === "string" && availableCardIds.has(cardId));
  return {
    id: asTrimmedString(record.id, `column_${index + 1}`),
    title: asPresentString(record.title, `Column ${index + 1}`),
    color: typeof record.color === "string" && record.color.trim()
      ? record.color
      : BOARD_COLUMN_COLORS[index % BOARD_COLUMN_COLORS.length],
    cardIds,
  };
}

function normalizeBoardTemplateBase(value: unknown): Omit<BoardTemplateDefinition, "cardIds"> {
  const defaults = createDefaultBoardContent().template;
  const record = asRecord(value);
  const fields = (Array.isArray(record.fields) ? record.fields : [])
    .map((field, index) => normalizeBoardTemplateField(field, index));
  return {
    columnId: asTrimmedString(record.columnId, defaults.columnId),
    title: asPresentString(record.title, defaults.title),
    cardTitle: asPresentString(record.cardTitle, defaults.cardTitle),
    fields: fields.length > 0 ? fields : defaults.fields.map((field) => ({ ...field })),
  };
}

export function normalizeStructuredDocumentContent(
  kind: StructuredDocumentKind,
  value: unknown,
): StructuredDocumentContent {
  const record = asRecord(value);
  if (kind === "board") {
    const templateRecord = asRecord(record.template);
    const templateBase = normalizeBoardTemplateBase(templateRecord);
    const templateSkeleton: BoardTemplateDefinition = {
      ...templateBase,
      cardIds: [],
    };
    const cards = (Array.isArray(record.cards) ? record.cards : [])
      .map((card, index) => normalizeBoardCard(card, index, templateSkeleton));
    const templateCardIds = (Array.isArray(templateRecord.cardIds) ? templateRecord.cardIds : [])
      .filter((cardId): cardId is string => typeof cardId === "string" && cardId.trim().length > 0);
    const availableCardIds = new Set(cards.map((card) => card.id));
    const normalizedTemplateCardIds = templateCardIds.filter((cardId) => availableCardIds.has(cardId));
    if (normalizedTemplateCardIds.length === 0) {
      const templateCard = createBoardCardFromTemplate(templateSkeleton, templateBase.cardTitle);
      cards.unshift(templateCard);
      availableCardIds.add(templateCard.id);
      normalizedTemplateCardIds.push(templateCard.id);
    }
    const template: BoardTemplateDefinition = {
      ...templateBase,
      cardIds: normalizedTemplateCardIds,
    };
    const hasColumns = Array.isArray(record.columns);
    const columnsInput = hasColumns ? (record.columns as unknown[]) : [];
    const columns = columnsInput
      .map((column, index) => normalizeBoardColumn(column, index, availableCardIds))
      .map((column) => ({
        ...column,
        cardIds: column.cardIds.filter((cardId) => !normalizedTemplateCardIds.includes(cardId)),
      }));
    return {
      kind: "board",
      template,
      columns: hasColumns ? columns : createDefaultBoardContent().columns,
      cards,
    };
  }

  if (record.workbookData && typeof record.workbookData === "object") {
    const normalizedWorkbookData = cloneJson(record.workbookData as Record<string, unknown>);
    const extracted = extractTableFromWorkbookData(normalizedWorkbookData);
    return {
      kind: "table",
      frozenHeader: extracted.frozenHeader,
      columns: extracted.columns,
      rows: extracted.rows,
      workbookData: normalizedWorkbookData,
    };
  }

  const columns = (Array.isArray(record.columns) ? record.columns : [])
    .map((column, index) => normalizeTableColumn(column, index));
  const normalizedColumns = columns.length > 0 ? columns : createDefaultTableContent().columns;
  const rows = (Array.isArray(record.rows) ? record.rows : [])
    .map((row, index) => normalizeTableRow(row, normalizedColumns, index));
  const normalizedTable: TableDocumentContent = {
    kind: "table",
    frozenHeader: record.frozenHeader !== false,
    columns: normalizedColumns,
    rows: rows.length > 0
      ? rows
      : createDefaultTableContent().rows.map((row) => normalizeTableRow(row, normalizedColumns, 0)),
  };
  return {
    ...normalizedTable,
    workbookData: tableContentToWorkbookData(normalizedTable),
  };
}
