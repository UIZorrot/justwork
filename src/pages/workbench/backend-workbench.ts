/** JustWork online workbench: all durable document operations go through the fixed Backend API. */

import { loadOrCreateLocalIdentity } from "@justwork/workspace-runtime";
import { BackendApiError, createBackendClient, type WorkspaceTreeItem } from "@/features/backend/client";
import { createWysiwygEditor } from "@/features/editor/vditor/create-editor";
import type { DocEditor } from "@/features/editor/types";
import {
  buildDocsStateFromTree,
  createBackendWorkspaceSession,
  ROOT_FOLDER_ID,
  type BackendWorkspaceSession,
} from "@/features/workspace/backend-runtime";
import { createChromeRuntimeStorage } from "@/features/workspace/local-runtime";
import {
  enqueueOfflineMutation,
  loadOfflineMutations,
  removeOfflineMutation,
  type OfflineMutationPatch,
} from "@/features/workspace/offline-queue";
import { JUSTWORK_BACKEND_URL } from "@/shared/backend-config";
import {
  applyI18n,
  createTranslator,
  observePreferredLocaleChanges,
  resolvePreferredLocale,
  savePreferredLocale,
  SUPPORTED_LOCALES,
  type Locale,
  type Translator,
} from "@/shared/i18n";
import {
  STORAGE_KEYS,
  type WorkspaceDoc,
  type WorkspaceDocsState,
} from "@/shared/storage-keys";
import { showToast, type ToastVariant } from "@/shared/toast";
import { formatBackendOrUnknownError } from "@/shared/user-facing-error";

const DRAG_TYPE = "application/x-justwork-doc-id";

const MAX_BACKEND_WORKSPACE_RECENTS = 12;

const WELCOME_DOC_ID = "welcome";
let i18n: Translator = createTranslator("en");
const t = (key: Parameters<Translator["t"]>[0], params?: Parameters<Translator["t"]>[1]): string =>
  i18n.t(key, params);

const LANGUAGE_LABELS: Record<Locale, string> = {
  en: "EN",
  "zh-CN": "中文",
};

function languageLabel(locale: Locale): string {
  return LANGUAGE_LABELS[locale] ?? locale;
}

function displayDocTitle(doc: WorkspaceDoc): string {
  if (doc.kind === "welcome") return t("doc.welcome");
  if (doc.id === ROOT_FOLDER_ID) return t("doc.root");
  if (doc.kind === "folder") return doc.title?.trim() || t("editor.untitledFolder");
  return doc.title?.trim() || t("editor.untitledDocument");
}

function displayDocIcon(doc: WorkspaceDoc): string {
  return doc.kind === "folder" ? "📁" : "📄";
}

function buildLocalizedWelcomeMarkdown(state: WorkspaceDocsState): string {
  const recent = state.docs
    .filter((d) => d.kind !== "welcome" && d.id !== ROOT_FOLDER_ID && !d.inTrash)
    .sort((a, b) => b.lastVisitedAt.localeCompare(a.lastVisitedAt))
    .slice(0, 8);

  const recentLines = recent.length
    ? recent.map((d, idx) => `${idx + 1}. ${displayDocTitle(d)}`).join("\n")
    : t("doc.welcomeMarkdownRecentEmpty");

  return [
    `# ${t("doc.welcomeMarkdownTitle")}`,
    "",
    state.workspaceDescription,
    "",
    `## ${t("doc.welcomeMarkdownRecentHeading")}`,
    "",
    recentLines,
    "",
    `## ${t("doc.welcomeMarkdownOverviewHeading")}`,
    "",
    `- ${t("doc.welcomeMarkdownIntro1")}`,
    `- ${t("doc.welcomeMarkdownIntro2")}`,
  ].join("\n");
}

/** Recent-workspace label: prefer the first root page title, otherwise a localized fallback. */
function formatRecentWorkspaceListLabel(items: WorkspaceTreeItem[], unnamedLabel: string): string {
  const pagesUnderRoot = items.filter(
    (it) => it.parent_id === ROOT_FOLDER_ID && it.kind === "page" && it.id !== WELCOME_DOC_ID,
  );
  pagesUnderRoot.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  const primary = pagesUnderRoot[0];
  const title = primary?.title?.trim() ?? "";
  if (title) return title;
  return unnamedLabel;
}

function findWorkspaceNameDoc(items: WorkspaceTreeItem[]): WorkspaceTreeItem | null {
  const pagesUnderRoot = items.filter(
    (it) => it.parent_id === ROOT_FOLDER_ID && it.kind === "page" && it.id !== WELCOME_DOC_ID,
  );
  pagesUnderRoot.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  if (pagesUnderRoot.length > 0) return pagesUnderRoot[0]!;

  const fallbackPages = items.filter((it) => it.kind === "page" && it.id !== WELCOME_DOC_ID);
  fallbackPages.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  return fallbackPages[0] ?? null;
}

type RecentWorkspaceEntry = {
  workspaceId: string;
  label: string;
  lastUsedAt: string;
};

async function loadRecentWorkspaceEntries(): Promise<RecentWorkspaceEntry[]> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.BACKEND_WORKSPACE_RECENTS);
  const v = raw[STORAGE_KEYS.BACKEND_WORKSPACE_RECENTS];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is RecentWorkspaceEntry => {
    if (!x || typeof x !== "object") return false;
    const e = x as RecentWorkspaceEntry;
    return typeof e.workspaceId === "string" && typeof e.label === "string";
  });
}

async function saveRecentWorkspaceEntries(list: RecentWorkspaceEntry[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.BACKEND_WORKSPACE_RECENTS]: list });
}

async function touchRecentWorkspaceEntry(workspaceId: string, label: string): Promise<void> {
  const now = new Date().toISOString();
  let list = await loadRecentWorkspaceEntries();
  list = list.filter((e) => e.workspaceId !== workspaceId);
  list.unshift({
    workspaceId,
    label: label.trim() || workspaceId,
    lastUsedAt: now,
  });
  list = list.slice(0, MAX_BACKEND_WORKSPACE_RECENTS);
  await saveRecentWorkspaceEntries(list);
}

async function removeRecentWorkspaceEntry(workspaceId: string): Promise<void> {
  const list = (await loadRecentWorkspaceEntries()).filter((e) => e.workspaceId !== workspaceId);
  await saveRecentWorkspaceEntries(list);
}

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | undefined;
  return ((...args: Parameters<T>) => {
    if (t !== undefined) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}

function formatHistoryTime(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale);
}

