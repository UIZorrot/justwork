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

type DocumentLike = Pick<Document, "createElement" | "defaultView">;

export type TableViewOptions = {
  document: DocumentLike;
  content: TableDocumentContent;
  locale?: "en" | "zh-CN";
  onChange?: (content: TableDocumentContent) => void;
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

type WorkbookLike = {
  getId(): string;
  onCommandExecuted(listener: () => void): { dispose: () => void };
  save(): unknown;
  getSheets(): Array<{ getSheetName(): string }>;
  create(name: string, rows: number, columns: number): unknown;
  setActiveSheet(sheet: unknown): unknown;
};

const LOCAL_CHANGE_DEBOUNCE_MS = 120;

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
  let suppressReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  let sheetComposerDockTimer: ReturnType<typeof setTimeout> | null = null;
  let sheetComposerOpen = false;

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
  sheetComposerToggle.textContent = options.labels?.addSheet ?? "+";
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
  sheetComposer.append(sheetComposerToggle, sheetComposerPopover);
  sheetFooter.append(sheetComposer);
  host.append(sheetFooter);

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

  const clearSheetComposerDockTimer = (): void => {
    if (sheetComposerDockTimer !== null) {
      clearTimeout(sheetComposerDockTimer);
      sheetComposerDockTimer = null;
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
    current = normalizeStructuredDocumentContent("table", { workbookData: savedSnapshot }) as TableDocumentContent;
    options.onChange?.(current);
  };

  const syncSheetComposer = (): void => {
    sheetComposer.dataset.open = sheetComposerOpen ? "true" : "false";
    sheetComposerToggle.setAttribute("aria-expanded", sheetComposerOpen ? "true" : "false");
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
      suppressLocalEmit = false;
      suppressReleaseTimer = null;
    }, 0);
  };

  const bindWorkbook = (snapshot: Record<string, unknown>): void => {
    commandSubscription?.dispose();
    commandSubscription = null;
    if (currentWorkbookId) {
      univerAPI.disposeUnit(currentWorkbookId);
      currentWorkbookId = null;
    }
    const workbook = univerAPI.createWorkbook(snapshot) as WorkbookLike;
    currentWorkbook = workbook;
    currentWorkbookId = workbook.getId();
    commandSubscription = workbook.onCommandExecuted(() => {
      if (disposed || suppressLocalEmit) return;
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
      current = {
        ...normalized,
        workbookData: nextWorkbookData,
      };
      workbookSignature = nextSignature;
      suppressLocalEmit = true;
      clearEmitTimer();
      bindWorkbook(nextWorkbookData);
      queueSuppressRelease();
    },
    destroy() {
      disposed = true;
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
