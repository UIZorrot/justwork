import { createUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import UniverPresetSheetsCoreEnUS from "@univerjs/preset-sheets-core/locales/en-US";
import UniverPresetSheetsCoreZhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import {
  normalizeStructuredDocumentContent,
  resolveUniqueWorksheetName,
  tableContentToWorkbookData,
  type TableDocumentContent,
} from "./structured-document";

type DocumentLike = Pick<
  Document,
  "createElement" | "defaultView" | "addEventListener" | "removeEventListener"
>;

export type TableViewOptions = {
  document: DocumentLike;
  content: TableDocumentContent;
  locale?: "en" | "zh-CN";
  onChange?: (
    content: TableDocumentContent,
    previousContent: TableDocumentContent,
  ) => TableDocumentContent | void;
  labels?: {
    addColumn?: string;
    addRow?: string;
    deleteColumn?: string;
    deleteRow?: string;
    freezeHeader?: string;
    addSheet?: string;
    createSheet?: string;
    cancelSheet?: string;
    sheetNamePlaceholder?: string;
  };
};

export type TableViewHandle = {
  element: HTMLElement;
  update: (content: TableDocumentContent) => void;
  destroy?: () => void;
};

type WorkbookRangeLike = {
  getRange(): {
    startRow: number;
    endRow: number;
    startColumn: number;
    endColumn: number;
  };
};

type WorkbookSheetLike = {
  getSheetId(): string;
  getSheetName(): string;
  getMaxRows(): number;
  getMaxColumns(): number;
  getRange(range: {
    startRow: number;
    endRow: number;
    startColumn: number;
    endColumn: number;
  }): WorkbookRangeLike;
  getRange(
    row: number,
    column: number,
    numRows: number,
    numColumns: number,
  ): WorkbookRangeLike;
};

type WorkbookLike = {
  getId(): string;
  onCommandExecuted(listener: () => void): { dispose: () => void };
  save(): unknown;
  getSheets(): WorkbookSheetLike[];
  getActiveSheet(): WorkbookSheetLike;
  getActiveRange(): WorkbookRangeLike | null;
  getSheetBySheetId(sheetId: string): WorkbookSheetLike | null;
  getSheetByName(name: string): WorkbookSheetLike | null;
  create(name: string, rows: number, columns: number): WorkbookSheetLike;
  setActiveSheet(sheet: WorkbookSheetLike | string): unknown;
  setActiveRange(range: WorkbookRangeLike): unknown;
};

type WorkbookSelectionState = {
  sheetId: string;
  sheetName: string;
  range: ReturnType<WorkbookRangeLike["getRange"]>;
};

const LOCAL_CHANGE_DEBOUNCE_MS = 120;
const EXTERNAL_UPDATE_IDLE_MS = 700;

function serializeWorkbookData(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

export function createTableView(options: TableViewOptions): TableViewHandle {
  let current = normalizeStructuredDocumentContent("table", options.content) as TableDocumentContent;
  let workbookSignature = serializeWorkbookData(tableContentToWorkbookData(current));
  let currentWorkbookId: string | null = null;
  let currentWorkbook: WorkbookLike | null = null;
  let commandSubscription: { dispose: () => void } | null = null;
  let suppressLocalEmit = false;
  let disposed = false;
  let emitTimer: ReturnType<typeof setTimeout> | null = null;
  let externalUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  let deferredExternalContent: TableDocumentContent | null = null;
  let lastLocalCommandAt = 0;
  let hasUncommittedEditorInput = false;
  let suppressReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  let sheetComposerDockTimer: ReturnType<typeof setTimeout> | null = null;
  let sheetComposerOpen = false;
  let pendingSelectionRestore: WorkbookSelectionState | null = null;

  const root = options.document.createElement("div") as HTMLElement;
  root.className = "structured-surface structured-sheet";

  const host = options.document.createElement("div") as HTMLElement;
  host.className = "structured-sheet-host";
  const runtimeHost = options.document.createElement("div") as HTMLElement;
  runtimeHost.className = "structured-sheet-runtime";
  host.append(runtimeHost);
  root.append(host);

  const sheetFooter = options.document.createElement("div") as HTMLElement;
  sheetFooter.className = "structured-sheet-footer";
  const sheetComposer = options.document.createElement("div") as HTMLElement;
  sheetComposer.className = "structured-sheet-composer";
  const sheetComposerToggle = options.document.createElement("button") as HTMLButtonElement;
  sheetComposerToggle.type = "button";
  sheetComposerToggle.className = "structured-sheet-add-tab-btn";
  sheetComposerToggle.textContent = "+";
  sheetComposerToggle.setAttribute("aria-label", options.labels?.addSheet ?? "Add worksheet");
  sheetComposerToggle.title = options.labels?.addSheet ?? "Add worksheet";
  const sheetComposerPopover = options.document.createElement("div") as HTMLElement;
  sheetComposerPopover.className = "structured-sheet-composer-popover";
  const sheetComposerInput = options.document.createElement("input") as HTMLInputElement;
  sheetComposerInput.type = "text";
  sheetComposerInput.className = "structured-sheet-composer-input";
  sheetComposerInput.placeholder = options.labels?.sheetNamePlaceholder ?? "New child sheet";
  const sheetComposerActions = options.document.createElement("div") as HTMLElement;
  sheetComposerActions.className = "structured-sheet-composer-actions";
  const sheetComposerCancel = options.document.createElement("button") as HTMLButtonElement;
  sheetComposerCancel.type = "button";
  sheetComposerCancel.className = "structured-sheet-composer-btn is-secondary";
  sheetComposerCancel.textContent = options.labels?.cancelSheet ?? "Cancel";
  const sheetComposerCreate = options.document.createElement("button") as HTMLButtonElement;
  sheetComposerCreate.type = "button";
  sheetComposerCreate.className = "structured-sheet-composer-btn";
  sheetComposerCreate.textContent = options.labels?.createSheet ?? "Create";
  sheetComposerActions.append(sheetComposerCancel, sheetComposerCreate);
  sheetComposerPopover.append(sheetComposerInput, sheetComposerActions);
  sheetComposer.append(sheetComposerToggle);
  sheetFooter.append(sheetComposer);
  // Keep the trigger in Univer's footer, but portal the popover to the sheet
  // host. Univer's canvas and scrollbar create their own stacking contexts;
  // a popover nested in the footer can therefore be painted underneath them.
  host.append(sheetFooter, sheetComposerPopover);

  const univerLocale = options.locale === "en" ? LocaleType.EN_US : LocaleType.ZH_CN;
  const univerMessages = options.locale === "en" ? UniverPresetSheetsCoreEnUS : UniverPresetSheetsCoreZhCN;
  const { univer, univerAPI } = createUniver({
    locale: univerLocale,
    locales: {
      [univerLocale]: mergeLocales(univerMessages),
    },
    presets: [
      UniverSheetsCorePreset({
        container: runtimeHost,
        header: false,
        toolbar: true,
        ribbonType: "simple",
        formulaBar: true,
        footer: {
          sheetBar: true,
          statisticBar: false,
          zoomSlider: true,
          addSheetButtonConfig: {
            show: false,
            defaultRowCount: 160,
            defaultColumnCount: 28,
          },
        },
        contextMenu: true,
      }),
    ],
  });

  const clearEmitTimer = (): void => {
    if (emitTimer !== null) {
      clearTimeout(emitTimer);
      emitTimer = null;
    }
  };

  const clearExternalUpdateTimer = (): void => {
    if (externalUpdateTimer !== null) {
      clearTimeout(externalUpdateTimer);
      externalUpdateTimer = null;
    }
  };

  const isUniverEditorEvent = (event: Event): boolean => {
    const target = event.target as { getAttribute?: (name: string) => string | null } | null;
    return target?.getAttribute?.("data-u-comp") === "editor";
  };

  const markUncommittedEditorInput = (event: Event): void => {
    if (!isUniverEditorEvent(event)) return;
    hasUncommittedEditorInput = true;
    lastLocalCommandAt = Date.now();
  };

  const releaseCancelledEditorInput = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !isUniverEditorEvent(event)) return;
    hasUncommittedEditorInput = false;
  };

  const selectEntireWorksheet = (event: KeyboardEvent): void => {
    if (
      event.key.toLowerCase() !== "a"
      || (!event.ctrlKey && !event.metaKey)
      || event.altKey
      || !currentWorkbook
      || !root.isConnected
      || root.getClientRects().length === 0
    ) return;
    const target = event.target as {
      tagName?: string;
      isContentEditable?: boolean;
    } | null;
    const isUniverEditor = isUniverEditorEvent(event);
    if (
      !isUniverEditor
      && (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT" || target?.isContentEditable)
    ) return;
    if (!isUniverEditor) {
      if (!(event.target instanceof Node) || !runtimeHost.contains(event.target)) return;
    }
    try {
      const sheet = currentWorkbook.getActiveSheet();
      currentWorkbook.setActiveRange(sheet.getRange(
        0,
        0,
        Math.max(1, sheet.getMaxRows()),
        Math.max(1, sheet.getMaxColumns()),
      ));
      event.preventDefault();
      event.stopImmediatePropagation();
    } catch {
      // The active sheet may disappear concurrently; Univer can handle the key.
    }
  };

  options.document.addEventListener("beforeinput", markUncommittedEditorInput, true);
  options.document.addEventListener("keydown", releaseCancelledEditorInput, true);
  options.document.addEventListener("keydown", selectEntireWorksheet, true);

  const clearSheetComposerDockTimer = (): void => {
    if (sheetComposerDockTimer !== null) {
      clearTimeout(sheetComposerDockTimer);
      sheetComposerDockTimer = null;
    }
  };

  const captureWorkbookSelection = (): WorkbookSelectionState | null => {
    if (!currentWorkbook) return null;
    try {
      const sheet = currentWorkbook.getActiveSheet();
      const range = currentWorkbook.getActiveRange();
      if (!sheet || !range) return null;
      return {
        sheetId: sheet.getSheetId(),
        sheetName: sheet.getSheetName(),
        range: range.getRange(),
      };
    } catch {
      return null;
    }
  };

  const restoreWorkbookSelection = (
    workbook: WorkbookLike,
    selection: WorkbookSelectionState | null,
  ): void => {
    if (!selection) return;
    try {
      const sheet = workbook.getSheetBySheetId(selection.sheetId)
        ?? workbook.getSheetByName(selection.sheetName);
      if (!sheet) return;
      workbook.setActiveSheet(sheet);
      workbook.setActiveRange(sheet.getRange(selection.range));
    } catch {
      // A concurrently removed sheet/range has no selection to restore.
    }
  };

  const ensureFallbackSheetComposerMount = (): void => {
    if (!sheetComposer.isConnected) {
      sheetFooter.append(sheetComposer);
    }
    if (!sheetFooter.isConnected) {
      host.append(sheetFooter);
    }
    sheetComposer.classList.remove("is-docked");
  };

  const positionSheetComposerPopover = (): void => {
    if (!sheetComposerOpen || !sheetComposerToggle.isConnected) return;
    const hostRect = host.getBoundingClientRect();
    const toggleRect = sheetComposerToggle.getBoundingClientRect();
    const popoverWidth = sheetComposerPopover.offsetWidth || 250;
    const requestedLeft = toggleRect.left - hostRect.left;
    const maxLeft = Math.max(8, host.clientWidth - popoverWidth - 8);
    sheetComposerPopover.style.left = `${Math.min(Math.max(8, requestedLeft), maxLeft)}px`;
    sheetComposerPopover.style.bottom = `${Math.max(40, hostRect.bottom - toggleRect.top + 6)}px`;
  };

  const dockSheetComposerIntoFooter = (): boolean => {
    const leftControls = Array.from(runtimeHost.querySelectorAll('[data-range-selector="true"]'))
      .map((footer) => footer.querySelector(
        '.univer-relative.univer-flex.univer-h-full.univer-min-w-0.univer-flex-1 > .univer-flex.univer-items-center',
      ))
      .find((candidate) => candidate instanceof HTMLElement);
    if (!(leftControls instanceof HTMLElement)) {
      return false;
    }
    leftControls.prepend(sheetComposer);
    sheetComposer.classList.add("is-docked");
    if (sheetFooter.isConnected) {
      sheetFooter.remove();
    }
    positionSheetComposerPopover();
    return true;
  };

  const scheduleSheetComposerDock = (attempt = 0): void => {
    if (disposed) return;
    ensureFallbackSheetComposerMount();
    if (dockSheetComposerIntoFooter()) {
      return;
    }
    if (attempt >= 12) {
      return;
    }
    clearSheetComposerDockTimer();
    const schedule = options.document.defaultView?.setTimeout?.bind(options.document.defaultView) ?? setTimeout;
    sheetComposerDockTimer = schedule(() => {
      sheetComposerDockTimer = null;
      scheduleSheetComposerDock(attempt + 1);
    }, attempt === 0 ? 0 : 40);
  };

  const publishWorkbookSnapshot = (): void => {
    if (!currentWorkbook || suppressLocalEmit || disposed) return;
    const savedSnapshot = currentWorkbook.save() as Record<string, unknown>;
    const nextSignature = serializeWorkbookData(savedSnapshot);
    if (nextSignature === workbookSignature) return;
    workbookSignature = nextSignature;
    const previousContent = current;
    current = normalizeStructuredDocumentContent("table", { workbookData: savedSnapshot }) as TableDocumentContent;
    const convergedContent = options.onChange?.(current, previousContent);
    if (convergedContent?.kind === "table") {
      current = normalizeStructuredDocumentContent("table", convergedContent) as TableDocumentContent;
    }
    hasUncommittedEditorInput = false;
    // Any external snapshot queued before this local command was published is
    // based on an older workbook view. The collaborator now owns the merged
    // state, so rebuilding from that queued snapshot could erase the cell the
    // user just committed.
    deferredExternalContent = null;
    clearExternalUpdateTimer();
  };

  const syncSheetComposer = (): void => {
    sheetComposer.dataset.open = sheetComposerOpen ? "true" : "false";
    sheetComposerPopover.dataset.open = sheetComposerOpen ? "true" : "false";
    sheetComposerToggle.setAttribute("aria-expanded", sheetComposerOpen ? "true" : "false");
    positionSheetComposerPopover();
    if (!sheetComposerOpen) {
      sheetComposerInput.value = "";
    }
  };

  const closeSheetComposer = (): void => {
    sheetComposerOpen = false;
    syncSheetComposer();
  };

  const createNamedSheet = (): void => {
    if (!currentWorkbook) return;
    const existingNames = currentWorkbook.getSheets().map((sheet) => sheet.getSheetName());
    const nextName = resolveUniqueWorksheetName(existingNames, sheetComposerInput.value);
    const nextSheet = currentWorkbook.create(nextName, 160, 28);
    currentWorkbook.setActiveSheet(nextSheet);
    publishWorkbookSnapshot();
    closeSheetComposer();
  };

  const queueSuppressRelease = (): void => {
    if (suppressReleaseTimer !== null) {
      clearTimeout(suppressReleaseTimer);
    }
    const release = options.document.defaultView?.setTimeout?.bind(options.document.defaultView) ?? setTimeout;
    suppressReleaseTimer = release(() => {
      if (currentWorkbook) {
        const stableSnapshot = currentWorkbook.save() as Record<string, unknown>;
        workbookSignature = serializeWorkbookData(stableSnapshot);
        current = normalizeStructuredDocumentContent("table", {
          workbookData: stableSnapshot,
        }) as TableDocumentContent;
        restoreWorkbookSelection(currentWorkbook, pendingSelectionRestore);
        pendingSelectionRestore = null;
      }
      suppressLocalEmit = false;
      suppressReleaseTimer = null;
    }, 0);
  };

  const bindWorkbook = (snapshot: Record<string, unknown>): void => {
    const selectionState = captureWorkbookSelection();
    commandSubscription?.dispose();
    commandSubscription = null;
    if (currentWorkbookId) {
      univerAPI.disposeUnit(currentWorkbookId);
      currentWorkbookId = null;
    }
    const workbook = univerAPI.createWorkbook(snapshot) as WorkbookLike;
    currentWorkbook = workbook;
    currentWorkbookId = workbook.getId();
    const boundSnapshot = workbook.save() as Record<string, unknown>;
    workbookSignature = serializeWorkbookData(boundSnapshot);
    current = normalizeStructuredDocumentContent("table", {
      workbookData: boundSnapshot,
    }) as TableDocumentContent;
    pendingSelectionRestore = selectionState;
    restoreWorkbookSelection(workbook, selectionState);
    commandSubscription = workbook.onCommandExecuted(() => {
      if (disposed || suppressLocalEmit) return;
      lastLocalCommandAt = Date.now();
      clearEmitTimer();
      emitTimer = setTimeout(() => {
        emitTimer = null;
        publishWorkbookSnapshot();
      }, LOCAL_CHANGE_DEBOUNCE_MS);
    });
    scheduleSheetComposerDock();
  };

  sheetComposerToggle.addEventListener("click", () => {
    sheetComposerOpen = !sheetComposerOpen;
    syncSheetComposer();
    if (sheetComposerOpen) {
      const focus = options.document.defaultView?.requestAnimationFrame?.bind(options.document.defaultView) ?? ((cb: FrameRequestCallback) => setTimeout(cb, 0));
      focus(() => sheetComposerInput.focus());
    }
  });
  sheetComposerCancel.addEventListener("click", closeSheetComposer);
  sheetComposerCreate.addEventListener("click", createNamedSheet);
  sheetComposerInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      createNamedSheet();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSheetComposer();
    }
  });
  syncSheetComposer();

  suppressLocalEmit = true;
  bindWorkbook(tableContentToWorkbookData(current));
  queueSuppressRelease();

  return {
    element: root,
    update(content: TableDocumentContent) {
      const normalized = normalizeStructuredDocumentContent("table", content) as TableDocumentContent;
      const nextWorkbookData = tableContentToWorkbookData(normalized);
      const nextSignature = serializeWorkbookData(nextWorkbookData);
      if (nextSignature === workbookSignature) {
        current = normalized;
        return;
      }
      const remainingIdleMs = EXTERNAL_UPDATE_IDLE_MS - (Date.now() - lastLocalCommandAt);
      if (hasUncommittedEditorInput || emitTimer !== null || remainingIdleMs > 0) {
        deferredExternalContent = normalized;
        clearExternalUpdateTimer();
        externalUpdateTimer = setTimeout(() => {
          externalUpdateTimer = null;
          const deferred = deferredExternalContent;
          deferredExternalContent = null;
          if (deferred && !disposed) {
            this.update(deferred);
          }
        }, Math.max(LOCAL_CHANGE_DEBOUNCE_MS, remainingIdleMs));
        return;
      }
      deferredExternalContent = null;
      clearExternalUpdateTimer();
      current = {
        ...normalized,
        workbookData: nextWorkbookData,
      };
      workbookSignature = nextSignature;
      suppressLocalEmit = true;
      clearEmitTimer();
      clearExternalUpdateTimer();
      deferredExternalContent = null;
      bindWorkbook(nextWorkbookData);
      queueSuppressRelease();
    },
    destroy() {
      disposed = true;
      options.document.removeEventListener("beforeinput", markUncommittedEditorInput, true);
      options.document.removeEventListener("keydown", releaseCancelledEditorInput, true);
      options.document.removeEventListener("keydown", selectEntireWorksheet, true);
      clearEmitTimer();
      clearSheetComposerDockTimer();
      if (suppressReleaseTimer !== null) {
        clearTimeout(suppressReleaseTimer);
        suppressReleaseTimer = null;
      }
      commandSubscription?.dispose();
      commandSubscription = null;
      if (currentWorkbookId) {
        univerAPI.disposeUnit(currentWorkbookId);
        currentWorkbookId = null;
      }
      currentWorkbook = null;
      univer.dispose();
    },
  };
}
