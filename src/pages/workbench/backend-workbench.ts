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
import { createWorkspaceImageSync, type WorkspaceImageSync } from "@/features/workspace/image-sync";
import { createChromeRuntimeStorage } from "@/features/workspace/local-runtime";
import {
  enqueueOfflineMutation,
  loadOfflineMutations,
  removeOfflineMutation,
  type OfflineMutationPatch,
} from "@/features/workspace/offline-queue";
import { loadCollaborativeSnapshot, removeCollaborativeSnapshot, saveCollaborativeSnapshot } from "@/features/collaboration/collab-storage";
import { overlayDirtyCollaborativeDocs } from "@/features/collaboration/dirty-docs";
import { createMarkdownCollaborator } from "@/features/collaboration/yjs-markdown";
import { hasStaleCollaborativeSave, reconcileCollaborativeSave } from "@/features/collaboration/save-race";
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

type BackendDocDraft = {
  workspaceId: string;
  itemId: string;
  markdown?: string;
  title?: string;
  seq: number;
  updatedAt: string;
};

function draftMapKey(workspaceId: string, itemId: string): string {
  return `${workspaceId}::${itemId}`;
}

function collaborativeMarkdownSnapshotKey(workspaceId: string, itemId: string): string {
  return `${workspaceId}::${itemId}`;
}

function hydrateMarkdownFromCollaborativeSnapshot(
  workspaceId: string,
  itemId: string,
  fallbackMarkdown: string,
): string {
  const snapshot = loadCollaborativeSnapshot(collaborativeMarkdownSnapshotKey(workspaceId, itemId));
  if (snapshot === null) return fallbackMarkdown;
  const collaborator = createMarkdownCollaborator();
  try {
    collaborator.applyRemoteUpdate(snapshot);
    return collaborator.getMarkdown();
  } finally {
    collaborator.destroy();
  }
}

function persistCollaborativeMarkdownSnapshot(workspaceId: string, itemId: string, markdown: string): void {
  const collaborator = createMarkdownCollaborator({ initialMarkdown: markdown });
  try {
    saveCollaborativeSnapshot(collaborativeMarkdownSnapshotKey(workspaceId, itemId), collaborator.encodeUpdate());
  } finally {
    collaborator.destroy();
  }
}

type BackendDocDraftSyncMessage = {
  type: "justwork.backendDocDraft.sync";
  drafts: Record<string, BackendDocDraft>;
};

const backendDocDraftSeqClock = new Map<string, number>();
const backendDocDraftCache = new Map<string, BackendDocDraft>();
let backendDocDraftSyncQueue: Promise<void> = Promise.resolve();

function snapshotBackendDocDraftCache(): Record<string, BackendDocDraft> {
  return Object.fromEntries(backendDocDraftCache.entries());
}

async function persistBackendDocDraftSnapshot(snapshot: Record<string, BackendDocDraft>): Promise<void> {
  const payload = { [STORAGE_KEYS.BACKEND_DOC_DRAFTS]: snapshot };
  try {
    if (chrome.storage.session) {
      await chrome.storage.session.set(payload);
    }
  } catch {
    // Session storage is best-effort.
  }
  try {
    const message: BackendDocDraftSyncMessage = {
      type: "justwork.backendDocDraft.sync",
      drafts: snapshot,
    };
    await chrome.runtime.sendMessage(message);
  } catch {
    await chrome.storage.local.set(payload);
  }
}

function queueBackendDocDraftSnapshotPersist(): void {
  backendDocDraftSyncQueue = backendDocDraftSyncQueue
    .then(async () => {
      await persistBackendDocDraftSnapshot(snapshotBackendDocDraftCache());
    })
    .catch(() => {
      // Best-effort persistence queue.
    });
}

function nextBackendDocDraftSeq(key: string, currentSeq = 0): number {
  const now = Date.now();
  const next = Math.max(now, backendDocDraftSeqClock.get(key) ?? 0, currentSeq) + 1;
  backendDocDraftSeqClock.set(key, next);
  return next;
}