function historyEventTitle(op: string): string {
  switch (op) {
    case "workspace.item.set":
      return t("history.modify");
    case "workspace.item.create":
      return t("history.create");
    case "workspace.item.move":
      return t("history.move");
    case "workspace.item.pin":
      return t("history.pin");
    case "workspace.item.trash":
      return t("history.trash");
    case "workspace.item.restore":
      return t("history.restore");
    case "workspace.item.hard_delete":
      return t("history.hardDelete");
    case "doc.patch":
      return t("history.patch");
    case "history.revert":
      return t("history.revert");
    default:
      return op;
  }
}

function buildDepthMap(docs: WorkspaceDoc[]): Map<string, number> {
  const map = new Map<string, number>();
  const byId = new Map(docs.map((d) => [d.id, d]));
  const depthOf = (id: string): number => {
    if (map.has(id)) return map.get(id)!;
    let depth = 0;
    let cur = byId.get(id);
    while (cur?.parentId) {
      depth += 1;
      cur = byId.get(cur.parentId);
      if (!cur) break;
    }
    map.set(id, Math.min(depth, 6));
    return map.get(id)!;
  };
  docs.forEach((d) => depthOf(d.id));
  return map;
}

function flattenTree(docs: WorkspaceDoc[], rootId: string): WorkspaceDoc[] {
  const byParent = new Map<string, WorkspaceDoc[]>();
  docs.forEach((d) => {
    const key = d.parentId ?? "";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(d);
  });
  byParent.forEach((arr) => arr.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));

  const out: WorkspaceDoc[] = [];
  const visit = (id: string) => {
    const cur = docs.find((d) => d.id === id);
    if (!cur) return;
    out.push(cur);
    (byParent.get(id) || []).forEach((child) => {
      if (child.kind === "welcome") return;
      visit(child.id);
    });
  };
  visit(rootId);
  return out;
}

function saveStatus(el: HTMLElement, text: string): void {
  el.textContent = text;
}

function formatBytesCompact(bytes: number): string {
  const safe = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  const mb = safe / (1024 * 1024);
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = safe / 1024;
  return `${Math.max(1, Math.round(kb))} KB`;
}

function notifyError(err: unknown): void {
  showToast({
    message: formatBackendOrUnknownError(err),
    variant: "error",
    durationMs: 5600,
  });
}

function setHealthStatus(el: HTMLElement, status: "checking" | "online" | "offline" | "error", text: string): void {
  el.dataset.status = status;
  el.textContent = text;
}

function isOfflineError(error: unknown): boolean {
  return !(error instanceof BackendApiError) || error.status === 0;
}