async function loadBackendDocDraftMap(): Promise<Record<string, BackendDocDraft>> {
  const merged: Record<string, BackendDocDraft> = {};
  const areas: chrome.storage.StorageArea[] = [];
  if (chrome.storage.session) areas.push(chrome.storage.session);
  areas.push(chrome.storage.local);
  const rawEntries = await Promise.all(areas.map((area) => area.get(STORAGE_KEYS.BACKEND_DOC_DRAFTS)));
  for (const raw of rawEntries) {
    const map = raw[STORAGE_KEYS.BACKEND_DOC_DRAFTS];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [key, value] of Object.entries(map as Record<string, BackendDocDraft>)) {
      if (!value || typeof value !== "object") continue;
      const current = merged[key];
      if (!current || (typeof value.seq === "number" && value.seq >= current.seq)) {
        merged[key] = value;
      }
    }
  }
  for (const [key, draft] of Object.entries(merged)) {
    backendDocDraftCache.set(key, draft);
  }
  return merged;
}

async function getBackendDocDraft(workspaceId: string, itemId: string): Promise<BackendDocDraft | null> {
  const key = draftMapKey(workspaceId, itemId);
  const cached = backendDocDraftCache.get(key) ?? null;
  if (cached) {
    return cached;
  }
  const map = await loadBackendDocDraftMap();
  const draft = map[key] ?? null;
  if (draft) {
    backendDocDraftCache.set(key, draft);
    backendDocDraftSeqClock.set(key, Math.max(backendDocDraftSeqClock.get(key) ?? 0, draft.seq));
  }
  return draft;
}

async function upsertBackendDocDraft(
  workspaceId: string,
  itemId: string,
  patch: { markdown?: string; title?: string },
): Promise<BackendDocDraft> {
  const key = draftMapKey(workspaceId, itemId);
  const prev = backendDocDraftCache.get(key) ?? (await loadBackendDocDraftMap())[key];
  const seq = nextBackendDocDraftSeq(key, prev?.seq ?? 0);
  const draft = {
    workspaceId,
    itemId,
    markdown: patch.markdown ?? prev?.markdown,
    title: patch.title ?? prev?.title,
    seq,
    updatedAt: new Date().toISOString(),
  };
  backendDocDraftCache.set(key, draft);
  queueBackendDocDraftSnapshotPersist();
  return draft;
}

async function removeBackendDocDraft(workspaceId: string, itemId: string, seq: number): Promise<boolean> {
  const key = draftMapKey(workspaceId, itemId);
  const current = backendDocDraftCache.get(key) ?? (await loadBackendDocDraftMap())[key];
  if (!current) return false;
  if (typeof current.seq === "number" && current.seq > seq) return false;
  backendDocDraftCache.delete(key);
  queueBackendDocDraftSnapshotPersist();
  return true;
}

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
  const seen = new Set<string>();
  const pushUnique = (doc: WorkspaceDoc): void => {
    if (seen.has(doc.id)) return;
    seen.add(doc.id);
    out.push(doc);
  };
  const visit = (id: string) => {
    const cur = docs.find((d) => d.id === id);
    if (!cur) return;
    pushUnique(cur);
    (byParent.get(id) || []).forEach((child) => {
      visit(child.id);
    });
  };
  visit(rootId);
  // Include top-level docs (parentId null), such as Welcome or manually moved items.
  (byParent.get("") || []).forEach((doc) => {
    if (doc.id === rootId) return;
    visit(doc.id);
  });
  return out;
}

function saveStatus(el: HTMLElement, text: string): void {
  el.textContent = text;
}