function mutationId(): string {
  return `offline_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function startBackendWorkbench(): Promise<void> {
  const locale = await resolvePreferredLocale();
  i18n = createTranslator(locale);
  applyI18n(document, i18n);

  const editorRoot = document.getElementById("editor-root") as HTMLElement | null;
  const titleInput = document.getElementById("doc-title-input") as HTMLInputElement | null;
  const pinnedList = document.getElementById("pinned-list") as HTMLUListElement | null;
  const docTree = document.getElementById("doc-tree") as HTMLUListElement | null;
  const trashList = document.getElementById("trash-list") as HTMLUListElement | null;
  const newFileBtn = document.getElementById("new-file-btn") as HTMLButtonElement | null;
  const newFolderBtn = document.getElementById("new-folder-btn") as HTMLButtonElement | null;
  const pinBtn = document.getElementById("pin-btn") as HTMLButtonElement | null;
  const deleteBtn = document.getElementById("delete-btn") as HTMLButtonElement | null;
  const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
  const saveStatusEl = document.getElementById("save-status") as HTMLElement | null;
  const topbarQuota = document.getElementById("topbar-quota") as HTMLElement | null;
  const topbarQuotaFill = document.getElementById("topbar-quota-fill") as HTMLElement | null;
  const topbarQuotaText = document.getElementById("topbar-quota-text") as HTMLElement | null;
  const languageSwitcher = document.getElementById("language-switcher") as HTMLDivElement | null;
  const languageSwitcherBtn = document.getElementById("language-switcher-btn") as HTMLButtonElement | null;
  const languageSwitcherLabel = document.getElementById("language-switcher-label") as HTMLElement | null;
  const languageSwitcherMenu = document.getElementById("language-switcher-menu") as HTMLDivElement | null;
  const backendHealthStatus = document.getElementById("backend-health-status") as HTMLElement | null;
  const shell = document.querySelector(".workspace-shell") as HTMLElement | null;
  const gate = document.getElementById("workspace-gate") as HTMLElement | null;
  const setupPanel = document.getElementById("workspace-setup-panel") as HTMLElement | null;
  const unlockPanel = document.getElementById("workspace-unlock-panel") as HTMLElement | null;
  const setupPasswordInput = document.getElementById("setup-password-input") as HTMLInputElement | null;
  const unlockPasswordInput = document.getElementById("unlock-password-input") as HTMLInputElement | null;
  const setupWorkspaceBtn = document.getElementById("setup-workspace-btn") as HTMLButtonElement | null;
  const unlockWorkspaceBtn = document.getElementById("unlock-workspace-btn") as HTMLButtonElement | null;
  const lockWorkspaceBtn = document.getElementById("lock-workspace-btn") as HTMLButtonElement | null;
  const gateError = document.getElementById("workspace-gate-error") as HTMLElement | null;
  const backendTitleSetup = document.getElementById("backend-title-setup-input") as HTMLInputElement | null;
  const backendWorkspaceIdInput = document.getElementById("backend-workspace-id-input") as HTMLInputElement | null;
  const historyList = document.getElementById("history-list") as HTMLUListElement | null;
  const historyRefreshBtn = document.getElementById("history-refresh-btn") as HTMLButtonElement | null;
  const historyDrawerRoot = document.getElementById("history-drawer-root") as HTMLElement | null;
  const historyDrawerBackdrop = document.getElementById("history-drawer-backdrop") as HTMLElement | null;
  const historyDrawerCloseBtn = document.getElementById("history-drawer-close-btn") as HTMLButtonElement | null;
  const historyDrawerOpenBtn = document.getElementById("history-drawer-open-btn") as HTMLButtonElement | null;
  const workspaceInfoDrawerRoot = document.getElementById("workspace-info-drawer-root") as HTMLElement | null;
  const workspaceInfoDrawerBackdrop = document.getElementById("workspace-info-drawer-backdrop") as HTMLElement | null;
  const workspaceInfoDrawerCloseBtn = document.getElementById("workspace-info-drawer-close-btn") as HTMLButtonElement | null;
  const workspaceInfoDrawerOpenBtn = document.getElementById("workspace-info-drawer-open-btn") as HTMLButtonElement | null;
  const workspaceInfoIdEl = document.getElementById("workspace-info-id") as HTMLElement | null;
  const workspaceInfoCopyIdBtn = document.getElementById("workspace-info-copy-id-btn") as HTMLButtonElement | null;
  const workspaceInfoUserIdEl = document.getElementById("workspace-info-user-id") as HTMLElement | null;
  const workspaceInfoCopyUserIdBtn = document.getElementById("workspace-info-copy-user-id-btn") as HTMLButtonElement | null;
  const workspaceInfoNicknameInput = document.getElementById("workspace-info-nickname-input") as HTMLInputElement | null;
  const workspaceInfoSaveNicknameBtn = document.getElementById("workspace-info-save-nickname-btn") as HTMLButtonElement | null;
  const workspaceInfoProfileStatus = document.getElementById("workspace-info-profile-status") as HTMLElement | null;
  const workspaceInfoWorkspaceNameInput = document.getElementById("workspace-info-workspace-name-input") as HTMLInputElement | null;
  const workspaceInfoSaveWorkspaceNameBtn = document.getElementById("workspace-info-save-workspace-name-btn") as HTMLButtonElement | null;
  const workspaceInfoWorkspaceNameStatus = document.getElementById("workspace-info-workspace-name-status") as HTMLElement | null;
  const gateRecentSection = document.getElementById("gate-recent-section") as HTMLElement | null;
  const gateRecentBody = document.getElementById("gate-recent-body") as HTMLElement | null;
  const gateRecentList = document.getElementById("gate-recent-workspaces-list") as HTMLUListElement | null;
  const gateRecentEmpty = document.getElementById("gate-recent-empty") as HTMLElement | null;
  const gateRecentToggle = document.getElementById("gate-recent-toggle") as HTMLButtonElement | null;

  if (
    !editorRoot ||
    !titleInput ||
    !pinnedList ||
    !docTree ||
    !trashList ||
    !newFileBtn ||
    !newFolderBtn ||
    !pinBtn ||
    !deleteBtn ||
    !searchInput ||
    !saveStatusEl ||
    !topbarQuota ||
    !topbarQuotaFill ||
    !topbarQuotaText ||
    !languageSwitcher ||
    !languageSwitcherBtn ||
    !languageSwitcherLabel ||
    !languageSwitcherMenu ||
    !backendHealthStatus ||
    !shell ||
    !gate ||
    !setupPanel ||
    !unlockPanel ||
    !setupPasswordInput ||
    !unlockPasswordInput ||
    !setupWorkspaceBtn ||
    !unlockWorkspaceBtn ||
    !lockWorkspaceBtn ||
    !gateError ||
    !historyList ||
    !historyRefreshBtn ||
    !historyDrawerRoot ||
    !historyDrawerBackdrop ||
    !historyDrawerCloseBtn ||
    !historyDrawerOpenBtn ||
    !workspaceInfoDrawerRoot ||
    !workspaceInfoDrawerBackdrop ||
    !workspaceInfoDrawerCloseBtn ||
    !workspaceInfoDrawerOpenBtn ||
    !workspaceInfoIdEl ||
    !workspaceInfoCopyIdBtn ||
    !workspaceInfoUserIdEl ||
    !workspaceInfoCopyUserIdBtn ||
    !workspaceInfoNicknameInput ||
    !workspaceInfoSaveNicknameBtn ||
    !workspaceInfoProfileStatus ||
    !workspaceInfoWorkspaceNameInput ||
    !workspaceInfoSaveWorkspaceNameBtn ||
    !workspaceInfoWorkspaceNameStatus ||
    !gateRecentSection ||
    !gateRecentBody ||
    !gateRecentList ||
    !gateRecentEmpty ||
    !gateRecentToggle
  ) {
    console.error("workbench element missing");
    return;
  }

  let isLanguageSwitcherOpen = false;
  let handleLocaleChanged: ((nextLocale: Locale) => void) | undefined;
  const getLanguageSwitcherOptions = (): HTMLButtonElement[] =>
    Array.from(languageSwitcherMenu.querySelectorAll<HTMLButtonElement>(".language-switcher-option"));
  const focusLanguageOption = (index: number): void => {
    const options = getLanguageSwitcherOptions();
    if (options.length === 0) return;
    const nextIndex = ((index % options.length) + options.length) % options.length;
    options[nextIndex]?.focus();
  };
  const closeLanguageSwitcher = (restoreFocus = false): void => {
    isLanguageSwitcherOpen = false;
    renderLanguageSwitcher();
    if (restoreFocus) languageSwitcherBtn.focus();
  };
  const renderLanguageSwitcher = (): void => {
    languageSwitcherLabel.textContent = languageLabel(i18n.locale);
    languageSwitcherBtn.setAttribute("aria-expanded", isLanguageSwitcherOpen ? "true" : "false");
    languageSwitcherMenu.hidden = !isLanguageSwitcherOpen;
    languageSwitcherMenu.replaceChildren();
    for (const locale of SUPPORTED_LOCALES) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "language-switcher-option";
      option.dataset.locale = locale;
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("aria-checked", i18n.locale === locale ? "true" : "false");
      option.classList.toggle("is-active", i18n.locale === locale);
      option.textContent = languageLabel(locale);
      option.addEventListener("click", () => {
        void applyLocale(locale);
      });
      languageSwitcherMenu.appendChild(option);
    }
  };
  renderLanguageSwitcher();
  const applyLocale = async (nextLocale: Locale): Promise<void> => {
    closeLanguageSwitcher();
    if (i18n.locale === nextLocale) return;
    await savePreferredLocale(nextLocale);
    handleLocaleChanged?.(nextLocale);
  };
  const selectedLocaleIndex = (): number =>
    Math.max(
      0,
      SUPPORTED_LOCALES.findIndex((locale) => locale === i18n.locale),
    );
  languageSwitcherBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    isLanguageSwitcherOpen = !isLanguageSwitcherOpen;
    renderLanguageSwitcher();
    if (isLanguageSwitcherOpen) {
      focusLanguageOption(selectedLocaleIndex());
    }
  });
  languageSwitcherBtn.addEventListener("keydown", (event) => {
    if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!isLanguageSwitcherOpen) {
      isLanguageSwitcherOpen = true;
      renderLanguageSwitcher();
    }
    focusLanguageOption(event.key === "ArrowUp" ? selectedLocaleIndex() - 1 : selectedLocaleIndex());
  });
  languageSwitcherMenu.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  languageSwitcherMenu.addEventListener("keydown", (event) => {
    const options = getLanguageSwitcherOptions();
    const activeIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      closeLanguageSwitcher(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      let nextIndex = activeIndex;
      if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = options.length - 1;
      else nextIndex = activeIndex + (event.key === "ArrowDown" ? 1 : -1);
      focusLanguageOption(nextIndex);
    }
  });
  document.addEventListener("click", (event) => {
    const target = event.target as Node | null;
    if (!target || !languageSwitcher.contains(target)) closeLanguageSwitcher();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isLanguageSwitcherOpen) closeLanguageSwitcher(true);
  });

  const runtimeStorage = createChromeRuntimeStorage();
  const identity = await loadOrCreateLocalIdentity(runtimeStorage);
  const backendClient = createBackendClient({ baseUrl: JUSTWORK_BACKEND_URL, signingIdentity: identity });
  const savedWsId = (await chrome.storage.local.get(STORAGE_KEYS.LAST_BACKEND_WORKSPACE_ID))[
    STORAGE_KEYS.LAST_BACKEND_WORKSPACE_ID
  ] as string | undefined;

  if (backendWorkspaceIdInput && savedWsId) backendWorkspaceIdInput.value = savedWsId;

  let editor: DocEditor | undefined;
  let mounted = false;
  let flushOfflineMutations: () => Promise<void> = async () => {};
  let rerenderActiveWorkbench: (() => void) | undefined;
  let refreshActiveHistoryPanel: (() => Promise<void>) | undefined;
  let refreshActiveWorkspaceInfoPanel: (() => Promise<void>) | undefined;
  let refreshQuotaBar: (() => Promise<void>) | undefined;

  const refreshHealth = async (): Promise<void> => {
    setHealthStatus(backendHealthStatus, "checking", t("status.connecting"));
    try {
      await backendClient.health();
      setHealthStatus(backendHealthStatus, "online", t("status.online"));
      await flushOfflineMutations();
    } catch {
      setHealthStatus(backendHealthStatus, "offline", t("status.offline"));
    }
  };
  void refreshHealth();
  window.addEventListener("online", () => {
    void refreshHealth();
  });
  const healthTimer = window.setInterval(() => void refreshHealth(), 60_000);

  handleLocaleChanged = (nextLocale: Locale): void => {
    if (i18n.locale === nextLocale) return;
    i18n = createTranslator(nextLocale);
    applyI18n(document, i18n);
    renderLanguageSwitcher();
    void refreshHealth();
    void renderGateRecents();
    rerenderActiveWorkbench?.();
    void refreshActiveHistoryPanel?.();
    void refreshActiveWorkspaceInfoPanel?.();
    void refreshQuotaBar?.();
  };
  const disposeLocaleObserver = observePreferredLocaleChanges(handleLocaleChanged);

  const closeHistoryDrawer = (): void => {
    historyDrawerRoot.classList.remove("is-open");
    historyDrawerRoot.setAttribute("aria-hidden", "true");
    historyDrawerOpenBtn.setAttribute("aria-expanded", "false");
  };

  const closeWorkspaceInfoDrawer = (): void => {
    workspaceInfoDrawerRoot.classList.remove("is-open");
    workspaceInfoDrawerRoot.setAttribute("aria-hidden", "true");
    workspaceInfoDrawerOpenBtn.setAttribute("aria-expanded", "false");
  };

  const openHistoryDrawer = (): void => {
    closeWorkspaceInfoDrawer();
    historyDrawerRoot.classList.add("is-open");
    historyDrawerRoot.setAttribute("aria-hidden", "false");
    historyDrawerOpenBtn.setAttribute("aria-expanded", "true");
  };

  const openWorkspaceInfoDrawer = (): void => {
    closeHistoryDrawer();
    workspaceInfoDrawerRoot.classList.add("is-open");
    workspaceInfoDrawerRoot.setAttribute("aria-hidden", "false");
    workspaceInfoDrawerOpenBtn.setAttribute("aria-expanded", "true");
  };

  historyDrawerCloseBtn.addEventListener("click", closeHistoryDrawer);
  historyDrawerBackdrop.addEventListener("click", closeHistoryDrawer);
  workspaceInfoDrawerCloseBtn.addEventListener("click", closeWorkspaceInfoDrawer);
  workspaceInfoDrawerBackdrop.addEventListener("click", closeWorkspaceInfoDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (workspaceInfoDrawerRoot.classList.contains("is-open")) {
      closeWorkspaceInfoDrawer();
      return;
    }
    if (historyDrawerRoot.classList.contains("is-open")) {
      closeHistoryDrawer();
    }
  });

  const syncGateRecentOverflow = (): void => {
    gateRecentBody.classList.remove("gate-recent-body--expanded");
    gateRecentToggle.textContent = t("gate.recent.showMore");
    void gateRecentBody.offsetHeight;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (gateRecentList.children.length === 0) {
          gateRecentToggle.hidden = true;
          return;
        }
        const overflow = gateRecentBody.scrollHeight > gateRecentBody.clientHeight + 2;
        gateRecentToggle.hidden = !overflow;
      });
    });
  };

  const renderGateRecents = async (): Promise<void> => {
    const entries = await loadRecentWorkspaceEntries();
    gateRecentList.innerHTML = "";
    gateRecentEmpty.hidden = entries.length > 0;
    for (const e of entries) {
      const li = document.createElement("li");
      li.className = "gate-recent-li";
      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.className = "gate-recent-select";
      selectBtn.dataset.workspaceId = e.workspaceId;
      const main = document.createElement("span");
      main.className = "gate-recent-item-main";
      const lab = document.createElement("span");
      lab.className = "gate-recent-item-label";
      lab.textContent = e.label;
      const idSpan = document.createElement("span");
      idSpan.className = "gate-recent-item-id";
      idSpan.textContent = e.workspaceId;
      main.appendChild(lab);
      main.appendChild(idSpan);
      selectBtn.appendChild(main);
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "gate-recent-remove";
      rm.setAttribute("aria-label", t("gate.recent.remove"));
      rm.dataset.workspaceId = e.workspaceId;
      rm.textContent = "×";
      li.appendChild(selectBtn);
      li.appendChild(rm);
      gateRecentList.appendChild(li);
    }
    syncGateRecentOverflow();
  };

  gateRecentToggle.addEventListener("click", () => {
    const expanded = gateRecentBody.classList.toggle("gate-recent-body--expanded");
    gateRecentToggle.textContent = expanded ? t("gate.recent.collapse") : t("gate.recent.showMore");
    if (!expanded) {
      void gateRecentBody.offsetHeight;
      requestAnimationFrame(() => {
        if (gateRecentList.children.length === 0) {
          gateRecentToggle.hidden = true;
          return;
        }
        gateRecentToggle.hidden =
          gateRecentBody.scrollHeight <= gateRecentBody.clientHeight + 2;
      });
    }
  });

  const applyRecentWorkspaceId = (workspaceId: string): void => {
    if (backendWorkspaceIdInput) backendWorkspaceIdInput.value = workspaceId;
    showGate("unlock");
  };

  gateRecentList.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const rm = t.closest(".gate-recent-remove");
    if (rm) {
      ev.preventDefault();
      ev.stopPropagation();
      const id = (rm as HTMLButtonElement).dataset.workspaceId;
      if (id) void removeRecentWorkspaceEntry(id).then(() => renderGateRecents());
      return;
    }
    const sel = t.closest(".gate-recent-select") as HTMLButtonElement | null;
    const id = sel?.dataset.workspaceId;
    if (id) applyRecentWorkspaceId(id);
  });

  const showGate = (mode: "setup" | "unlock", message = "", variant: ToastVariant = "error"): void => {
    closeHistoryDrawer();
    closeWorkspaceInfoDrawer();
    shell.hidden = true;
    lockWorkspaceBtn.hidden = true;
    pinBtn.hidden = true;
    deleteBtn.hidden = true;
    historyDrawerOpenBtn.hidden = true;
    workspaceInfoDrawerOpenBtn.hidden = true;
    topbarQuota.hidden = true;
    gate.hidden = false;
    setupPanel.hidden = mode !== "setup";
    unlockPanel.hidden = mode !== "unlock";
    gateError.textContent = "";
    const trimmed = message.trim();
    if (trimmed) {
      showToast({
        message: trimmed,
        variant,
        durationMs: trimmed.length > 36 ? 6200 : 5200,
      });
    }
    void renderGateRecents();
    gateRecentToggle.textContent = t("gate.recent.showMore");
    gateRecentEmpty.textContent = t("gate.recent.empty");
    (mode === "setup" ? setupPasswordInput : unlockPasswordInput).focus();
  };

  const showWorkbench = (): void => {
    gate.hidden = true;
    shell.hidden = false;
    lockWorkspaceBtn.hidden = false;
    pinBtn.hidden = false;
    deleteBtn.hidden = false;
    historyDrawerOpenBtn.hidden = false;
    workspaceInfoDrawerOpenBtn.hidden = false;
    topbarQuota.hidden = false;
    gateError.textContent = "";
  };

  const setGateBusy = (busy: boolean, panel: "setup" | "unlock"): void => {
    gateRecentSection.classList.toggle("is-disabled", busy);
    setupWorkspaceBtn.disabled = busy;
    unlockWorkspaceBtn.disabled = busy;
    setupPasswordInput.disabled = busy;
    unlockPasswordInput.disabled = busy;
    if (backendTitleSetup) backendTitleSetup.disabled = busy;
    if (backendWorkspaceIdInput) backendWorkspaceIdInput.disabled = busy;
    setupWorkspaceBtn.classList.toggle("is-busy", busy && panel === "setup");
    unlockWorkspaceBtn.classList.toggle("is-busy", busy && panel === "unlock");
    setupWorkspaceBtn.setAttribute("aria-busy", busy && panel === "setup" ? "true" : "false");
    unlockWorkspaceBtn.setAttribute("aria-busy", busy && panel === "unlock" ? "true" : "false");
  };

  const mountWithPassword = async (
    workspaceId: string,
    password: string,
    recentLabelHint?: string,
    initialTreeData?: { active_item_id: string; items: WorkspaceTreeItem[] },
  ): Promise<void> => {
    if (mounted) return;

    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_BACKEND_WORKSPACE_ID]: workspaceId });

    const session: BackendWorkspaceSession = createBackendWorkspaceSession({
      baseUrl: JUSTWORK_BACKEND_URL,
      workspaceId,
      password,
      signingIdentity: identity,
    });

    const renderQuotaBar = (usedBytes: number, limitBytes: number): void => {
      const ratio = limitBytes <= 0 ? 1 : Math.max(0, Math.min(1, usedBytes / limitBytes));
      topbarQuotaFill.style.width = `${Math.round(ratio * 100)}%`;
      topbarQuotaText.textContent = `${formatBytesCompact(usedBytes)} / ${formatBytesCompact(limitBytes)}`;
      if (ratio >= 0.95) topbarQuota.dataset.level = "danger";
      else if (ratio >= 0.8) topbarQuota.dataset.level = "warn";
      else topbarQuota.dataset.level = "ok";
    };
    renderQuotaBar(0, 1);

    const pullQuota = async (): Promise<void> => {
      try {
        const q = await backendClient.getQuota(workspaceId);
        renderQuotaBar(q.quota.used_bytes, q.quota.limit_bytes);
      } catch {
        // Keep previous quota display on transient failure.
      }
    };
    refreshQuotaBar = pullQuota;

    let treeData = initialTreeData ?? (await session.loadTree());
    const recentListLabel = formatRecentWorkspaceListLabel(treeData.items, t("editor.untitled"));
    let workspace: WorkspaceDocsState = buildDocsStateFromTree(
      treeData.items,
      treeData.active_item_id,
      t("doc.workspaceBackend"),
    );

    let active = workspace.docs.find((d) => d.id === treeData.active_item_id) ?? workspace.docs[0]!;
    if (active.kind === "welcome") {
      active = { ...active, markdown: buildLocalizedWelcomeMarkdown(workspace) };
      workspace = {
        ...workspace,
        docs: workspace.docs.map((d) => (d.id === active.id ? active : d)),
      };
    } else {
      const fallbackMarkdown = active.title ? `# ${active.title}\n` : "";
      active = { ...active, markdown: active.markdown || fallbackMarkdown };
      workspace = {
        ...workspace,
        docs: workspace.docs.map((d) => (d.id === active.id ? active : d)),
        activeDocId: active.id,
      };
    }

    const replaceDoc = (doc: WorkspaceDoc): void => {
      active = doc;
      workspace = {
        ...workspace,
        docs: workspace.docs.map((d) => (d.id === doc.id ? doc : d)),
        activeDocId: doc.id,
      };
    };

    const persistRefreshTree = async (): Promise<void> => {
      treeData = await session.loadTree();
      const nextActiveId = treeData.items.some((item) => item.id === active.id && !item.in_trash)
        ? active.id
        : treeData.active_item_id;
      workspace = buildDocsStateFromTree(treeData.items, nextActiveId, workspace.workspaceDescription);
      const summary = workspace.docs.find((d) => d.id === nextActiveId) ?? workspace.docs[0]!;
        const full = summary.kind === "welcome"
        ? { ...summary, markdown: buildLocalizedWelcomeMarkdown(workspace) }
        : await session.loadItem(summary.id);
      replaceDoc(full);
      await pullQuota();
    };

    const syncEditorWithActive = (): void => {
      titleInput.value = displayDocTitle(active);
      titleInput.readOnly = active.kind === "welcome" || active.id === ROOT_FOLDER_ID;
      editor?.setMarkdown(active.kind === "welcome" ? buildLocalizedWelcomeMarkdown(workspace) : active.markdown, true);
    };

    const renderAll = (): void => {
      const q = searchInput.value;
      const alive = workspace.docs.filter((d) => !d.inTrash);
      const pinned = alive.filter((d) => d.pinned);
      const treeSource = alive.filter((d) => !d.pinned && d.kind !== "welcome");
      const tree = flattenTree(treeSource, ROOT_FOLDER_ID);
      const trash = workspace.docs.filter((d) => d.inTrash);

      renderDocRows(pinnedList, pinned, { search: q });
      renderDocRows(docTree, tree, { search: q });
      renderDocRows(trashList, trash, { showTrashActions: true, search: q });
      titleInput.value = displayDocTitle(active);
      titleInput.readOnly = active.kind === "welcome" || active.id === ROOT_FOLDER_ID;
      pinBtn.textContent = active.pinned ? t("sidebar.unpin") : t("sidebar.pin");
      pinBtn.disabled = active.kind === "welcome" || active.id === ROOT_FOLDER_ID || active.inTrash;
      pinBtn.title = pinBtn.disabled ? t("doc.protected") : t("sidebar.pin");
      deleteBtn.disabled = active.kind === "welcome" || active.id === ROOT_FOLDER_ID || active.inTrash;
      deleteBtn.title = deleteBtn.disabled ? t("doc.protected") : t("doc.trash");
    };

    const refreshHistoryPanel = async (): Promise<void> => {
      try {
        const events = await session.listHistory();
        historyList.innerHTML = "";
        for (const ev of events) {
          const li = document.createElement("li");
          li.className = "history-item";
          li.dataset.eventId = ev.id;

          const main = document.createElement("div");
          main.className = "history-item-main";

          const meta = document.createElement("div");
          meta.className = "history-item-meta";
          meta.textContent = `${formatHistoryTime(ev.timestamp, locale)} / ${historyEventTitle(ev.op)}`;

          const docLine = document.createElement("div");
          docLine.className = "history-item-doc";
          const actor = ev.actor_user_id ? ` / ${ev.actor_user_id.slice(-8)}` : "";
          docLine.textContent = `${t("drawer.history.itemLabel")}?${ev.title || t("editor.untitled")}${actor}`;

          const evLine = document.createElement("div");
          evLine.className = "history-item-event";
          evLine.textContent = `${t("drawer.history.eventLabel")}?${historyEventTitle(ev.op)}`;

          main.appendChild(meta);
          main.appendChild(docLine);
          main.appendChild(evLine);

          const revertBtn = document.createElement("button");
          revertBtn.type = "button";
          revertBtn.className = "history-revert-btn";
          revertBtn.textContent = t("doc.revert");
          revertBtn.setAttribute("data-testid", "history-revert");
          revertBtn.addEventListener("click", () => {
            void (async () => {
              try {
                await session.revertHistoryEvent(ev.id);
                await persistRefreshTree();
                syncEditorWithActive();
                renderAll();
                await refreshHistoryPanel();
                saveStatus(saveStatusEl, t("status.reverted"));
              } catch (e) {
                notifyError(e);
              }
            })();
          });

          li.appendChild(main);
          li.appendChild(revertBtn);
          historyList.appendChild(li);
        }
      } catch (e) {
        historyList.innerHTML = "";
        notifyError(e);
      }
    };


    const applyLocalPatch = (itemId: string, patch: OfflineMutationPatch): void => {
      const current = workspace.docs.find((d) => d.id === itemId);
      if (!current) return;
      const next = {
        ...current,
        title: patch.title ?? current.title,
        markdown: patch.markdown ?? current.markdown,
        updatedAt: new Date().toISOString(),
      };
      replaceDoc(next);
      syncEditorWithActive();
      renderAll();
    };

    const queueOfflinePatch = async (
      itemId: string,
      expectedRevision: number,
      patch: OfflineMutationPatch,
    ): Promise<void> => {
      await enqueueOfflineMutation(chrome.storage.local, {
        id: mutationId(),
        workspaceId,
        itemId,
        patch,
        expectedRevision,
        createdAt: new Date().toISOString(),
      });
      applyLocalPatch(itemId, patch);
      setHealthStatus(backendHealthStatus, "offline", t("status.offline"));
      saveStatus(saveStatusEl, t("status.offlinePending"));
    };

    const saveActivePatch = async (patch: OfflineMutationPatch, doneText: string): Promise<void> => {
      if (active.kind === "welcome") return;
      const itemId = active.id;
      const expectedRevision = active.revision;
      saveStatus(saveStatusEl, t("status.saving"));
      try {
        const next = await session.saveItem(itemId, { ...patch, expectedRevision });
        replaceDoc(next);
        await persistRefreshTree();
        renderAll();
        void refreshHistoryPanel();
        saveStatus(saveStatusEl, doneText);
      } catch (e) {
        if (e instanceof BackendApiError && e.code === "conflict") {
          showToast({ message: t("toast.conflict"), variant: "warning" });
          return;
        }
        if (isOfflineError(e)) {
          await queueOfflinePatch(itemId, expectedRevision, patch);
          return;
        }
        notifyError(e);
      }
    };

    flushOfflineMutations = async (): Promise<void> => {
      const pending = (await loadOfflineMutations(chrome.storage.local)).filter((entry) => entry.workspaceId === workspaceId);
      if (pending.length === 0) return;

      for (const mutation of pending) {
        try {
          await session.saveItem(mutation.itemId, {
            ...mutation.patch,
            expectedRevision: mutation.expectedRevision,
          });
          await removeOfflineMutation(chrome.storage.local, mutation.id);
        } catch (e) {
          if (e instanceof BackendApiError && e.code === "conflict") {
            showToast({ message: t("toast.conflict"), variant: "warning" });
            return;
          }
          if (isOfflineError(e)) {
      setHealthStatus(backendHealthStatus, "offline", t("status.offline"));
            saveStatus(saveStatusEl, t("status.offlinePending"));
            return;
          }
          notifyError(e);
          return;
        }
      }

      await persistRefreshTree();
      syncEditorWithActive();
      renderAll();
      void refreshHistoryPanel();
      saveStatus(saveStatusEl, t("status.synced"));
    };

    const switchActiveDoc = async (doc: WorkspaceDoc): Promise<void> => {
      if (doc.kind === "welcome") {
                replaceDoc({ ...doc, markdown: buildLocalizedWelcomeMarkdown(workspace) });
      } else {
        const full = await session.loadItem(doc.id);
        replaceDoc(full);
      }
      syncEditorWithActive();
      await persistRefreshTree();
      renderAll();
    };

    const onDropToFolder = (targetFolderId: string | null, draggedId: string) => {
      void (async () => {
        try {
          await session.moveItem(draggedId, targetFolderId);
          await persistRefreshTree();
          renderAll();
          void refreshHistoryPanel();
          saveStatus(saveStatusEl, t("doc.moved"));
        } catch (e) {
          notifyError(e);
        }
      })();
    };

    const renderDocRows = (
      listEl: HTMLUListElement,
      docs: WorkspaceDoc[],
      opts: { showTrashActions?: boolean; search?: string },
    ): void => {
      listEl.innerHTML = "";
      const q = (opts.search || "").trim().toLowerCase();
      const filtered = q ? docs.filter((d) => d.title.toLowerCase().includes(q)) : docs;
      const depthMap = buildDepthMap(filtered);

      filtered.forEach((doc) => {
        const li = document.createElement("li");
        const row = document.createElement("div");
        row.className = "doc-row";

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "doc-list-item";
        const icon = document.createElement("span");
        icon.className = "doc-list-item-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = displayDocIcon(doc);
        const label = document.createElement("span");
        label.className = "doc-list-item-label";
        label.textContent = displayDocTitle(doc);
        btn.replaceChildren(icon, label);
        btn.style.paddingLeft = `${8 + (depthMap.get(doc.id) ?? 0) * 14}px`;
        if (doc.id === ROOT_FOLDER_ID) {
          btn.classList.add("doc-root");
        }
        if (doc.id === active.id) btn.classList.add("active");
        btn.addEventListener("click", () => void switchActiveDoc(doc));

        if (!opts.showTrashActions && doc.kind !== "welcome" && doc.id !== ROOT_FOLDER_ID) {
          btn.draggable = true;
          btn.addEventListener("dragstart", (e) => {
            e.dataTransfer?.setData(DRAG_TYPE, doc.id);
            e.dataTransfer!.effectAllowed = "move";
          });
        }

        if (!opts.showTrashActions && doc.kind === "folder" && doc.id !== ROOT_FOLDER_ID) {
          btn.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer!.dropEffect = "move";
          });
          btn.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const draggedId = e.dataTransfer?.getData(DRAG_TYPE);
            if (draggedId) onDropToFolder(doc.id, draggedId);
          });
        }

        row.appendChild(btn);

        if (opts.showTrashActions) {
          const restore = document.createElement("button");
          restore.type = "button";
          restore.className = "doc-mini-btn";
          restore.textContent = t("doc.restore");
          restore.addEventListener("click", (e) => {
            e.stopPropagation();
            void (async () => {
              try {
                replaceDoc(await session.restoreItem(doc.id));
                await persistRefreshTree();
                syncEditorWithActive();
                renderAll();
                void refreshHistoryPanel();
                saveStatus(saveStatusEl, t("doc.restored"));
              } catch (err) {
                notifyError(err);
              }
            })();
          });

          const hardDelete = document.createElement("button");
          hardDelete.type = "button";
          hardDelete.className = "doc-mini-btn";
          hardDelete.textContent = t("doc.deleteForever");
          hardDelete.addEventListener("click", (e) => {
            e.stopPropagation();
            void (async () => {
              try {
                await session.hardDeleteItem(doc.id);
                await persistRefreshTree();
                syncEditorWithActive();
                renderAll();
                void refreshHistoryPanel();
                saveStatus(saveStatusEl, t("doc.hardDeleted"));
              } catch (err) {
                notifyError(err);
              }
            })();
          });
          row.appendChild(restore);
          row.appendChild(hardDelete);
        } else if (doc.kind !== "welcome" && doc.id !== ROOT_FOLDER_ID) {
          const del = document.createElement("button");
          del.type = "button";
          del.className = "doc-hover-delete";
          del.textContent = t("doc.deleteForever");
          del.title = t("doc.trash");
          del.addEventListener("click", (e) => {
            e.stopPropagation();
            void (async () => {
              try {
                await session.trashItem(doc.id);
                await persistRefreshTree();
                syncEditorWithActive();
                renderAll();
                void refreshHistoryPanel();
                saveStatus(saveStatusEl, t("doc.trashed"));
              } catch (err) {
                notifyError(err);
              }
            })();
          });
          row.appendChild(del);
        }

        li.appendChild(row);
        listEl.appendChild(li);
      });
    };

    editor = createWysiwygEditor({
      container: editorRoot,
      initialMarkdown: active.kind === "welcome" ? buildLocalizedWelcomeMarkdown(workspace) : active.markdown,
      onChange: (markdown) => {
        void saveActivePatch({ markdown }, t("status.saved"));
      },
    });

    docTree.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
    });
    docTree.addEventListener("drop", (e) => {
      e.preventDefault();
      const draggedId = e.dataTransfer?.getData(DRAG_TYPE);
      if (draggedId) onDropToFolder(ROOT_FOLDER_ID, draggedId);
    });

    const debouncedTitleSave = debounce(() => {
      const title = titleInput.value.trim() || t("editor.untitledDocument");
      void saveActivePatch({ title }, t("status.saved"));
    }, 400);

    titleInput.addEventListener("input", () => debouncedTitleSave());
    searchInput.addEventListener("input", () => renderAll());
    historyRefreshBtn.addEventListener("click", () => void refreshHistoryPanel());

    historyDrawerOpenBtn.addEventListener("click", () => {
      openHistoryDrawer();
      void refreshHistoryPanel();
    });

    const refreshWorkspaceInfoPanel = async (): Promise<void> => {
      workspaceInfoIdEl.textContent = workspaceId;
      workspaceInfoUserIdEl.textContent = identity.userId;
      workspaceInfoUserIdEl.title = identity.userId;
      workspaceInfoProfileStatus.textContent = "";
      workspaceInfoWorkspaceNameStatus.textContent = "";
      const workspaceNameDoc = findWorkspaceNameDoc(treeData.items);
      workspaceInfoWorkspaceNameInput.disabled = workspaceNameDoc === null;
      workspaceInfoSaveWorkspaceNameBtn.disabled = workspaceNameDoc === null;
      workspaceInfoWorkspaceNameInput.value = workspaceNameDoc?.title?.trim() || "";
      try {
        const r = await session.client.getProfile(workspaceId);
        workspaceInfoNicknameInput.value = r.profile.nickname ?? "";
        workspaceInfoProfileStatus.textContent = t("drawer.profile.currentDisplayName", {
          displayName: r.profile.display_name,
        });
      } catch {
        workspaceInfoProfileStatus.textContent = t("drawer.profile.loadingNicknameFailed");
      }
    };

    rerenderActiveWorkbench = renderAll;
    refreshActiveHistoryPanel = refreshHistoryPanel;
    refreshActiveWorkspaceInfoPanel = refreshWorkspaceInfoPanel;

    const copyViaClipboard = async (text: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(text);
        saveStatus(saveStatusEl, t("status.copied"));
      } catch {
        showToast({
          message: t("status.copyFailed"),
          variant: "error",
        });
      }
    };

    workspaceInfoDrawerOpenBtn.addEventListener("click", () => {
      openWorkspaceInfoDrawer();
      void refreshWorkspaceInfoPanel();
    });

    workspaceInfoCopyIdBtn.addEventListener("click", () => void copyViaClipboard(workspaceId));
    workspaceInfoCopyUserIdBtn.addEventListener("click", () => void copyViaClipboard(identity.userId));

    workspaceInfoSaveNicknameBtn.addEventListener("click", () => {
      void (async () => {
        workspaceInfoProfileStatus.textContent = t("drawer.profile.saveInProgress");
        try {
          const r = await session.client.updateProfile(workspaceId, {
            nickname: workspaceInfoNicknameInput.value.trim(),
          });
          workspaceInfoProfileStatus.textContent = t("drawer.profile.savedDisplayName", {
            displayName: r.profile.display_name,
          });
          saveStatus(saveStatusEl, t("drawer.profile.savedDisplayName", { displayName: r.profile.display_name }));
        } catch (e) {
          workspaceInfoProfileStatus.textContent = "";
          notifyError(e);
        }
      })();
    });

    workspaceInfoSaveWorkspaceNameBtn.addEventListener("click", () => {
      void (async () => {
        const workspaceNameDoc = findWorkspaceNameDoc(treeData.items);
        if (!workspaceNameDoc) {
          workspaceInfoWorkspaceNameStatus.textContent = t("drawer.profile.noNameablePage");
          return;
        }
        const nextTitle = workspaceInfoWorkspaceNameInput.value.trim();
        const normalized = nextTitle || t("editor.untitled");
        workspaceInfoWorkspaceNameStatus.textContent = t("drawer.profile.saveInProgress");
        try {
          await session.saveItem(workspaceNameDoc.id, {
            title: normalized,
            expectedRevision: workspaceNameDoc.revision,
          });
          await persistRefreshTree();
          renderAll();
          const nextLabel = formatRecentWorkspaceListLabel(treeData.items, t("editor.untitled"));
          await touchRecentWorkspaceEntry(workspaceId, nextLabel);
          void renderGateRecents();
          workspaceInfoWorkspaceNameInput.value = nextLabel === t("editor.untitled") ? "" : nextLabel;
          workspaceInfoWorkspaceNameStatus.textContent = t("drawer.profile.workspaceNameSaved", {
            workspaceName: nextLabel,
          });
          saveStatus(saveStatusEl, t("doc.workspaceNameSaved"));
        } catch (e) {
          workspaceInfoWorkspaceNameStatus.textContent = "";
          notifyError(e);
        }
      })();
    });

    const currentParentId = (): string => {
      if (active.kind === "folder" && active.id !== ROOT_FOLDER_ID) return active.id;
      return active.parentId ?? ROOT_FOLDER_ID;
    };

    const createAndOpen = async (kind: "page" | "folder", title: string): Promise<void> => {
      try {
        replaceDoc(await session.createItem(kind, title, currentParentId()));
        await persistRefreshTree();
        syncEditorWithActive();
        renderAll();
        void refreshHistoryPanel();
        saveStatus(saveStatusEl, kind === "folder" ? t("doc.createdFolder") : t("doc.createdFile"));
      } catch (e) {
        notifyError(e);
      }
    };

    newFileBtn.addEventListener("click", () => void createAndOpen("page", t("editor.untitledPage")));
    newFolderBtn.addEventListener("click", () => void createAndOpen("folder", t("editor.untitledFolder")));

    pinBtn.addEventListener("click", () => {
      void (async () => {
        if (pinBtn.disabled) return;
        try {
          replaceDoc(await session.setPinned(active.id, !active.pinned));
          await persistRefreshTree();
          renderAll();
          void refreshHistoryPanel();
          saveStatus(saveStatusEl, active.pinned ? t("doc.pinned") : t("doc.unpinned"));
        } catch (e) {
          notifyError(e);
        }
      })();
    });

    deleteBtn.addEventListener("click", () => {
      void (async () => {
        if (deleteBtn.disabled) return;
        try {
          await session.trashItem(active.id);
          await persistRefreshTree();
          syncEditorWithActive();
          renderAll();
          void refreshHistoryPanel();
                saveStatus(saveStatusEl, t("doc.trashed"));
        } catch (e) {
          notifyError(e);
        }
      })();
    });

    renderAll();
    void flushOfflineMutations();

    saveStatus(saveStatusEl, t("status.saved"));

    mounted = true;
    showWorkbench();
    void pullQuota();

    void (async () => {
      await touchRecentWorkspaceEntry(workspaceId, recentListLabel);
    })();
  };

  setupWorkspaceBtn.addEventListener("click", () => {
    void (async () => {
      const password = setupPasswordInput.value;
      const title = backendTitleSetup?.value.trim() || "";
      if (password.length < 1) {
        showGate("setup", t("toast.invalidPassword"), "warning");
        return;
      }
      setGateBusy(true, "setup");
      try {
        await refreshHealth();
        const created = await backendClient.createWorkspace({
          owner_user_id: identity.userId,
          nickname: "",
          password,
          title,
        });
        await mountWithPassword(created.workspace.workspace_id, password, title, {
          active_item_id: created.active_item_id,
          items: created.items,
        });
      } catch (e) {
        setHealthStatus(backendHealthStatus, "error", t("status.backendError"));
        showGate("setup", formatBackendOrUnknownError(e));
      } finally {
        setGateBusy(false, "setup");
      }
    })();
  });

  unlockWorkspaceBtn.addEventListener("click", () => {
    void (async () => {
      const password = unlockPasswordInput.value;
      const wsId = backendWorkspaceIdInput?.value.trim() ?? savedWsId ?? "";
      if (!password) {
        showGate("unlock", t("toast.noPassword"), "warning");
        return;
      }
      if (!wsId) {
        showGate("unlock", t("toast.noWorkspaceId"), "warning");
        return;
      }
      setGateBusy(true, "unlock");
      try {
        void refreshHealth();
        await mountWithPassword(wsId, password);
      } catch (e) {
        setHealthStatus(backendHealthStatus, "error", t("status.backendError"));
        showGate("unlock", formatBackendOrUnknownError(e));
      } finally {
        setGateBusy(false, "unlock");
      }
    })();
  });

  lockWorkspaceBtn.addEventListener("click", () => {
    editor?.destroy();
    window.location.reload();
  });

  window.addEventListener("beforeunload", () => {
    window.clearInterval(healthTimer);
    editor?.destroy();
  });

  showGate(savedWsId ? "unlock" : "setup");
}