function setSidebarActionLabel(btn: HTMLButtonElement, label: string): void {
  const textEl = btn.querySelector("span:last-child");
  if (textEl) {
    textEl.textContent = label;
    return;
  }
  btn.textContent = label;
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

function shouldQueueAsOfflinePending(error: unknown): boolean {
  if (isOfflineError(error)) return true;
  if (!(error instanceof BackendApiError)) return true;
  // Treat transient backend failures as offline-like to avoid data loss.
  return error.status >= 500 || error.status === 408 || error.status === 429;
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
  const shareBtn = document.getElementById("share-btn") as HTMLButtonElement | null;
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
    !shareBtn ||
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
  let imageSync: WorkspaceImageSync | undefined;
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
    const activeEl = document.activeElement as HTMLElement | null;
    if (activeEl && historyDrawerRoot.contains(activeEl)) activeEl.blur();
    historyDrawerRoot.classList.remove("is-open");
    historyDrawerRoot.setAttribute("aria-hidden", "true");
    historyDrawerOpenBtn.setAttribute("aria-expanded", "false");
  };

  const closeWorkspaceInfoDrawer = (): void => {
    const activeEl = document.activeElement as HTMLElement | null;
    if (activeEl && workspaceInfoDrawerRoot.contains(activeEl)) activeEl.blur();
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
    shareBtn.hidden = true;
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
    shareBtn.hidden = false;
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
    topbarQuotaFill.style.width = "0%";
    topbarQuotaText.textContent = t("status.loading");
    topbarQuota.dataset.level = "ok";

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

    if (active.kind !== "welcome") {
      active = hydrateDocWithCollaborativeSnapshot(active);
      workspace = {
        ...workspace,
        docs: workspace.docs.map((d) => (d.id === active.id ? active : d)),
        activeDocId: active.id,
      };
    }

    active = await hydrateDocWithLocalDraft(active);
    workspace = {
      ...workspace,
      docs: workspace.docs.map((d) => (d.id === active.id ? active : d)),
      activeDocId: active.id,
    };

    const localCollaborativeDocCache = new Map<string, WorkspaceDoc>();
    for (const doc of workspace.docs) {
      localCollaborativeDocCache.set(doc.id, doc);
    }

    imageSync = await createWorkspaceImageSync({
      workspaceId,
      baseUrl: JUSTWORK_BACKEND_URL,
      joinRelay: () => session.joinRelay(),
      onAssetChanged: () => {
        syncEditorWithActive();
        renderAll();
      },
    });
    await imageSync.warmMarkdowns(workspace.docs.map((doc) => doc.markdown));

    const replaceDoc = (doc: WorkspaceDoc): void => {
      active = doc;
      localCollaborativeDocCache.set(doc.id, doc);
      workspace = {
        ...workspace,
        docs: workspace.docs.some((d) => d.id === doc.id)
          ? workspace.docs.map((d) => (d.id === doc.id ? doc : d))
          : [...workspace.docs, doc],
        activeDocId: doc.id,
      };
    };

    const updateDocById = (docId: string, update: (doc: WorkspaceDoc) => WorkspaceDoc): WorkspaceDoc | null => {
      const current = workspace.docs.find((doc) => doc.id === docId);
      if (!current) return null;
      const next = update(current);
      localCollaborativeDocCache.set(docId, next);
      workspace = {
        ...workspace,
        docs: workspace.docs.map((doc) => (doc.id === docId ? next : doc)),
      };
      if (active.id === docId) {
        active = next;
      }
      return next;
    };

    const removeDocById = (docId: string): void => {
      localCollaborativeDocCache.delete(docId);
      const nextDocs = workspace.docs.filter((doc) => doc.id !== docId);
      workspace = {
        ...workspace,
        docs: nextDocs,
        activeDocId: active.id === docId ? (nextDocs[0]?.id ?? WELCOME_DOC_ID) : workspace.activeDocId,
      };
      if (active.id === docId) {
        const fallback = nextDocs.find((doc) => doc.id === workspace.activeDocId) ?? nextDocs[0] ?? active;
        active = fallback;
      }
    };

    let treeRefreshTimer: number | undefined;
    const dirtyDocIds = new Set<string>();
    const scheduleTreeRefresh = (delayMs = 4_000): void => {
      if (treeRefreshTimer !== undefined) {
        window.clearTimeout(treeRefreshTimer);
      }
      treeRefreshTimer = window.setTimeout(() => {
        treeRefreshTimer = undefined;
        void (async () => {
          try {
            await persistRefreshTree();
            renderAll();
            if (historyDrawerRoot.classList.contains("is-open")) {
              await refreshHistoryPanel();
            }
          } catch {
            // Background refresh is best-effort; don't interrupt the active editor flow.
          }
        })();
      }, delayMs);
    };

    type PendingSaveRequest = {
      itemId: string;
      seq: number;
      expectedRevision: number;
      patch: OfflineMutationPatch;
      previousMarkdown: string;
      nextMarkdown: string;
      nextTitle: string;
      doneText: string;
      usesDraftQueue: boolean;
    };

    let saveQueue: Promise<void> = Promise.resolve();

    const commitLocalEdit = (itemId: string, patch: OfflineMutationPatch): void => {
      dirtyDocIds.add(itemId);
      updateDocById(itemId, (doc) => ({
        ...doc,
        title: patch.title ?? doc.title,
        markdown: patch.markdown ?? doc.markdown,
        updatedAt: new Date().toISOString(),
      }));
      if (patch.title !== undefined) {
        void upsertBackendDocDraft(workspaceId, itemId, { title: patch.title }).catch(() => undefined);
      }
      if (patch.markdown !== undefined) {
        persistCollaborativeMarkdownSnapshot(workspaceId, itemId, patch.markdown);
      }
      if (active.id === itemId) {
        if (patch.title !== undefined) {
          titleInput.value = patch.title;
        }
      }
    };

    const queueSaveRequest = (request: PendingSaveRequest): void => {
      saveQueue = saveQueue
        .then(async () => {
          if (request.itemId === active.id) {
            saveStatus(saveStatusEl, t("status.saving"));
          }
          try {
            const liveRevision = workspace.docs.find((doc) => doc.id === request.itemId)?.revision ?? request.expectedRevision;
            const next = await session.saveItem(request.itemId, {
              ...request.patch,
              expectedRevision: liveRevision,
            });
            const draft = request.usesDraftQueue ? await getBackendDocDraft(workspaceId, request.itemId) : null;
            const hasNewerDraft = request.usesDraftQueue && draft !== null && draft.seq > request.seq;
            const liveDoc = localCollaborativeDocCache.get(request.itemId);
            const isStale = hasStaleCollaborativeSave(liveDoc, {
              nextTitle: request.nextTitle,
              nextMarkdown: request.nextMarkdown,
            });
            const saveResolution = reconcileCollaborativeSave(liveDoc, isStale, hasNewerDraft);
            if (request.usesDraftQueue && !hasNewerDraft) {
              await removeBackendDocDraft(workspaceId, request.itemId, request.seq);
            }
            if (!saveResolution.shouldKeepDirty) {
              dirtyDocIds.delete(request.itemId);
            }

            updateDocById(request.itemId, (doc) => {
              return {
                ...doc,
                title: saveResolution.retainedTitle ?? (saveResolution.shouldKeepDirty ? doc.title : next.title),
                markdown: saveResolution.retainedMarkdown ?? (saveResolution.shouldKeepDirty ? doc.markdown : next.markdown),
                revision: next.revision,
                updatedAt: next.updatedAt,
              };
            });

            if (request.patch.markdown !== undefined && saveResolution.shouldReseedSnapshot) {
              persistCollaborativeMarkdownSnapshot(workspaceId, request.itemId, next.markdown);
            }

            if (imageSync && saveResolution.shouldReseedSnapshot) {
              await imageSync.updateReferences(request.previousMarkdown, request.nextMarkdown).catch(() => undefined);
            }
            scheduleTreeRefresh();
            if (request.itemId === active.id) {
              renderAll();
              if (saveResolution.shouldKeepDirty) {
                saveStatus(saveStatusEl, t("status.saving"));
              } else {
                saveStatus(saveStatusEl, request.doneText);
              }
            }
          } catch (e) {
            if (e instanceof BackendApiError && e.code === "conflict") {
              showToast({ message: t("toast.conflict"), variant: "warning" });
              return;
            }
            if (shouldQueueAsOfflinePending(e)) {
              await queueOfflinePatch(request.itemId, request.expectedRevision, request.patch);
              return;
            }
            notifyError(e);
          }
        })
        .catch(() => {
          // Keep queue alive after an error.
        });
    };

    function hydrateDocWithCollaborativeSnapshot(doc: WorkspaceDoc): WorkspaceDoc {
      if (doc.kind !== "page" || doc.id === WELCOME_DOC_ID) return doc;
      return {
        ...doc,
        markdown: hydrateMarkdownFromCollaborativeSnapshot(workspaceId, doc.id, doc.markdown),
      };
    }

    async function hydrateDocWithLocalDraft(doc: WorkspaceDoc): Promise<WorkspaceDoc> {
      if (doc.kind !== "page" || doc.id === WELCOME_DOC_ID) return doc;
      const draft = await getBackendDocDraft(workspaceId, doc.id);
      if (!draft) return doc;
      return {
        ...doc,
        title: draft.title ?? doc.title,
      };
    }

    const persistRefreshTree = async (): Promise<void> => {
      treeData = await session.loadTree();
      const nextActiveId = treeData.items.some((item) => item.id === active.id && !item.in_trash)
        ? active.id
        : treeData.active_item_id;
      workspace = buildDocsStateFromTree(treeData.items, nextActiveId, workspace.workspaceDescription);
      workspace = {
        ...workspace,
        docs: overlayDirtyCollaborativeDocs(workspace.docs, dirtyDocIds, localCollaborativeDocCache),
      };
      const summary = workspace.docs.find((d) => d.id === nextActiveId) ?? workspace.docs[0]!;
      const localMarkdown = summary.kind === "welcome"
        ? summary.markdown
        : hydrateMarkdownFromCollaborativeSnapshot(workspaceId, summary.id, summary.markdown);
      const full = summary.kind === "welcome"
        ? { ...summary, markdown: buildLocalizedWelcomeMarkdown(workspace) }
        : await session.loadItem(summary.id);
      const hydrated = summary.kind === "welcome"
        ? await hydrateDocWithLocalDraft(full)
        : await hydrateDocWithLocalDraft({ ...full, markdown: localMarkdown });
      const local = dirtyDocIds.has(summary.id) ? localCollaborativeDocCache.get(summary.id) ?? null : null;
      if (dirtyDocIds.has(summary.id)) {
        if (local) {
          replaceDoc({
            ...hydrated,
            title: local.title,
            markdown: local.markdown,
          });
        } else {
          replaceDoc(hydrated);
        }
      } else {
        replaceDoc(hydrated);
      }
      if (imageSync) await imageSync.warmMarkdowns([local?.markdown ?? hydrated.markdown]);
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
      const treeSource = alive;
      const tree = flattenTree(treeSource, ROOT_FOLDER_ID);
      const trash = workspace.docs.filter((d) => d.inTrash);

      renderDocRows(pinnedList, pinned, { search: q });
      renderDocRows(docTree, tree, { search: q });
      renderDocRows(trashList, trash, { showTrashActions: true, search: q });
      titleInput.value = displayDocTitle(active);
      titleInput.readOnly = active.kind === "welcome" || active.id === ROOT_FOLDER_ID;
      setSidebarActionLabel(pinBtn, active.pinned ? t("sidebar.unpin") : t("sidebar.pin"));
      pinBtn.disabled = active.kind === "welcome" || active.id === ROOT_FOLDER_ID || active.inTrash;
      pinBtn.title = pinBtn.disabled ? t("doc.protected") : t("sidebar.pin");
      shareBtn.disabled = active.kind === "welcome" || active.kind === "folder" || active.inTrash;
      shareBtn.title = shareBtn.disabled ? t("doc.protected") : t("sidebar.share");
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
                replaceDoc(await session.revertHistoryEvent(ev.id));
                if (imageSync) {
                  await imageSync.updateReferences(ev.after_markdown ?? "", ev.before_markdown ?? "").catch(() => undefined);
                }
                renderAll();
                scheduleTreeRefresh();
                void refreshHistoryPanel();
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
      const previousMarkdown = workspace.docs.find((doc) => doc.id === itemId)?.markdown ?? "";
      const nextMarkdown = patch.markdown ?? previousMarkdown;
      await enqueueOfflineMutation(chrome.storage.local, {
        id: mutationId(),
        workspaceId,
        itemId,
        patch,
        expectedRevision,
        createdAt: new Date().toISOString(),
      });
      commitLocalEdit(itemId, patch);
      if (patch.title !== undefined) {
        renderAll();
      }
      await imageSync?.updateReferences(previousMarkdown, nextMarkdown).catch(() => undefined);
      setHealthStatus(backendHealthStatus, "offline", t("status.offline"));
      saveStatus(saveStatusEl, t("status.offlinePending"));
    };

    flushOfflineMutations = async (): Promise<void> => {
      const pending = (await loadOfflineMutations(chrome.storage.local)).filter((entry) => entry.workspaceId === workspaceId);
      if (pending.length === 0) return;
      const revisionByItem = new Map<string, number>();
      for (const doc of workspace.docs) {
        revisionByItem.set(doc.id, doc.revision);
      }

      for (const mutation of pending) {
        try {
          const expectedRevision = revisionByItem.get(mutation.itemId) ?? mutation.expectedRevision;
          const saved = await session.saveItem(mutation.itemId, {
            ...mutation.patch,
            expectedRevision,
          });
          revisionByItem.set(mutation.itemId, saved.revision);
          updateDocById(mutation.itemId, (doc) => ({
            ...doc,
            revision: saved.revision,
            updatedAt: saved.updatedAt,
          }));
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

      scheduleTreeRefresh();
      renderAll();
      void refreshHistoryPanel();
      saveStatus(saveStatusEl, t("status.synced"));
    };

    const switchActiveDoc = (doc: WorkspaceDoc): void => {
      if (doc.kind === "welcome") {
        const next = { ...doc, markdown: buildLocalizedWelcomeMarkdown(workspace) };
        replaceDoc(next);
        syncEditorWithActive();
        renderAll();
        return;
      }

      const cached = workspace.docs.find((item) => item.id === doc.id) ?? doc;
      replaceDoc({
        ...hydrateDocWithCollaborativeSnapshot({
          ...cached,
          markdown: cached.markdown || "",
        }),
      });
      syncEditorWithActive();
      renderAll();

      void (async () => {
        const full = await session.loadItem(doc.id);
        const hydrated = await hydrateDocWithLocalDraft(hydrateDocWithCollaborativeSnapshot(full));
        if (!dirtyDocIds.has(doc.id)) {
          updateDocById(doc.id, () => hydrated);
        }
        if (active.id === doc.id && !dirtyDocIds.has(doc.id)) {
          active = hydrated;
          syncEditorWithActive();
          renderAll();
        }
        if (imageSync) await imageSync.warmMarkdowns([hydrated.markdown]);
      })();
    };

    const onDropToFolder = (targetFolderId: string | null, draggedId: string) => {
      void (async () => {
        try {
          replaceDoc(await session.moveItem(draggedId, targetFolderId));
          renderAll();
          scheduleTreeRefresh();
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
                renderAll();
                scheduleTreeRefresh();
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
                const full = await session.loadItem(doc.id);
                await session.hardDeleteItem(doc.id);
                if (imageSync) {
                  await imageSync.updateReferences(full.markdown ?? "", "").catch(() => undefined);
                }
                removeCollaborativeSnapshot(collaborativeMarkdownSnapshotKey(workspaceId, doc.id));
                removeDocById(doc.id);
                syncEditorWithActive();
                renderAll();
                scheduleTreeRefresh();
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
                replaceDoc(await session.loadItem(doc.id));
                renderAll();
                scheduleTreeRefresh();
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

    type PendingDocSave = {
      timer: number | undefined;
      expectedRevision: number;
      patch: OfflineMutationPatch;
      nextTitle: string;
      previousMarkdown: string;
      nextMarkdown: string;
      delayMs: number;
    };

    const pendingDocSaves = new Map<string, PendingDocSave>();

    const scheduleDocSave = (
      itemId: string,
      expectedRevision: number,
      patch: OfflineMutationPatch,
      nextTitle: string,
      previousMarkdown: string,
      nextMarkdown: string,
      delayMs: number,
    ): void => {
      const pending = pendingDocSaves.get(itemId);
      const mergedPatch: OfflineMutationPatch = {
        ...(pending?.patch ?? {}),
        ...patch,
      };
      const mergedNextTitle = patch.title !== undefined ? nextTitle : pending?.nextTitle ?? nextTitle;
      const mergedPreviousMarkdown = pending?.previousMarkdown ?? previousMarkdown;
      const mergedNextMarkdown = patch.markdown !== undefined ? nextMarkdown : pending?.nextMarkdown ?? nextMarkdown;
      if (pending?.timer !== undefined) {
        window.clearTimeout(pending.timer);
      }
      const nextPending: PendingDocSave = {
        timer: undefined,
        expectedRevision,
        patch: mergedPatch,
        nextTitle: mergedNextTitle,
        previousMarkdown: mergedPreviousMarkdown,
        nextMarkdown: mergedNextMarkdown,
        delayMs,
      };
      pendingDocSaves.set(itemId, nextPending);
      nextPending.timer = window.setTimeout(() => {
        const current = pendingDocSaves.get(itemId);
        if (!current) return;
        pendingDocSaves.delete(itemId);
        void (async () => {
          const draftPatch = current.patch;
          if (draftPatch.markdown !== undefined) {
            queueSaveRequest({
              itemId,
              seq: 0,
              expectedRevision: current.expectedRevision,
              patch: draftPatch,
              nextTitle: current.nextTitle,
              previousMarkdown: current.previousMarkdown,
              nextMarkdown: current.nextMarkdown,
              doneText: t("status.saved"),
              usesDraftQueue: false,
            });
            return;
          }
          const draft = await upsertBackendDocDraft(workspaceId, itemId, draftPatch);
          queueSaveRequest({
            itemId,
            seq: draft.seq,
            expectedRevision: current.expectedRevision,
            patch: draftPatch,
            nextTitle: current.nextTitle,
            previousMarkdown: current.previousMarkdown,
            nextMarkdown: current.nextMarkdown,
            doneText: t("status.saved"),
            usesDraftQueue: true,
          });
        })();
      }, delayMs);
    };

    editor = createWysiwygEditor({
      container: editorRoot,
      initialMarkdown: active.kind === "welcome" ? buildLocalizedWelcomeMarkdown(workspace) : active.markdown,
      onChange: (markdown) => {
        if (active.kind !== "page" || active.id === WELCOME_DOC_ID) return;
        const itemId = active.id;
        const expectedRevision = active.revision;
        const previousMarkdown = workspace.docs.find((doc) => doc.id === itemId)?.markdown ?? "";
        commitLocalEdit(itemId, { markdown });
        scheduleDocSave(itemId, expectedRevision, { markdown }, active.title, previousMarkdown, markdown, 240);
      },
      imageSync: imageSync.editorSync,
    });
    void imageSync.connect().catch(() => {
      // Relay is best-effort. Local image persistence still works if it is unavailable.
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

    titleInput.addEventListener("input", () => {
      if (active.kind !== "page" || active.id === WELCOME_DOC_ID) return;
      const itemId = active.id;
      const expectedRevision = active.revision;
      const title = titleInput.value.trim() || t("editor.untitledDocument");
      const currentMarkdown = workspace.docs.find((doc) => doc.id === itemId)?.markdown ?? "";
      commitLocalEdit(itemId, { title });
      renderAll();
      scheduleDocSave(itemId, expectedRevision, { title }, title, currentMarkdown, currentMarkdown, 400);
    });
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
          scheduleTreeRefresh();
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
        const created = await session.createItem(kind, title, currentParentId());
        replaceDoc(await hydrateDocWithLocalDraft(hydrateDocWithCollaborativeSnapshot(created)));
        syncEditorWithActive();
        renderAll();
        scheduleTreeRefresh();
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
          renderAll();
          scheduleTreeRefresh();
          saveStatus(saveStatusEl, active.pinned ? t("doc.pinned") : t("doc.unpinned"));
        } catch (e) {
          notifyError(e);
        }
      })();
    });

    shareBtn.addEventListener("click", () => {
      void (async () => {
        if (shareBtn.disabled) return;
        if (active.kind === "welcome" || active.kind === "folder" || active.inTrash) return;
        const prevDisabled = shareBtn.disabled;
        shareBtn.disabled = true;
        shareBtn.classList.add("is-busy");
        shareBtn.setAttribute("aria-busy", "true");
        saveStatus(saveStatusEl, t("status.creatingShare"));
        try {
          const r = await backendClient.createShareLink(workspaceId, active.id);
          await navigator.clipboard.writeText(r.share_url);
          saveStatus(saveStatusEl, t("toast.copied"));
          showToast({ message: t("toast.shareCreated"), variant: "success", durationMs: 4200 });
        } catch (e) {
          notifyError(e);
        } finally {
          shareBtn.classList.remove("is-busy");
          shareBtn.setAttribute("aria-busy", "false");
          shareBtn.disabled = prevDisabled;
        }
      })();
    });

    deleteBtn.addEventListener("click", () => {
      void (async () => {
        if (deleteBtn.disabled) return;
        try {
          await session.trashItem(active.id);
          replaceDoc(await session.loadItem(active.id));
          renderAll();
          scheduleTreeRefresh();
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
    imageSync?.disconnect();
    imageSync = undefined;
    window.location.reload();
  });

  window.addEventListener("beforeunload", () => {
    window.clearInterval(healthTimer);
    editor?.destroy();
    imageSync?.disconnect();
  });

  showGate(savedWsId ? "unlock" : "setup");
}
