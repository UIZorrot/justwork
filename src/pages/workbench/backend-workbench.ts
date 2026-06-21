/** JustWork online workbench: all durable document operations go through the fixed Backend API. */

import { loadOrCreateLocalIdentity } from "@justwork/workspace-runtime";
import {
  BackendApiError,
  createBackendClient,
  type BackendWorkspaceItemKind,
  type WorkspaceTreeItem,
} from "@/features/backend/client";
import { createWysiwygEditor } from "@/features/editor/vditor/create-editor";
import { shouldResyncEditorMarkdown } from "@/features/editor/editor-resync-policy";
import type { DocEditor } from "@/features/editor/types";
import { createMentionPicker } from "@/features/mentions/mention-picker";
import { encodeMentionToken } from "@/features/mentions/mention-token";
import { createCollaborativeTransport } from "@/features/collaboration/collab-transport";
import { normalizeLegacyWelcomeDoc } from "@/features/docs/repo";
import {
  buildDocsStateFromTree,
  createBackendWorkspaceSession,
  ROOT_FOLDER_ID,
  type BackendWorkspaceSession,
} from "@/features/workspace/backend-runtime";
import {
  applyOptimisticRestoreState,
  applyOptimisticTrashState,
} from "@/features/workspace/trash-state";
import {
  applyOptimisticMove,
  applyOptimisticPinned,
} from "@/features/workspace/optimistic-doc-state";
import {
  discardPendingDocSave,
  releasePendingDocSaveBlock,
  shouldSkipDocSave,
  waitForPendingDocSavesToSettle,
} from "@/features/workspace/delete-sync";
import {
  createWorkspaceImageSync,
  type WorkspaceCommunityState,
  type WorkspaceImageSync,
} from "@/features/workspace/image-sync";
import { displayTitleOrFallback, normalizeDocTitleInput } from "@/features/workspace/title-policy";
import { createBoardView, type BoardViewHandle } from "@/features/workspace/board-view";
import {
  appendMentionNotificationsWithCooldown,
  dismissLocalInboxNotification,
  extractMentionNotifications,
  loadLocalInboxState,
  markAllLocalInboxNotificationsRead,
  type LocalInboxState,
} from "@/features/workspace/local-inbox";
import { createChromeRuntimeStorage } from "@/features/workspace/local-runtime";
import {
  loadWorkspaceJoinedMembers,
  loadWorkspaceJoinedMembersFromApi,
  mergeWorkspacePeople,
  upsertWorkspaceJoinedMembers,
  type WorkspaceJoinedMember,
  type WorkspacePeopleEntry,
} from "@/features/workspace/member-directory";
import {
  enqueueOfflineMutation,
  loadOfflineMutations,
  removeOfflineMutation,
  type OfflineMutationPatch,
} from "@/features/workspace/offline-queue";
import {
  applyOfflineDeleteMutationsToDocs,
  enqueueOfflineDeleteMutation,
  loadOfflineDeleteMutations,
  removeOfflineDeleteMutation,
  type OfflineDeleteMutationKind,
} from "@/features/workspace/offline-delete-queue";
import {
  applyWorkspaceOperationJournal,
  type WorkspaceOperation,
} from "@/features/workspace/operation-journal";
import {
  createDefaultBoardContent,
  createDefaultTableContent,
  normalizeStructuredDocumentContent,
  type BoardDocumentContent,
  type StructuredDocumentContent,
  type TableDocumentContent,
} from "@/features/workspace/structured-document";
import {
  clearOptimisticCreatePatch,
  promoteOptimisticCreateDoc,
  stageOptimisticCreatePatch,
} from "@/features/workspace/optimistic-create-patches";
import {
  buildLocalFirstConflictRetryPatch,
  shouldRetryLocalPatchAfterConflict,
} from "@/features/workspace/sync-conflict";
import { applyBackendDocDraft, type BackendDocDraft } from "@/features/workspace/backend-doc-drafts";
import { createTableView, type TableViewHandle } from "@/features/workspace/table-view";
import {
  loadCollaborativeSnapshot,
  removeCollaborativeSnapshot,
  saveCollaborativeSnapshot,
} from "@/features/collaboration/collab-storage";
import { overlayDirtyCollaborativeDocs } from "@/features/collaboration/dirty-docs";
import { planPageEditPersistence } from "@/features/collaboration/page-edit-persistence";
import { isTransportUsable, safeSendCollaborativeUpdate } from "@/features/collaboration/transport-resilience";
import { createMarkdownCollaborator } from "@/features/collaboration/yjs-markdown";
import { createStructuredCollaborator } from "@/features/collaboration/yjs-structured";
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
  type WorkspaceDocContent,
  type WorkspaceDocsState,
} from "@/shared/storage-keys";
import {
  getLocalStorageArea,
  getRuntimeUrl,
  getSessionStorageArea,
  sendRuntimeMessage,
} from "@/shared/browser-platform";
import { showToast, type ToastVariant } from "@/shared/toast";
import { formatBackendOrUnknownError } from "@/shared/user-facing-error";

const DRAG_TYPE = "application/x-justwork-doc-id";
const OPTIMISTIC_DOC_ID_PREFIX = "optimistic_";
const REMOTE_WORKSPACE_POLL_MS = 5_000;

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

function isOptimisticDocId(docId: string): boolean {
  return docId.startsWith(OPTIMISTIC_DOC_ID_PREFIX);
}

function createClientDocId(): string {
  return `doc_${crypto.randomUUID().replace(/-/g, "")}`;
}

function displayDocTitle(doc: WorkspaceDoc): string {
  if (doc.kind === "welcome") return t("doc.welcome");
  if (doc.id === ROOT_FOLDER_ID) return t("doc.root");
  if (doc.kind === "folder") return displayTitleOrFallback(doc.title, t("editor.untitledFolder"));
  if (doc.kind === "table") return displayTitleOrFallback(doc.title, t("editor.untitledTable"));
  if (doc.kind === "board") return displayTitleOrFallback(doc.title, t("editor.untitledBoard"));
  return displayTitleOrFallback(doc.title, t("editor.untitledDocument"));
}

function docKindLabel(doc: WorkspaceDoc): string {
  if (doc.kind === "table") return t("doc.table");
  if (doc.kind === "board") return t("doc.board");
  if (doc.kind === "folder") return t("doc.folder");
  return t("editor.pageTag");
}

function defaultTitleForKind(kind: BackendWorkspaceItemKind): string {
  if (kind === "table") return t("editor.untitledTable");
  if (kind === "board") return t("editor.untitledBoard");
  if (kind === "folder") return t("editor.untitledFolder");
  return t("editor.untitledPage");
}

function buildConnectAgentPrompt(workspaceId: string, password: string, rememberPassword: boolean): string {
  const backendUrl = JUSTWORK_BACKEND_URL;
  const skillUrl = new URL("/agent/SKILL.md", JUSTWORK_BACKEND_URL).toString();
  const openapiUrl = new URL("/openapi.json", JUSTWORK_BACKEND_URL).toString();
  const passwordValue = rememberPassword ? password : "<replace with workspace password>";
  const passwordNote = rememberPassword
    ? "The password was supplied from this browser's local remembered password. The backend does not store it."
    : "Password was not remembered on this device. Replace the placeholder before sending this setup text to an Agent.";
  return [
    "Use the JustWork Agent Skill to join this workspace.",
    "",
    `Backend URL: ${backendUrl}`,
    `Skill URL: ${skillUrl}`,
    `OpenAPI URL: ${openapiUrl}`,
    "",
    `Workspace ID: ${workspaceId}`,
    `Workspace password: ${passwordValue}`,
    "",
    passwordNote,
    "",
    "First read the Skill URL and OpenAPI schema. Verify access before doing work. Ask me before mutating workspace data.",
  ].join("\n");
}

function displayDocIcon(doc: WorkspaceDoc): string {
  if (doc.kind === "folder") return "\uD83D\uDCC1";
  if (doc.kind === "table") return "\u25A6";
  if (doc.kind === "board") return "\u2630";
  return "\uD83D\uDCC4";
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

function formatWorkspaceTitle(title: string | undefined, unnamedLabel: string): string {
  const trimmed = title?.trim() ?? "";
  if (trimmed) return trimmed;
  return unnamedLabel;
}

type RecentWorkspaceEntry = {
  workspaceId: string;
  label: string;
  lastUsedAt: string;
};

function draftMapKey(workspaceId: string, itemId: string): string {
  return `${workspaceId}::${itemId}`;
}

function collaborativeMarkdownSnapshotKey(workspaceId: string, itemId: string): string {
  return `${workspaceId}::${itemId}`;
}

type WorkspaceNicknameMap = Record<string, string>;
type RememberedWorkspacePasswordMap = Record<string, string>;

function workspaceNicknameStorageKey(): string {
  return STORAGE_KEYS.BACKEND_WORKSPACE_NICKNAMES;
}

function workspaceNicknameMapKey(workspaceId: string, userId: string): string {
  return `${workspaceId}::${userId}`;
}

const localStorageArea = getLocalStorageArea() as unknown as chrome.storage.StorageArea;
const sessionStorageArea = getSessionStorageArea() as unknown as chrome.storage.StorageArea;

async function loadWorkspaceNicknameMap(): Promise<WorkspaceNicknameMap> {
  const raw = await localStorageArea.get(workspaceNicknameStorageKey());
  const value = raw[workspaceNicknameStorageKey()];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const next: WorkspaceNicknameMap = {};
  for (const [workspaceId, nickname] of Object.entries(value as WorkspaceNicknameMap)) {
    if (typeof nickname === "string") next[workspaceId] = nickname;
  }
  return next;
}

async function getWorkspaceNickname(workspaceId: string, userId: string): Promise<string> {
  const map = await loadWorkspaceNicknameMap();
  return map[workspaceNicknameMapKey(workspaceId, userId)]?.trim() ?? "";
}

async function setWorkspaceNickname(workspaceId: string, userId: string, nickname: string): Promise<void> {
  const map = await loadWorkspaceNicknameMap();
  map[workspaceNicknameMapKey(workspaceId, userId)] = nickname.trim();
  await localStorageArea.set({ [workspaceNicknameStorageKey()]: map });
}

async function loadRememberedWorkspacePasswordMap(): Promise<RememberedWorkspacePasswordMap> {
  const raw = await localStorageArea.get(STORAGE_KEYS.BACKEND_WORKSPACE_PASSWORDS);
  const value = raw[STORAGE_KEYS.BACKEND_WORKSPACE_PASSWORDS];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const next: RememberedWorkspacePasswordMap = {};
  for (const [workspaceId, password] of Object.entries(value as RememberedWorkspacePasswordMap)) {
    if (typeof password === "string") next[workspaceId] = password;
  }
  return next;
}

async function getRememberedWorkspacePassword(workspaceId: string): Promise<string> {
  if (!workspaceId.trim()) return "";
  const map = await loadRememberedWorkspacePasswordMap();
  return map[workspaceId] ?? "";
}

async function setRememberedWorkspacePassword(workspaceId: string, password: string): Promise<void> {
  const id = workspaceId.trim();
  if (!id || !password) return;
  const map = await loadRememberedWorkspacePasswordMap();
  map[id] = password;
  await localStorageArea.set({ [STORAGE_KEYS.BACKEND_WORKSPACE_PASSWORDS]: map });
}

async function removeRememberedWorkspacePassword(workspaceId: string): Promise<void> {
  const id = workspaceId.trim();
  if (!id) return;
  const map = await loadRememberedWorkspacePasswordMap();
  if (!(id in map)) return;
  delete map[id];
  await localStorageArea.set({ [STORAGE_KEYS.BACKEND_WORKSPACE_PASSWORDS]: map });
}

const WORKSPACE_SESSION_ID_KEY = "justwork.backend.workspaceSessionId.v1";

function getOrCreateWorkspaceSessionId(): string {
  const existing = sessionStorage.getItem(WORKSPACE_SESSION_ID_KEY);
  if (existing) return existing;
  const next = crypto.randomUUID();
  sessionStorage.setItem(WORKSPACE_SESSION_ID_KEY, next);
  return next;
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
    await sessionStorageArea.set(payload);
  } catch {
    // Session storage is best-effort.
  }
  try {
    const message: BackendDocDraftSyncMessage = {
      type: "justwork.backendDocDraft.sync",
      drafts: snapshot,
    };
    await sendRuntimeMessage(message);
  } catch {
    await localStorageArea.set(payload);
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
  const areas = [sessionStorageArea, localStorageArea];
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
  patch: { markdown?: string; title?: string; content?: WorkspaceDocContent | null },
  baseRevision?: number,
): Promise<BackendDocDraft> {
  const key = draftMapKey(workspaceId, itemId);
  const prev = backendDocDraftCache.get(key) ?? (await loadBackendDocDraftMap())[key];
  const seq = nextBackendDocDraftSeq(key, prev?.seq ?? 0);
  const draft = {
    workspaceId,
    itemId,
    markdown: patch.markdown ?? prev?.markdown,
    title: patch.title ?? prev?.title,
    content: patch.content ?? prev?.content,
    seq,
    updatedAt: new Date().toISOString(),
    baseRevision: baseRevision ?? prev?.baseRevision,
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
  const raw = await localStorageArea.get(STORAGE_KEYS.BACKEND_WORKSPACE_RECENTS);
  const v = raw[STORAGE_KEYS.BACKEND_WORKSPACE_RECENTS];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is RecentWorkspaceEntry => {
    if (!x || typeof x !== "object") return false;
    const e = x as RecentWorkspaceEntry;
    return typeof e.workspaceId === "string" && typeof e.label === "string";
  });
}

async function saveRecentWorkspaceEntries(list: RecentWorkspaceEntry[]): Promise<void> {
  await localStorageArea.set({ [STORAGE_KEYS.BACKEND_WORKSPACE_RECENTS]: list });
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

function flattenTree(docs: WorkspaceDoc[], rootId: string, collapsedFolderIds: Set<string> = new Set()): WorkspaceDoc[] {
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
    if (cur.kind === "folder" && collapsedFolderIds.has(cur.id)) return;
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
  const pageKindTag = document.getElementById("page-kind-tag") as HTMLElement | null;
  const newFileBtn = document.getElementById("new-file-btn") as HTMLButtonElement | null;
  const newTableBtn = document.getElementById("new-table-btn") as HTMLButtonElement | null;
  const newBoardBtn = document.getElementById("new-board-btn") as HTMLButtonElement | null;
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
  const setupRememberPasswordInput = document.getElementById("setup-remember-password-input") as HTMLInputElement | null;
  const unlockRememberPasswordInput = document.getElementById("unlock-remember-password-input") as HTMLInputElement | null;
  const setupWorkspaceBtn = document.getElementById("setup-workspace-btn") as HTMLButtonElement | null;
  const unlockWorkspaceBtn = document.getElementById("unlock-workspace-btn") as HTMLButtonElement | null;
  const createWorkspaceBtn = document.getElementById("create-workspace-btn") as HTMLButtonElement | null;
  const lockWorkspaceBtn = document.getElementById("lock-workspace-btn") as HTMLButtonElement | null;
  const gateError = document.getElementById("workspace-gate-error") as HTMLElement | null;
  const backendTitleSetup = document.getElementById("backend-title-setup-input") as HTMLInputElement | null;
  const backendWorkspaceIdInput = document.getElementById("backend-workspace-id-input") as HTMLInputElement | null;
  const workspaceInfoDrawerRoot = document.getElementById("workspace-info-drawer-root") as HTMLElement | null;
  const workspaceInfoDrawerBackdrop = document.getElementById("workspace-info-drawer-backdrop") as HTMLElement | null;
  const workspaceInfoDrawerCloseBtn = document.getElementById("workspace-info-drawer-close-btn") as HTMLButtonElement | null;
  const workspaceInfoDrawerOpenBtn = document.getElementById("workspace-info-drawer-open-btn") as HTMLButtonElement | null;
  const workspaceMessageDrawerRoot = document.getElementById("workspace-message-drawer-root") as HTMLElement | null;
  const workspaceMessageDrawerBackdrop = document.getElementById("workspace-message-drawer-backdrop") as HTMLElement | null;
  const workspaceMessageDrawer = document.getElementById("workspace-message-drawer") as HTMLElement | null;
  const workspaceMessageDrawerOpenBtn = document.getElementById("workspace-message-drawer-open-btn") as HTMLButtonElement | null;
  const workspaceMessageUnreadBadge = document.getElementById("workspace-message-unread-badge") as HTMLElement | null;
  const workspaceMessageDrawerCloseBtn = document.getElementById("workspace-message-drawer-close-btn") as HTMLButtonElement | null;
  const workspaceMessageMarkReadBtn = document.getElementById("workspace-message-mark-read-btn") as HTMLButtonElement | null;
  const workspaceMessageDrawerCount = document.getElementById("workspace-message-drawer-count") as HTMLElement | null;
  const workspaceMessageMembers = document.getElementById("workspace-message-members") as HTMLElement | null;
  const workspaceMessageLog = document.getElementById("workspace-message-log") as HTMLElement | null;
  const workspacePeopleCount = document.getElementById("workspace-people-count") as HTMLElement | null;
  const workspacePeopleList = document.getElementById("workspace-people-list") as HTMLElement | null;
  const workspacePeopleToggle = document.getElementById("workspace-people-toggle") as HTMLButtonElement | null;
  const pinnedToggle = document.getElementById("pinned-toggle") as HTMLButtonElement | null;
  const pagesToggle = document.getElementById("pages-toggle") as HTMLButtonElement | null;
  const trashToggle = document.getElementById("trash-toggle") as HTMLButtonElement | null;
  const connectAgentBtn = document.getElementById("connect-agent-btn") as HTMLButtonElement | null;
  const connectAgentDialogRoot = document.getElementById("connect-agent-dialog-root") as HTMLElement | null;
  const connectAgentDialogBackdrop = document.getElementById("connect-agent-dialog-backdrop") as HTMLElement | null;
  const connectAgentDialogCloseBtn = document.getElementById("connect-agent-dialog-close-btn") as HTMLButtonElement | null;
  const connectAgentPromptText = document.getElementById("connect-agent-prompt-text") as HTMLTextAreaElement | null;
  const connectAgentCopyBtn = document.getElementById("connect-agent-copy-btn") as HTMLButtonElement | null;
  const connectAgentDownloadSkillLink = document.getElementById("connect-agent-download-skill-link") as HTMLAnchorElement | null;
  const connectAgentBackendSkillLink = document.getElementById("connect-agent-backend-skill-link") as HTMLAnchorElement | null;
  const workspaceNicknamePromptRoot = document.getElementById("workspace-nickname-prompt-root") as HTMLElement | null;
  const workspaceNicknamePromptBackdrop = document.getElementById("workspace-nickname-prompt-backdrop") as HTMLElement | null;
  const workspaceNicknamePrompt = document.getElementById("workspace-nickname-prompt") as HTMLElement | null;
  const workspaceNicknamePromptInput = document.getElementById("workspace-nickname-prompt-input") as HTMLInputElement | null;
  const workspaceNicknamePromptSaveBtn = document.getElementById("workspace-nickname-prompt-save-btn") as HTMLButtonElement | null;
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
    !pageKindTag ||
    !newFileBtn ||
    !newTableBtn ||
    !newBoardBtn ||
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
    !setupRememberPasswordInput ||
    !unlockRememberPasswordInput ||
    !setupWorkspaceBtn ||
    !unlockWorkspaceBtn ||
    !createWorkspaceBtn ||
    !lockWorkspaceBtn ||
    !gateError ||
    !workspaceInfoDrawerRoot ||
    !workspaceInfoDrawerBackdrop ||
    !workspaceInfoDrawerCloseBtn ||
    !workspaceInfoDrawerOpenBtn ||
    !workspaceMessageDrawerRoot ||
    !workspaceMessageDrawerBackdrop ||
    !workspaceMessageDrawer ||
    !workspaceMessageDrawerOpenBtn ||
    !workspaceMessageUnreadBadge ||
    !workspaceMessageDrawerCloseBtn ||
    !workspaceMessageDrawerCount ||
    !workspaceMessageMembers ||
    !workspaceMessageLog ||
    !workspacePeopleCount ||
    !workspacePeopleList ||
    !workspacePeopleToggle ||
    !pinnedToggle ||
    !pagesToggle ||
    !trashToggle ||
    !connectAgentBtn ||
    !connectAgentDialogRoot ||
    !connectAgentDialogBackdrop ||
    !connectAgentDialogCloseBtn ||
    !connectAgentPromptText ||
    !connectAgentCopyBtn ||
    !connectAgentDownloadSkillLink ||
    !connectAgentBackendSkillLink ||
    !workspaceNicknamePromptRoot ||
    !workspaceNicknamePromptBackdrop ||
    !workspaceNicknamePrompt ||
    !workspaceNicknamePromptInput ||
    !workspaceNicknamePromptSaveBtn ||
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
  const savedWsId = (await localStorageArea.get(STORAGE_KEYS.LAST_BACKEND_WORKSPACE_ID))[
    STORAGE_KEYS.LAST_BACKEND_WORKSPACE_ID
  ] as string | undefined;

  const applyRememberedPasswordForWorkspace = async (workspaceId: string): Promise<void> => {
    const rememberedPassword = await getRememberedWorkspacePassword(workspaceId);
    if (rememberedPassword) {
      unlockPasswordInput.value = rememberedPassword;
      unlockRememberPasswordInput.checked = true;
      return;
    }
    unlockPasswordInput.value = "";
    unlockRememberPasswordInput.checked = false;
  };

  if (backendWorkspaceIdInput && savedWsId) {
    backendWorkspaceIdInput.value = savedWsId;
    void applyRememberedPasswordForWorkspace(savedWsId);
  }

  let editor: DocEditor | undefined;
  let imageSync: WorkspaceImageSync | undefined;
  const markdownHost = document.createElement("div");
  markdownHost.className = "doc-editor-surface doc-editor-surface--markdown";
  const structuredHost = document.createElement("div");
  structuredHost.className = "doc-editor-surface doc-editor-surface--structured";
  editorRoot.replaceChildren(markdownHost, structuredHost);
  let tableView: TableViewHandle | undefined;
  let boardView: BoardViewHandle | undefined;
  let structuredSurfaceDocId: string | null = null;
  let structuredSurfaceKind: WorkspaceDoc["kind"] | null = null;
  const boardTemplateCollapsedState = new Map<string, boolean>();
  let mounted = false;
  let flushOfflineMutations: () => Promise<void> = async () => {};
  let rerenderActiveWorkbench: (() => void) | undefined;
  let refreshActiveWorkspaceInfoPanel: (() => Promise<void>) | undefined;
  let refreshQuotaBar: (() => Promise<void>) | undefined;
  let communityState: WorkspaceCommunityState = { members: [] };
  let closeMessageDrawer: () => void = () => {};
  let closeConnectAgentDialog: () => void = () => {};
  let rememberWorkspacePassword = false;
  let workspaceSyncTimer: number | undefined;

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
    void refreshActiveWorkspaceInfoPanel?.();
    void refreshQuotaBar?.();
  };
  const disposeLocaleObserver = observePreferredLocaleChanges(handleLocaleChanged);

  const closeWorkspaceInfoDrawer = (): void => {
    const activeEl = document.activeElement as HTMLElement | null;
    if (activeEl && workspaceInfoDrawerRoot.contains(activeEl)) activeEl.blur();
    workspaceInfoDrawerRoot.classList.remove("is-open");
    workspaceInfoDrawerRoot.setAttribute("aria-hidden", "true");
    workspaceInfoDrawerOpenBtn.setAttribute("aria-expanded", "false");
  };

  const openWorkspaceInfoDrawer = (): void => {
    closeMessageDrawer();
    closeConnectAgentDialog();
    workspaceInfoDrawerRoot.classList.add("is-open");
    workspaceInfoDrawerRoot.setAttribute("aria-hidden", "false");
    workspaceInfoDrawerOpenBtn.setAttribute("aria-expanded", "true");
  };

  workspaceInfoDrawerCloseBtn.addEventListener("click", closeWorkspaceInfoDrawer);
  workspaceInfoDrawerBackdrop.addEventListener("click", closeWorkspaceInfoDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (workspaceInfoDrawerRoot.classList.contains("is-open")) {
      closeWorkspaceInfoDrawer();
      return;
    }
    if (workspaceMessageDrawerRoot.classList.contains("is-open")) {
      closeMessageDrawer();
      return;
    }
    if (connectAgentDialogRoot.classList.contains("is-open")) {
      closeConnectAgentDialog();
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
    void applyRememberedPasswordForWorkspace(workspaceId);
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
  const backendWorkspaceIdInputEl = backendWorkspaceIdInput as HTMLInputElement;
  backendWorkspaceIdInputEl.addEventListener("change", () => {
    void applyRememberedPasswordForWorkspace(backendWorkspaceIdInputEl.value.trim());
  });
  unlockRememberPasswordInput.addEventListener("change", () => {
    if (unlockRememberPasswordInput.checked) return;
    const wsId = backendWorkspaceIdInputEl.value.trim() || savedWsId || "";
    void removeRememberedWorkspacePassword(wsId);
  });

  const showGate = (mode: "setup" | "unlock", message = "", variant: ToastVariant = "error"): void => {
    closeWorkspaceInfoDrawer();
    closeMessageDrawer();
    closeConnectAgentDialog();
    shell.hidden = true;
    lockWorkspaceBtn.hidden = true;
    pinBtn.hidden = true;
    shareBtn.hidden = true;
    deleteBtn.hidden = true;
    workspaceInfoDrawerOpenBtn.hidden = true;
    workspaceMessageDrawerOpenBtn.hidden = true;
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
    workspaceInfoDrawerOpenBtn.hidden = false;
    workspaceMessageDrawerOpenBtn.hidden = false;
    topbarQuota.hidden = false;
    gateError.textContent = "";
  };

  const setGateBusy = (busy: boolean, panel: "setup" | "unlock"): void => {
    gateRecentSection.classList.toggle("is-disabled", busy);
    setupWorkspaceBtn.disabled = busy;
    unlockWorkspaceBtn.disabled = busy;
    createWorkspaceBtn.disabled = busy;
    setupPasswordInput.disabled = busy;
    unlockPasswordInput.disabled = busy;
    setupRememberPasswordInput.disabled = busy;
    unlockRememberPasswordInput.disabled = busy;
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
    initialTreeData?: { active_item_id: string; workspace_title: string; items: WorkspaceTreeItem[] },
    rememberPassword = false,
  ): Promise<void> => {
    if (mounted) return;

    const session: BackendWorkspaceSession = createBackendWorkspaceSession({
      baseUrl: JUSTWORK_BACKEND_URL,
      workspaceId,
      password,
      signingIdentity: identity,
    });
    const sessionId = getOrCreateWorkspaceSessionId();
    let participantNickname = (await getWorkspaceNickname(workspaceId, identity.userId)).trim();
    let resolveNicknamePrompt: ((nickname: string) => void) | undefined;

    const closeNicknamePrompt = (): void => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && workspaceNicknamePromptRoot.contains(focused)) {
        focused.blur();
      }
      workspaceNicknamePromptRoot.classList.remove("is-open");
      workspaceNicknamePromptRoot.setAttribute("aria-hidden", "true");
    };

    const openNicknamePrompt = (initialValue: string): void => {
      workspaceNicknamePromptInput.value = initialValue;
      workspaceNicknamePromptRoot.classList.add("is-open");
      workspaceNicknamePromptRoot.setAttribute("aria-hidden", "false");
      workspaceNicknamePromptInput.focus();
      workspaceNicknamePromptInput.select();
    };

    const persistNickname = async (nickname: string): Promise<void> => {
      const next = nickname.trim();
      participantNickname = next;
      await setWorkspaceNickname(workspaceId, identity.userId, next);
      await upsertWorkspaceJoinedMembers(localStorageArea, workspaceId, [{
        displayName: next,
        userId: identity.userId,
        source: "local",
      }]);
      try {
        await session.updateProfile(next);
      } catch {
        // Local presence should keep working even if the server profile write fails.
      }
    };

    const ensureNickname = async (): Promise<string> => {
      if (participantNickname) return participantNickname;
      const serverMembers = await session.listMembers().catch(() => []);
      const currentMember = serverMembers.find((member) => member.user_id === identity.userId);
      const initial = currentMember?.nickname?.trim() ?? "";
      return await new Promise<string>((resolve) => {
        resolveNicknamePrompt = resolve;
        openNicknamePrompt(initial);
      });
    };

    workspaceNicknamePromptBackdrop.addEventListener("click", () => {
      workspaceNicknamePromptInput.focus();
    });
    workspaceNicknamePromptInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      workspaceNicknamePromptSaveBtn.click();
    });
    workspaceNicknamePromptSaveBtn.addEventListener("click", () => {
      void (async () => {
        const next = workspaceNicknamePromptInput.value.trim();
        if (!next) {
          workspaceNicknamePromptInput.focus();
          return;
        }
        await persistNickname(next);
        closeNicknamePrompt();
        resolveNicknamePrompt?.(next);
        resolveNicknamePrompt = undefined;
        workspaceMessageDrawerOpenBtn.focus();
      })();
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
    await localStorageArea.set({ [STORAGE_KEYS.LAST_BACKEND_WORKSPACE_ID]: workspaceId });
    rememberWorkspacePassword = rememberPassword;
    if (rememberPassword) {
      await setRememberedWorkspacePassword(workspaceId, password);
    } else {
      await removeRememberedWorkspacePassword(workspaceId);
    }
    const recentListLabel = formatWorkspaceTitle(recentLabelHint || treeData.workspace_title, t("editor.untitled"));
    let workspace: WorkspaceDocsState = buildDocsStateFromTree(
      treeData.items,
      treeData.active_item_id,
      formatWorkspaceTitle(treeData.workspace_title, recentListLabel),
      t("doc.workspaceBackend"),
    );
    let localOperationSeq = 0;
    let localOperationJournal: WorkspaceOperation[] = [];
    const recordLocalCreateOperation = (doc: WorkspaceDoc): string => {
      localOperationSeq += 1;
      const id = mutationId();
      localOperationJournal = [
        ...localOperationJournal.filter((entry) => entry.itemId !== doc.id),
        {
          id,
          workspaceId,
          itemId: doc.id,
          kind: "create",
          doc: { ...doc },
          localSeq: localOperationSeq,
          createdAt: doc.updatedAt || new Date().toISOString(),
        },
      ];
      return id;
    };
    const updateLocalCreateOperationDoc = (doc: WorkspaceDoc): void => {
      localOperationJournal = localOperationJournal.map((entry) => (
        entry.itemId === doc.id && entry.kind === "create"
          ? {
              ...entry,
              doc: { ...doc },
            }
          : entry
      ));
    };
    const recordLocalDeleteOperation = (itemId: string, kind: OfflineDeleteMutationKind): string => {
      localOperationSeq += 1;
      const id = mutationId();
      localOperationJournal = [
        ...localOperationJournal.filter((entry) => entry.itemId !== itemId),
        {
          id,
          workspaceId,
          itemId,
          kind,
          localSeq: localOperationSeq,
          createdAt: new Date().toISOString(),
        },
      ];
      return id;
    };
    const recordLocalEditOperation = (itemId: string, baseRevision: number, patch: OfflineMutationPatch): string => {
      localOperationSeq += 1;
      const previous = localOperationJournal.find((entry) => entry.itemId === itemId && entry.kind === "edit");
      const id = previous?.id ?? mutationId();
      localOperationJournal = [
        ...localOperationJournal.filter((entry) => !(entry.itemId === itemId && entry.kind === "edit")),
        {
          id,
          workspaceId,
          itemId,
          kind: "edit",
          patch: {
            ...(previous?.patch ?? {}),
            ...patch,
          },
          baseRevision: previous?.baseRevision ?? baseRevision,
          localSeq: localOperationSeq,
          createdAt: new Date().toISOString(),
        },
      ];
      return id;
    };
    const removeLocalOperation = (operationId: string): void => {
      localOperationJournal = localOperationJournal.filter((entry) => entry.id !== operationId);
    };
    const removeLocalEditOperations = (itemId: string): void => {
      localOperationJournal = localOperationJournal.filter((entry) => !(entry.itemId === itemId && entry.kind === "edit"));
    };
    const hasLocalEditOperation = (itemId: string): boolean => (
      localOperationJournal.some((entry) => entry.itemId === itemId && entry.kind === "edit")
    );
    const dirtyDocIdsWithoutJournalEdits = (): Set<string> => (
      new Set([...dirtyDocIds].filter((itemId) => !hasLocalEditOperation(itemId)))
    );
    const overlayDirtyDocsWithoutJournalEdits = (): void => {
      workspace = {
        ...workspace,
        docs: overlayDirtyCollaborativeDocs(
          workspace.docs,
          dirtyDocIdsWithoutJournalEdits(),
          localCollaborativeDocCache,
        ),
      };
    };
    const replayLocalOperationJournal = (): void => {
      const previousEditItemIds = new Set(
        localOperationJournal.filter((entry) => entry.kind === "edit").map((entry) => entry.itemId),
      );
      const replayed = applyWorkspaceOperationJournal(workspace, localOperationJournal);
      workspace = replayed.state;
      localOperationJournal = replayed.operations;
      for (const itemId of previousEditItemIds) {
        if (!hasLocalEditOperation(itemId)) {
          dirtyDocIds.delete(itemId);
        }
      }
    };
    workspace = applyOfflineDeleteMutationsToDocs(
      workspace,
      (await loadOfflineDeleteMutations(localStorageArea)).filter((entry) => entry.workspaceId === workspaceId),
    );
    replayLocalOperationJournal();

    let active = workspace.docs.find((d) => d.id === treeData.active_item_id && !d.inTrash)
      ?? workspace.docs.find((d) => !d.inTrash)
      ?? workspace.docs[0]!;
    if (active.kind === "welcome") {
      active = { ...active, markdown: buildLocalizedWelcomeMarkdown(workspace) };
      workspace = {
        ...workspace,
        docs: workspace.docs.map((d) => (d.id === active.id ? active : d)),
      };
    } else {
      active = { ...active, markdown: active.markdown || "" };
      workspace = {
        ...workspace,
        docs: workspace.docs.map((d) => (d.id === active.id ? active : d)),
        activeDocId: active.id,
      };
    }
    const collapsedFolderIds = new Set<string>();
    const collapsedSidebarSections = new Set<string>();

    const setSidebarSectionCollapsed = (section: "people" | "pinned" | "pages" | "trash", collapsed: boolean): void => {
      const toggle = section === "people"
        ? workspacePeopleToggle
        : section === "pinned"
          ? pinnedToggle
          : section === "pages"
            ? pagesToggle
            : trashToggle;
      const panel = section === "people"
        ? workspacePeopleList.parentElement
        : section === "pinned"
          ? pinnedList.parentElement
          : section === "pages"
            ? docTree.parentElement
            : trashList.parentElement;
      if (!toggle || !panel) return;
      if (collapsed) {
        collapsedSidebarSections.add(section);
      } else {
        collapsedSidebarSections.delete(section);
      }
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      panel.classList.toggle("is-collapsed", collapsed);
    };

    const toggleSidebarSection = (section: "people" | "pinned" | "pages" | "trash"): void => {
      setSidebarSectionCollapsed(section, !collapsedSidebarSections.has(section));
    };

    workspacePeopleToggle.addEventListener("click", () => toggleSidebarSection("people"));
    pinnedToggle.addEventListener("click", () => toggleSidebarSection("pinned"));
    pagesToggle.addEventListener("click", () => toggleSidebarSection("pages"));
    trashToggle.addEventListener("click", () => toggleSidebarSection("trash"));
    setSidebarSectionCollapsed("people", false);
    setSidebarSectionCollapsed("pinned", false);
    setSidebarSectionCollapsed("pages", false);
    setSidebarSectionCollapsed("trash", false);

    if (active.kind === "page" || active.kind === "table" || active.kind === "board") {
      const fullActive = await session.loadItem(active.id);
      active = await hydrateDocWithLocalDraft({
        ...active,
        ...fullActive,
      });
    } else {
      active = await hydrateDocWithLocalDraft(active);
    }
    workspace = {
      ...workspace,
      docs: workspace.docs.map((d) => (d.id === active.id ? active : d)),
      activeDocId: active.id,
    };

    const localCollaborativeDocCache = new Map<string, WorkspaceDoc>();
    const optimisticCreatePatches = new Map<string, OfflineMutationPatch>();
    const creatingDocIds = new Set<string>();
    const isCreatePendingDocId = (docId: string): boolean => creatingDocIds.has(docId) || isOptimisticDocId(docId);
    const hydratedDocIds = new Set<string>();
    for (const doc of workspace.docs) {
      localCollaborativeDocCache.set(doc.id, doc);
    }
    const markDocHydrated = (docId: string): void => {
      if (docId !== WELCOME_DOC_ID && docId !== ROOT_FOLDER_ID) {
        hydratedDocIds.add(docId);
      }
    };
    const collaborativeMarkdownDocs = new Map<string, ReturnType<typeof createMarkdownCollaborator>>();
    const collaborativeStructuredDocs = new Map<string, ReturnType<typeof createStructuredCollaborator>>();
    const getCollaboratorForDoc = (doc: WorkspaceDoc): ReturnType<typeof createMarkdownCollaborator> => {
      const existing = collaborativeMarkdownDocs.get(doc.id);
      if (existing) return existing;
      const fallbackMarkdown = doc.markdown || "";
      const collaborator = createMarkdownCollaborator({ initialMarkdown: fallbackMarkdown });
      const snapshot = loadCollaborativeSnapshot(collaborativeMarkdownSnapshotKey(workspaceId, doc.id));
      if (snapshot) {
        collaborator.applyRemoteUpdate(snapshot);
      }
      const normalizedMarkdown = stripAutoTitleHeading(collaborator.getMarkdown(), doc.title);
      if (normalizedMarkdown !== collaborator.getMarkdown()) {
        collaborator.applyLocalMarkdown(normalizedMarkdown);
      }
      collaborativeMarkdownDocs.set(doc.id, collaborator);
      return collaborator;
    };
    const getStructuredCollaboratorForDoc = (
      doc: WorkspaceDoc,
    ): ReturnType<typeof createStructuredCollaborator> => {
      const existing = collaborativeStructuredDocs.get(doc.id);
      if (existing) return existing;
      const kind = doc.kind === "table" ? "table" : "board";
      const fallbackContent = normalizeStructuredDocumentContent(
        kind,
        doc.content ?? (kind === "table" ? createDefaultTableContent() : createDefaultBoardContent()),
      );
      const collaborator = createStructuredCollaborator({
        kind,
        initialContent: fallbackContent,
      });
      const snapshot = loadCollaborativeSnapshot(collaborativeMarkdownSnapshotKey(workspaceId, doc.id));
      if (snapshot) {
        collaborator.applyRemoteUpdate(snapshot);
      }
      collaborativeStructuredDocs.set(doc.id, collaborator);
      return collaborator;
    };
    const collaborativeTransportUrl = (itemId: string, ticket: string): string => {
      const url = new URL(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/collab`,
        JUSTWORK_BACKEND_URL,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", ticket);
      return url.toString();
    };
    let activeCollaborativeItemId: string | null = null;
    let activeCollaborativeTransport: ReturnType<typeof createCollaborativeTransport> | undefined;
    let activeCollaborativeUnsubscribe: (() => void) | undefined;
    const stopActiveCollaborativeTransport = (): void => {
      activeCollaborativeUnsubscribe?.();
      activeCollaborativeUnsubscribe = undefined;
      activeCollaborativeTransport?.close();
      activeCollaborativeTransport = undefined;
      activeCollaborativeItemId = null;
    };
    const startCollaborativeTransport = async (doc: WorkspaceDoc): Promise<void> => {
      if ((doc.kind !== "page" && doc.kind !== "table" && doc.kind !== "board") || doc.id === WELCOME_DOC_ID) {
        stopActiveCollaborativeTransport();
        return;
      }
      if (
        activeCollaborativeItemId === doc.id &&
        activeCollaborativeTransport &&
        isTransportUsable(activeCollaborativeTransport.readyState)
      ) return;
      stopActiveCollaborativeTransport();
      const join = await session.joinCollaborativeMarkdown(doc.id);
      const transport = createCollaborativeTransport(collaborativeTransportUrl(doc.id, join.ticket));
      activeCollaborativeItemId = doc.id;
      activeCollaborativeTransport = transport;
      const requestTransportRejoin = (): void => {
        if (active.id !== doc.id) return;
        void startCollaborativeTransport(active).catch(() => undefined);
      };
      if (doc.kind === "page") {
        const collaborator = getCollaboratorForDoc(doc);
        activeCollaborativeUnsubscribe = collaborator.onUpdate((_, origin) => {
          if (origin !== "local") return;
          saveCollaborativeSnapshot(collaborativeMarkdownSnapshotKey(workspaceId, doc.id), collaborator.encodeUpdate());
          safeSendCollaborativeUpdate(
            transport.readyState,
            () => {
              transport.sendUpdate(collaborator.encodeUpdate());
            },
            requestTransportRejoin,
          );
        });
          transport.onUpdate((update) => {
            const previousMarkdown = collaborator.getMarkdown();
            collaborator.applyRemoteUpdate(update);
            saveCollaborativeSnapshot(collaborativeMarkdownSnapshotKey(workspaceId, doc.id), collaborator.encodeUpdate());
            const nextMarkdown = collaborator.getMarkdown();
            syncMentionInboxFromMarkdown({
              previousMarkdown,
              nextMarkdown,
              docId: doc.id,
              docTitle: displayDocTitle(doc),
            });
          });
        safeSendCollaborativeUpdate(
          transport.readyState,
          () => {
            transport.sendUpdate(collaborator.encodeUpdate());
          },
          requestTransportRejoin,
        );
        return;
      }

      const collaborator = getStructuredCollaboratorForDoc(doc);
      activeCollaborativeUnsubscribe = collaborator.onUpdate((_, origin) => {
        if (origin !== "local") return;
        saveCollaborativeSnapshot(collaborativeMarkdownSnapshotKey(workspaceId, doc.id), collaborator.encodeUpdate());
        safeSendCollaborativeUpdate(
          transport.readyState,
          () => {
            transport.sendUpdate(collaborator.encodeUpdate());
          },
          requestTransportRejoin,
        );
      });
      transport.onUpdate((update) => {
        collaborator.applyRemoteUpdate(update);
        saveCollaborativeSnapshot(collaborativeMarkdownSnapshotKey(workspaceId, doc.id), collaborator.encodeUpdate());
        const nextContent = collaborator.getContent();
        updateDocById(doc.id, (currentDoc) => ({
          ...currentDoc,
          content: nextContent,
          updatedAt: new Date().toISOString(),
        }));
        if (active.id === doc.id) {
          renderStructuredSurface({
            ...active,
            content: nextContent,
          });
        }
      });
      safeSendCollaborativeUpdate(
        transport.readyState,
        () => {
          transport.sendUpdate(collaborator.encodeUpdate());
        },
        requestTransportRejoin,
      );
    };
    const stripAutoTitleHeading = (markdown: string, title: string): string => {
      const trimmedTitle = title.trim();
      if (!trimmedTitle || !markdown.startsWith("# ")) return markdown;
      const lines = markdown.split(/\r?\n/);
      if (lines.length === 0) return markdown;
      if (lines[0].trim() !== `# ${trimmedTitle}`) return markdown;
      const remainder = lines.slice(1);
      while (remainder.length > 0 && remainder[0].trim() === "") {
        remainder.shift();
      }
      return remainder.join("\n");
    };
    const normalizeLoadedDoc = (doc: WorkspaceDoc): WorkspaceDoc => {
      const normalized = normalizeLegacyWelcomeDoc(doc);
      if (
        normalized.kind !== doc.kind ||
        normalized.markdown !== doc.markdown ||
        normalized.title !== doc.title
      ) {
        removeCollaborativeSnapshot(doc.id);
      }
      if (normalized.kind === "page" && normalized.title.trim()) {
        const stripped = stripAutoTitleHeading(normalized.markdown, normalized.title);
        if (stripped !== normalized.markdown) {
          normalized.markdown = stripped;
          removeCollaborativeSnapshot(doc.id);
        }
      }
      return normalized;
    };
    if (active.kind !== "welcome") {
      const normalizedActive = normalizeLoadedDoc(active);
      const collaborator = getCollaboratorForDoc(normalizedActive);
      markDocHydrated(normalizedActive.id);
      active = {
        ...normalizedActive,
        markdown: collaborator.getMarkdown(),
      };
      workspace = {
        ...workspace,
        docs: workspace.docs.map((d) => (d.id === active.id ? active : d)),
        activeDocId: active.id,
      };
    }

    participantNickname = await ensureNickname();
    if (!participantNickname) participantNickname = "Guest";
    await upsertWorkspaceJoinedMembers(localStorageArea, workspaceId, [{
      displayName: participantNickname,
      userId: identity.userId,
      source: "local",
    }]);

    let inboxState: LocalInboxState = { notifications: [] };
    const inboxStatePromise = loadLocalInboxState(localStorageArea, workspaceId, identity.userId);
    let joinedMembers: WorkspaceJoinedMember[] = await loadWorkspaceJoinedMembers(localStorageArea, workspaceId);
    let peopleEntries: WorkspacePeopleEntry[] = mergeWorkspacePeople(joinedMembers, communityState.members);
    const mentionPicker = createMentionPicker({
      document,
      labels: {
        empty: t("mention.empty"),
      },
      onSelect: (candidate) => {
        if (!editor || active.kind !== "page" || active.id === WELCOME_DOC_ID) return;
        const token = encodeMentionToken({
          mentionId: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          userId: candidate.userId,
          displayName: candidate.displayName,
        });
        if (editor.replaceActiveMention(token)) {
          editor.focus();
          mentionPicker.close();
        }
      },
    });

    const workspaceMentionCandidates = () => peopleEntries
      .filter((member) => typeof member.userId === "string" && member.userId.trim())
      .map((member) => ({
        userId: member.userId as string,
        displayName: member.displayName,
      }));

    const updateMentionPicker = (queryState: { query: string; left: number; top: number; lineHeight: number } | null): void => {
      if (!queryState || active.kind !== "page" || active.id === WELCOME_DOC_ID) {
        mentionPicker.close();
        return;
      }
      mentionPicker.open(queryState, workspaceMentionCandidates());
    };

    const syncMentionInboxFromMarkdown = (params: {
      previousMarkdown: string;
      nextMarkdown: string;
      docId: string;
      docTitle: string;
    }): void => {
      const notifications = extractMentionNotifications({
        previousMarkdown: params.previousMarkdown,
        nextMarkdown: params.nextMarkdown,
        workspaceId,
        docId: params.docId,
        docTitle: params.docTitle,
        recipientUserId: identity.userId,
      });
      if (notifications.length === 0) return;
      void appendMentionNotificationsWithCooldown(
        localStorageArea,
        workspaceId,
        identity.userId,
        notifications,
      ).then((result) => {
        if (result.added.length === 0) return;
        inboxState = result.state;
        renderInboxPanel();
      }).catch(() => undefined);
    };

    const rebuildPeopleEntries = (): void => {
      peopleEntries = mergeWorkspacePeople(joinedMembers, communityState.members);
    };

    const refreshJoinedMembers = async (): Promise<void> => {
      try {
        const apiMembers = await loadWorkspaceJoinedMembersFromApi(session.client, workspaceId, password);
        if (apiMembers && apiMembers.length > 0) {
          joinedMembers = await upsertWorkspaceJoinedMembers(
            localStorageArea,
            workspaceId,
            apiMembers.map((member) => ({
              displayName: member.displayName,
              userId: member.userId,
              source: member.source,
              seenAt: member.lastSeenAt,
            })),
          );
        }
      } catch {
        joinedMembers = await loadWorkspaceJoinedMembers(localStorageArea, workspaceId);
      }
      rebuildPeopleEntries();
    };

    await refreshJoinedMembers();

    const renderPeoplePanel = (): void => {
      rebuildPeopleEntries();
      workspacePeopleCount.textContent = String(peopleEntries.length);
      workspacePeopleList.innerHTML = "";
      if (peopleEntries.length === 0) {
        const empty = document.createElement("p");
        empty.className = "workspace-people-empty";
        empty.textContent = t("sidebar.peopleEmpty");
        workspacePeopleList.appendChild(empty);
        return;
      }
      for (const member of peopleEntries) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "workspace-people-chip";
        chip.title = `@${member.displayName}`;
        chip.addEventListener("click", () => {
          void navigator.clipboard.writeText(`@${member.displayName}`).catch(() => undefined);
          saveStatus(saveStatusEl, t("status.copied"));
        });

        const avatar = document.createElement("span");
        avatar.className = "workspace-people-avatar";
        avatar.textContent = member.displayName.trim().slice(0, 1).toUpperCase() || "?";

        const body = document.createElement("span");
        body.className = "workspace-people-body";
        const name = document.createElement("span");
        name.className = "workspace-people-name";
        name.textContent = member.displayName;
        const note = document.createElement("span");
        note.className = "workspace-people-note";
        note.textContent = member.isOnline
          ? `${t("status.online")} · ${t("sidebar.peopleMention")}`
          : t("sidebar.peopleMention");
        body.appendChild(name);
        body.appendChild(note);

        chip.appendChild(avatar);
        chip.appendChild(body);
        workspacePeopleList.appendChild(chip);
      }
    };

    const renderInboxPanel = (): void => {
      const unreadCount = inboxState.notifications.filter((notification) => !notification.isRead).length;
      workspaceMessageDrawerCount.textContent = unreadCount === 1 ? "1 unread" : `${unreadCount} unread`;
      workspaceMessageUnreadBadge.hidden = unreadCount === 0;
      workspaceMessageUnreadBadge.textContent = String(unreadCount);
      renderPeoplePanel();

      workspaceMessageMembers.innerHTML = "";
      if (peopleEntries.length === 0) {
        const empty = document.createElement("p");
        empty.className = "workspace-message-empty";
        empty.textContent = t("drawer.message.membersEmpty");
        workspaceMessageMembers.appendChild(empty);
      } else {
        for (const member of peopleEntries) {
          const chip = document.createElement("div");
          chip.className = "workspace-message-member-chip";
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = member.isOnline ? `${member.displayName} · ${t("status.online")}` : member.displayName;
          button.addEventListener("click", () => {
            void navigator.clipboard.writeText(`@${member.displayName}`).catch(() => undefined);
          });
          chip.appendChild(button);
          workspaceMessageMembers.appendChild(chip);
        }
      }

      workspaceMessageLog.innerHTML = "";
      if (inboxState.notifications.length === 0) {
        const empty = document.createElement("p");
        empty.className = "workspace-message-empty";
        empty.textContent = t("drawer.message.empty");
        workspaceMessageLog.appendChild(empty);
      } else {
        for (const notification of inboxState.notifications) {
          const row = document.createElement("button");
            row.type = "button";
            row.className = `workspace-message-row workspace-inbox-row${notification.isRead ? "" : " is-unread"}`;
            row.addEventListener("click", () => {
              void (async () => {
                inboxState = await dismissLocalInboxNotification(
                  localStorageArea,
                  workspaceId,
                  identity.userId,
                  notification.id,
                );
                const targetDoc = workspace.docs.find((doc) => doc.id === notification.docId);
                if (targetDoc) {
                  switchActiveDoc(targetDoc);
                }
              renderInboxPanel();
              closeMessageDrawer();
            })();
          });

          const avatar = document.createElement("div");
          avatar.className = "workspace-message-avatar";
          avatar.textContent = notification.docTitle.trim().slice(0, 1).toUpperCase() || "!";
          const card = document.createElement("div");
          card.className = "workspace-message-card";
          const meta = document.createElement("div");
          meta.className = "workspace-message-meta";
          const title = document.createElement("span");
          title.className = "workspace-message-author";
          title.textContent = notification.docTitle;
          const timeEl = document.createElement("span");
          timeEl.textContent = new Date(notification.createdAt).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          });
          meta.appendChild(title);
          meta.appendChild(timeEl);
          const text = document.createElement("p");
          text.className = "workspace-message-text";
          text.textContent = notification.mentionText;
          card.appendChild(meta);
          card.appendChild(text);
          row.appendChild(avatar);
          row.appendChild(card);
          workspaceMessageLog.appendChild(row);
        }
      }
      workspaceMessageLog.scrollTop = workspaceMessageLog.scrollHeight;
    };
    void inboxStatePromise.then((state) => {
      inboxState = state;
      renderInboxPanel();
    });

    closeMessageDrawer = (): void => {
      const activeEl = document.activeElement as HTMLElement | null;
      if (activeEl && workspaceMessageDrawerRoot.contains(activeEl)) activeEl.blur();
      workspaceMessageDrawerRoot.classList.remove("is-open");
      workspaceMessageDrawerRoot.setAttribute("aria-hidden", "true");
      workspaceMessageDrawerOpenBtn.setAttribute("aria-expanded", "false");
    };

    const openMessageDrawer = (): void => {
      closeWorkspaceInfoDrawer();
      closeConnectAgentDialog();
      workspaceMessageDrawerRoot.classList.add("is-open");
      workspaceMessageDrawerRoot.setAttribute("aria-hidden", "false");
      workspaceMessageDrawerOpenBtn.setAttribute("aria-expanded", "true");
      void refreshJoinedMembers().then(() => renderInboxPanel()).catch(() => renderInboxPanel());
    };

    workspaceMessageDrawerCloseBtn.addEventListener("click", closeMessageDrawer);
    workspaceMessageDrawerBackdrop.addEventListener("click", closeMessageDrawer);
    workspaceMessageMarkReadBtn?.addEventListener("click", () => {
      void (async () => {
        inboxState = await markAllLocalInboxNotificationsRead(localStorageArea, workspaceId, identity.userId);
        renderInboxPanel();
      })();
    });
    workspaceMessageDrawerOpenBtn.addEventListener("click", () => {
      openMessageDrawer();
    });

    imageSync = await createWorkspaceImageSync({
      workspaceId,
      baseUrl: JUSTWORK_BACKEND_URL,
      joinRelay: () => session.joinRelay(),
      sessionId,
      displayName: participantNickname,
      userId: identity.userId,
      onAssetChanged: () => {
        syncEditorWithActive();
        renderAll();
      },
      onCommunityStateChange: (nextState) => {
        communityState = nextState;
        void upsertWorkspaceJoinedMembers(
          localStorageArea,
          workspaceId,
          nextState.members.map((member) => ({
            displayName: member.displayName,
            userId: member.userId ?? null,
            source: "presence",
            seenAt: member.joinedAt,
          })),
        ).then((nextJoinedMembers) => {
          joinedMembers = nextJoinedMembers;
          rebuildPeopleEntries();
          renderInboxPanel();
        }).catch(() => {
          renderInboxPanel();
        });
      },
    });
    console.debug("[mount] image sync ready", workspaceId);
    void imageSync.warmMarkdowns(workspace.docs.map((doc) => doc.markdown)).catch(() => undefined);
    console.debug("[mount] markdown warm complete", workspaceId);
    renderInboxPanel();

    const replaceDoc = (doc: WorkspaceDoc): void => {
      const normalized = normalizeLoadedDoc(doc);
      active = normalized;
      localCollaborativeDocCache.set(normalized.id, normalized);
      workspace = {
        ...workspace,
        docs: workspace.docs.some((d) => d.id === normalized.id)
          ? workspace.docs.map((d) => (d.id === normalized.id ? normalized : d))
          : [...workspace.docs, normalized],
        activeDocId: normalized.id,
      };
    };

    const isFolderCollapsed = (doc: WorkspaceDoc): boolean => (
      doc.kind === "folder" && collapsedFolderIds.has(doc.id)
    );

    const toggleFolderCollapsed = (doc: WorkspaceDoc): void => {
      if (doc.kind !== "folder") return;
      if (collapsedFolderIds.has(doc.id)) {
        collapsedFolderIds.delete(doc.id);
      } else {
        collapsedFolderIds.add(doc.id);
      }
      renderAll();
    };

    const updateDocById = (docId: string, update: (doc: WorkspaceDoc) => WorkspaceDoc): WorkspaceDoc | null => {
      const current = workspace.docs.find((doc) => doc.id === docId);
      if (!current) return null;
      const next = normalizeLoadedDoc(update(current));
      localCollaborativeDocCache.set(docId, next);
      markDocHydrated(docId);
      workspace = {
        ...workspace,
        docs: workspace.docs.map((doc) => (doc.id === docId ? next : doc)),
      };
      if (active.id === docId) {
        active = next;
      }
      return next;
    };

    const snapshotWorkspaceState = (): { workspace: WorkspaceDocsState; active: WorkspaceDoc } => ({
      workspace: {
        ...workspace,
        docs: workspace.docs.map((doc) => ({ ...doc })),
      },
      active: { ...active },
    });

    const restoreWorkspaceState = (snapshot: { workspace: WorkspaceDocsState; active: WorkspaceDoc }): void => {
      workspace = {
        ...snapshot.workspace,
        docs: snapshot.workspace.docs.map((doc) => normalizeLoadedDoc({ ...doc })),
      };
      active = workspace.docs.find((doc) => doc.id === snapshot.active.id) ?? normalizeLoadedDoc(snapshot.active);
    };

    const applyOptimisticTrash = (itemId: string): void => {
      const updatedAt = new Date().toISOString();
      workspace = applyOptimisticTrashState(workspace, itemId, updatedAt);
      for (const doc of workspace.docs) {
        localCollaborativeDocCache.set(doc.id, doc);
      }
      active = workspace.docs.find((doc) => doc.id === workspace.activeDocId) ?? active;
    };

    const isStructuredDoc = (doc: WorkspaceDoc): boolean => doc.kind === "table" || doc.kind === "board";

    const normalizedContentForDoc = (doc: WorkspaceDoc): WorkspaceDocContent | null => {
      if (doc.kind === "table") {
        const collaborator = collaborativeStructuredDocs.get(doc.id);
        return collaborator?.getContent() ?? normalizeStructuredDocumentContent("table", doc.content ?? createDefaultTableContent());
      }
      if (doc.kind === "board") {
        const collaborator = collaborativeStructuredDocs.get(doc.id);
        return collaborator?.getContent() ?? normalizeStructuredDocumentContent("board", doc.content ?? createDefaultBoardContent());
      }
      return null;
    };

    const folderChildren = (folderId: string): WorkspaceDoc[] => (
      workspace.docs
        .filter((doc) => doc.parentId === folderId && !doc.inTrash)
        .sort((left, right) => {
          if (left.kind === "folder" && right.kind !== "folder") return -1;
          if (left.kind !== "folder" && right.kind === "folder") return 1;
          return displayDocTitle(left).localeCompare(displayDocTitle(right), i18n.locale);
        })
    );

    const renderFolderSurface = (doc: WorkspaceDoc): void => {
      structuredSurfaceDocId = doc.id;
      structuredSurfaceKind = doc.kind;
      structuredHost.replaceChildren();
      const surface = document.createElement("section");
      surface.className = "folder-surface";

      const children = folderChildren(doc.id);
      if (children.length === 0) {
        const empty = document.createElement("p");
        empty.className = "folder-surface-empty";
        empty.textContent = i18n.locale === "zh-CN"
          ? "\u8FD9\u4E2A\u6587\u4EF6\u5939\u91CC\u8FD8\u6CA1\u6709\u5185\u5BB9\u3002"
          : "This folder is empty.";
        surface.appendChild(empty);
        structuredHost.appendChild(surface);
        return;
      }

      const list = document.createElement("div");
      list.className = "folder-surface-list";
      for (const child of children) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "folder-surface-item";
        row.addEventListener("click", () => {
          switchActiveDoc(child);
        });

        const icon = document.createElement("span");
        icon.className = "folder-surface-item-icon";
        icon.textContent = displayDocIcon(child) || "\u2192";
        icon.setAttribute("aria-hidden", "true");

        const body = document.createElement("span");
        body.className = "folder-surface-item-body";

        const title = document.createElement("span");
        title.className = "folder-surface-item-title";
        title.textContent = displayDocTitle(child);

        const meta = document.createElement("span");
        meta.className = "folder-surface-item-meta";
        meta.textContent = docKindLabel(child);

        body.append(title, meta);
        row.append(icon, body);
        list.appendChild(row);
      }

      surface.appendChild(list);
      structuredHost.appendChild(surface);
    };

    const renderStructuredLoadingSurface = (): void => {
      const surface = document.createElement("div");
      surface.className = "structured-surface structured-loading-surface";
      surface.textContent = t("status.loading");
      structuredHost.appendChild(surface);
    };

    const shouldRenderStructuredLoading = (doc: WorkspaceDoc): boolean => {
      if (!isStructuredDoc(doc)) return false;
      if (isCreatePendingDocId(doc.id)) return false;
      if (dirtyDocIds.has(doc.id)) return false;
      if (hydratedDocIds.has(doc.id)) return false;
      if (collaborativeStructuredDocs.has(doc.id)) return false;
      return doc.content == null;
    };

    const renderStructuredSurface = (doc: WorkspaceDoc): void => {
      if (doc.kind === "folder") {
        tableView?.destroy?.();
        boardView?.destroy?.();
        tableView = undefined;
        boardView = undefined;
        renderFolderSurface(doc);
        return;
      }
      if (shouldRenderStructuredLoading(doc)) {
        tableView?.destroy?.();
        boardView?.destroy?.();
        tableView = undefined;
        boardView = undefined;
        structuredSurfaceDocId = null;
        structuredSurfaceKind = null;
        structuredHost.replaceChildren();
        renderStructuredLoadingSurface();
        return;
      }
      if (doc.kind === "table") {
        const content = normalizedContentForDoc(doc) as TableDocumentContent;
        if (tableView && structuredSurfaceDocId === doc.id && structuredSurfaceKind === doc.kind) {
          tableView.update(content);
          return;
        }
        tableView?.destroy?.();
        boardView?.destroy?.();
        tableView = undefined;
        boardView = undefined;
        structuredHost.replaceChildren();
        const view = createTableView({
          document,
          content,
          labels: {
            addColumn: t("structured.table.addColumn"),
            addRow: t("structured.table.addRow"),
            deleteColumn: t("structured.table.deleteColumn"),
            deleteRow: t("structured.table.deleteRow"),
            freezeHeader: t("structured.table.freezeHeader"),
          },
          onChange: (nextContent) => {
            if (active.id !== doc.id) return;
            if (isCreatePendingDocId(doc.id) || isCreatePendingDocId(active.id)) {
              stageOptimisticCreatePatch(optimisticCreatePatches, doc.id, { content: nextContent });
              commitLocalEdit(doc.id, { content: nextContent });
              return;
            }
            const expectedRevision = active.revision;
            const collaborator = getStructuredCollaboratorForDoc(doc);
            collaborator.applyLocalContent(nextContent);
            saveCollaborativeSnapshot(collaborativeMarkdownSnapshotKey(workspaceId, doc.id), collaborator.encodeUpdate());
            const syncedContent = collaborator.getContent();
            commitLocalEdit(doc.id, { content: syncedContent });
            scheduleDocSave(doc.id, expectedRevision, { content: syncedContent }, active.title, "", "", 180);
          },
        });
        tableView = view;
        structuredSurfaceDocId = doc.id;
        structuredSurfaceKind = doc.kind;
        structuredHost.appendChild(view.element);
        return;
      }
      if (doc.kind === "board") {
        const content = normalizedContentForDoc(doc) as BoardDocumentContent;
        if (boardView && structuredSurfaceDocId === doc.id && structuredSurfaceKind === doc.kind) {
          boardView.update(content);
          return;
        }
        tableView?.destroy?.();
        boardView?.destroy?.();
        tableView = undefined;
        boardView = undefined;
        structuredHost.replaceChildren();
        const view = createBoardView({
          document,
          content,
          initialTemplateCollapsed: boardTemplateCollapsedState.get(doc.id) ?? false,
          onTemplateCollapsedChange: (collapsed) => {
            boardTemplateCollapsedState.set(doc.id, collapsed);
          },
          labels: {
            addColumn: t("structured.board.addColumn"),
            addCard: t("structured.board.addCard"),
            deleteColumn: t("structured.board.deleteColumn"),
            deleteCard: t("structured.board.deleteCard"),
            addField: t("structured.board.addField"),
            removeField: t("structured.board.removeField"),
            template: t("structured.board.template"),
            statuses: i18n.locale === "zh-CN"
              ? {
                  todo: "待开始",
                  doing: "进行中",
                  done: "已完成",
                  paused: "已暂停",
                }
              : {
                  todo: "To do",
                  doing: "In progress",
                  done: "Done",
                  paused: "Paused",
                },
          },
          onChange: (nextContent) => {
            if (active.id !== doc.id) return;
            if (isCreatePendingDocId(doc.id) || isCreatePendingDocId(active.id)) {
              stageOptimisticCreatePatch(optimisticCreatePatches, doc.id, { content: nextContent });
              commitLocalEdit(doc.id, { content: nextContent });
              return;
            }
            const expectedRevision = active.revision;
            const collaborator = getStructuredCollaboratorForDoc(doc);
            collaborator.applyLocalContent(nextContent);
            saveCollaborativeSnapshot(collaborativeMarkdownSnapshotKey(workspaceId, doc.id), collaborator.encodeUpdate());
            const syncedContent = collaborator.getContent();
            commitLocalEdit(doc.id, { content: syncedContent });
            scheduleDocSave(doc.id, expectedRevision, { content: syncedContent }, active.title, "", "", 180);
          },
        });
        boardView = view;
        structuredSurfaceDocId = doc.id;
        structuredSurfaceKind = doc.kind;
        structuredHost.appendChild(view.element);
      }
    };

    const removeDocById = (docId: string): void => {
      creatingDocIds.delete(docId);
      localCollaborativeDocCache.delete(docId);
      clearOptimisticCreatePatch(optimisticCreatePatches, docId);
      hydratedDocIds.delete(docId);
      boardTemplateCollapsedState.delete(docId);
      const nextDocs = workspace.docs.filter((doc) => doc.id !== docId);
      workspace = {
        ...workspace,
        docs: nextDocs,
        activeDocId: active.id === docId ? (nextDocs[0]?.id ?? WELCOME_DOC_ID) : workspace.activeDocId,
      };
      if (active.id === docId) {
        const fallback = nextDocs.find((doc) => doc.id === workspace.activeDocId) ?? nextDocs[0] ?? active;
        active = fallback;
        stopActiveCollaborativeTransport();
        bindEditorToActiveDoc();
      }
    };

    const bindEditorToActiveDoc = (): void => {
      if (!editor) return;
      if (isCreatePendingDocId(active.id)) {
        editor.bindCollaborator(undefined);
        stopActiveCollaborativeTransport();
        return;
      }
      if (active.kind === "table" || active.kind === "board") {
        editor.bindCollaborator(undefined);
        void startCollaborativeTransport(active).catch(() => undefined);
        return;
      }
      if (active.kind !== "page" || active.id === WELCOME_DOC_ID) {
        editor.bindCollaborator(undefined);
        stopActiveCollaborativeTransport();
        return;
      }
      const collaborator = getCollaboratorForDoc(active);
      void startCollaborativeTransport(active).catch(() => undefined);
      editor.bindCollaborator({
        collaborator,
        storageKey: collaborativeMarkdownSnapshotKey(workspaceId, active.id),
      });
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

    type SavePatchResult =
      | { status: "saved"; doc: WorkspaceDoc }
      | { status: "skipped" }
      | { status: "remote-newer"; doc: WorkspaceDoc };

    let saveQueue: Promise<void> = Promise.resolve();

    const savePatchWithConflictRetry = async (
      itemId: string,
      patch: OfflineMutationPatch,
      expectedRevision: number,
      localUpdatedAt: string | undefined,
    ): Promise<SavePatchResult> => {
      try {
        return {
          status: "saved",
          doc: await session.saveItem(itemId, {
            ...patch,
            expectedRevision,
          }),
        };
      } catch (e) {
        if (!(e instanceof BackendApiError) || e.code !== "conflict") {
          throw e;
        }
        const latest = await session.loadItem(itemId);
        if (shouldSkipDocSave(blockedDocSaveIds, itemId, latest)) {
          return { status: "skipped" };
        }
        if (!shouldRetryLocalPatchAfterConflict(localUpdatedAt, latest.updatedAt)) {
          return { status: "remote-newer", doc: latest };
        }
        return {
          status: "saved",
          doc: await session.saveItem(
            itemId,
            buildLocalFirstConflictRetryPatch(patch, latest.revision),
          ),
        };
      }
    };

    const commitLocalEdit = (itemId: string, patch: OfflineMutationPatch): void => {
      const currentDoc = workspace.docs.find((doc) => doc.id === itemId);
      const baseRevision = currentDoc?.revision ?? 0;
      dirtyDocIds.add(itemId);
      if (!isCreatePendingDocId(itemId)) {
        recordLocalEditOperation(itemId, baseRevision, patch);
      }
      if (isCreatePendingDocId(itemId)) {
        stageOptimisticCreatePatch(optimisticCreatePatches, itemId, patch);
      }
      const nextDoc = updateDocById(itemId, (doc) => ({
        ...doc,
        title: patch.title ?? doc.title,
        markdown: patch.markdown ?? doc.markdown,
        content: patch.content ?? doc.content ?? null,
        updatedAt: new Date().toISOString(),
      }));
      if (nextDoc && isCreatePendingDocId(itemId)) {
        updateLocalCreateOperationDoc(nextDoc);
      }
      if (patch.title !== undefined) {
        void upsertBackendDocDraft(workspaceId, itemId, patch, baseRevision).catch(() => undefined);
      } else if (patch.markdown !== undefined || patch.content !== undefined) {
        void upsertBackendDocDraft(workspaceId, itemId, patch, baseRevision).catch(() => undefined);
      }
      if (active.id === itemId) {
        if (patch.title !== undefined) {
          titleInput.value = patch.title;
        }
      }
    };

    const queueSaveRequest = (request: PendingSaveRequest): void => {
      if (isCreatePendingDocId(request.itemId)) {
        return;
      }
      saveQueue = saveQueue
        .then(async () => {
          const currentDoc = workspace.docs.find((doc) => doc.id === request.itemId);
          if (shouldSkipDocSave(blockedDocSaveIds, request.itemId, currentDoc)) {
            dirtyDocIds.delete(request.itemId);
            removeLocalEditOperations(request.itemId);
            return;
          }
          if (request.itemId === active.id) {
            saveStatus(saveStatusEl, t("status.saving"));
          }
          try {
            const liveRevision = currentDoc?.revision ?? request.expectedRevision;
            const saveResult = await savePatchWithConflictRetry(
              request.itemId,
              request.patch,
              liveRevision,
              currentDoc?.updatedAt,
            );
            if (saveResult.status === "skipped") {
              dirtyDocIds.delete(request.itemId);
              removeLocalEditOperations(request.itemId);
              return;
            }
            if (saveResult.status === "remote-newer") {
              dirtyDocIds.delete(request.itemId);
              removeLocalEditOperations(request.itemId);
              await removeBackendDocDraft(workspaceId, request.itemId, Number.MAX_SAFE_INTEGER);
              replaceDoc(saveResult.doc);
              if (request.itemId === active.id) {
                renderAll();
                saveStatus(saveStatusEl, t("status.synced"));
              }
              return;
            }
            const next = saveResult.doc;
            markDocHydrated(request.itemId);
            const draft = request.usesDraftQueue ? await getBackendDocDraft(workspaceId, request.itemId) : null;
            const hasNewerDraft = request.usesDraftQueue && draft !== null && draft.seq > request.seq;
            const liveDoc = localCollaborativeDocCache.get(request.itemId);
            const isStale = hasStaleCollaborativeSave(liveDoc, {
              nextTitle: request.nextTitle,
              nextMarkdown: request.nextMarkdown,
              content: request.patch.content,
            });
            const saveResolution = reconcileCollaborativeSave(liveDoc, isStale, hasNewerDraft);
            if (request.usesDraftQueue && !hasNewerDraft) {
              await removeBackendDocDraft(workspaceId, request.itemId, request.seq);
            }
            if (!request.usesDraftQueue && !saveResolution.shouldKeepDirty) {
              await removeBackendDocDraft(workspaceId, request.itemId, Number.MAX_SAFE_INTEGER);
            }
            if (!saveResolution.shouldKeepDirty) {
              dirtyDocIds.delete(request.itemId);
              removeLocalEditOperations(request.itemId);
            }

            updateDocById(request.itemId, (doc) => {
              return {
                ...doc,
                title: saveResolution.retainedTitle ?? (saveResolution.shouldKeepDirty ? doc.title : next.title),
                markdown: saveResolution.retainedMarkdown ?? (saveResolution.shouldKeepDirty ? doc.markdown : next.markdown),
                content: saveResolution.shouldKeepDirty
                  ? saveResolution.retainedContent
                  : (request.patch.content ?? next.content ?? doc.content ?? null),
                revision: next.revision,
                updatedAt: next.updatedAt,
              };
            });

            if (imageSync && request.patch.markdown !== undefined && saveResolution.shouldReseedSnapshot) {
              void imageSync.updateReferences(request.previousMarkdown, request.nextMarkdown).catch(() => undefined);
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

    async function hydrateDocWithLocalDraft(doc: WorkspaceDoc): Promise<WorkspaceDoc> {
      if (doc.id === WELCOME_DOC_ID || doc.id === ROOT_FOLDER_ID) return doc;
      const draft = await getBackendDocDraft(workspaceId, doc.id);
      if (!draft) return doc;
      return applyBackendDocDraft(doc, draft);
    }

    const persistRefreshTree = async (): Promise<void> => {
      treeData = await session.loadTree();
      const nextActiveId = treeData.items.some((item) => item.id === active.id && !item.in_trash)
        ? active.id
        : treeData.active_item_id;
      workspace = buildDocsStateFromTree(
        treeData.items,
        nextActiveId,
        formatWorkspaceTitle(treeData.workspace_title, workspace.workspaceTitle),
        workspace.workspaceDescription,
      );
      workspace = {
        ...workspace,
        docs: workspace.docs.map((doc) => normalizeLoadedDoc(doc)),
      };
      workspace = applyOfflineDeleteMutationsToDocs(
        workspace,
        (await loadOfflineDeleteMutations(localStorageArea)).filter((entry) => entry.workspaceId === workspaceId),
      );
      replayLocalOperationJournal();
      overlayDirtyDocsWithoutJournalEdits();
      const replayedActiveId = workspace.activeDocId;
      const summary = workspace.docs.find((d) => d.id === replayedActiveId && !d.inTrash)
        ?? workspace.docs.find((d) => !d.inTrash)
        ?? workspace.docs[0]!;
      const collaborator = summary.kind === "page" ? getCollaboratorForDoc(summary) : null;
      const local = localCollaborativeDocCache.get(summary.id) ?? null;
      const isComposingActivePage = summary.kind === "page" && summary.id === active.id && editor?.isComposing() === true;
      const shouldReloadPage = (
        summary.kind === "page" &&
        !isComposingActivePage &&
        !dirtyDocIds.has(summary.id) &&
        (!hydratedDocIds.has(summary.id) || (local?.revision ?? 0) < summary.revision)
      );
      const shouldReloadStructured = (
        (summary.kind === "table" || summary.kind === "board") &&
        !dirtyDocIds.has(summary.id) &&
        (!hydratedDocIds.has(summary.id) || (local?.revision ?? 0) < summary.revision)
      );
      const full = summary.kind === "welcome"
        ? { ...summary, markdown: buildLocalizedWelcomeMarkdown(workspace) }
        : (shouldReloadPage || shouldReloadStructured)
          ? await session.loadItem(summary.id)
          : hydratedDocIds.has(summary.id)
          ? (localCollaborativeDocCache.get(summary.id) ?? summary)
          : await session.loadItem(summary.id);
      if (summary.kind !== "welcome") {
        markDocHydrated(summary.id);
      }
      const hydrated = await hydrateDocWithLocalDraft(
        summary.kind === "welcome"
          ? full
          : full,
      );
      const shouldPreferLocal = Boolean(
        local && (
          isComposingActivePage ||
          dirtyDocIds.has(summary.id) ||
          (local.revision ?? 0) > (hydrated.revision ?? 0)
        ),
      );
      if (shouldPreferLocal && local) {
        replaceDoc({
          ...hydrated,
          title: local.title,
          markdown: local.kind === "page" ? (collaborator?.getMarkdown() ?? local.markdown) : hydrated.markdown,
          content: local.content ?? hydrated.content ?? null,
        });
      } else {
        if (summary.kind === "page" && collaborator && !isComposingActivePage && collaborator.getMarkdown() !== hydrated.markdown) {
          collaborator.applyLocalMarkdown(hydrated.markdown);
        }
        replaceDoc(hydrated);
      }
      if (summary.kind === "page") {
        void imageSync?.warmMarkdowns([shouldPreferLocal && local ? local.markdown : hydrated.markdown]).catch(() => undefined);
      }
      syncEditorWithActive();
      void pullQuota();
      void refreshJoinedMembers().then(() => renderInboxPanel()).catch(() => undefined);
    };

    const syncEditorWithActive = (): void => {
      const isActivePageComposing = active.kind === "page" && editor?.isComposing() === true;
      editorRoot.classList.toggle(
        "doc-editor-host--wide",
        active.kind === "table" || active.kind === "board" || active.kind === "folder",
      );
      titleInput.value = displayDocTitle(active);
      titleInput.readOnly = active.kind === "welcome" || active.id === ROOT_FOLDER_ID || active.kind === "folder";
      pageKindTag.textContent = docKindLabel(active);
      if (active.kind === "welcome") {
        mentionPicker.close();
        markdownHost.hidden = false;
        structuredHost.hidden = true;
        editor?.bindCollaborator(undefined);
        editor?.setMarkdown(buildLocalizedWelcomeMarkdown(workspace), true);
        return;
      }
      if (active.kind === "table" || active.kind === "board") {
        mentionPicker.close();
        markdownHost.hidden = true;
        structuredHost.hidden = false;
        editor?.bindCollaborator(undefined);
        renderStructuredSurface(active);
        return;
      }
      if (active.kind === "folder") {
        mentionPicker.close();
        markdownHost.hidden = true;
        structuredHost.hidden = false;
        editor?.bindCollaborator(undefined);
        renderStructuredSurface(active);
        return;
      }
      markdownHost.hidden = false;
      structuredHost.hidden = true;
      if (active.kind !== "page" || active.id === ROOT_FOLDER_ID) {
        mentionPicker.close();
        editor?.bindCollaborator(undefined);
        editor?.setMarkdown("", true);
        return;
      }
      bindEditorToActiveDoc();
      const currentMarkdown = editor?.getMarkdown() ?? "";
      const shouldPreserveFocusedEditorDrift = Boolean(
        !isActivePageComposing &&
        editor?.isFocused() &&
        currentMarkdown !== active.markdown,
      );
      if (shouldPreserveFocusedEditorDrift) {
        const collaborator = collaborativeMarkdownDocs.get(active.id);
        if (collaborator && collaborator.getMarkdown() !== currentMarkdown) {
          collaborator.applyLocalMarkdown(currentMarkdown);
          saveCollaborativeSnapshot(
            collaborativeMarkdownSnapshotKey(workspaceId, active.id),
            collaborator.encodeUpdate(),
          );
        } else if (currentMarkdown !== active.markdown) {
          commitLocalEdit(active.id, { markdown: currentMarkdown });
          scheduleDocSave(
            active.id,
            active.revision,
            { markdown: currentMarkdown },
            active.title,
            active.markdown,
            currentMarkdown,
            240,
          );
        }
        return;
      }
      const shouldResync = !isActivePageComposing && editor && shouldResyncEditorMarkdown(currentMarkdown, active.markdown);
      if (shouldResync && editor) {
        editor.setMarkdown(active.markdown, true);
      }
    };

    const renderAll = (): void => {
      const q = searchInput.value;
      const alive = workspace.docs.filter((d) => !d.inTrash);
      const pinned = alive.filter((d) => d.pinned);
      const treeSource = alive;
      const tree = flattenTree(treeSource, ROOT_FOLDER_ID, q.trim() ? new Set<string>() : collapsedFolderIds);
      const trash = workspace.docs.filter((d) => d.inTrash);

      renderDocRows(pinnedList, pinned, { search: q });
      renderDocRows(docTree, tree, { search: q });
      renderDocRows(trashList, trash, { showTrashActions: true, search: q });
      titleInput.value = displayDocTitle(active);
      titleInput.readOnly = active.kind === "welcome" || active.id === ROOT_FOLDER_ID || active.kind === "folder";
      pageKindTag.textContent = docKindLabel(active);
      setSidebarActionLabel(pinBtn, active.pinned ? t("sidebar.unpin") : t("sidebar.pin"));
      pinBtn.disabled = active.kind === "welcome" || active.id === ROOT_FOLDER_ID || active.inTrash;
      pinBtn.title = pinBtn.disabled ? t("doc.protected") : t("sidebar.pin");
      shareBtn.disabled = active.kind === "welcome" || active.kind === "folder" || active.inTrash;
      shareBtn.title = shareBtn.disabled ? t("doc.protected") : t("sidebar.share");
      deleteBtn.disabled = active.kind === "welcome" || active.id === ROOT_FOLDER_ID || active.inTrash;
      deleteBtn.title = deleteBtn.disabled ? t("doc.protected") : t("doc.trash");
    };

    const applyLocalPatch = (itemId: string, patch: OfflineMutationPatch): void => {
      const current = workspace.docs.find((d) => d.id === itemId);
      if (!current) return;
      const next = {
        ...current,
        title: patch.title ?? current.title,
        markdown: patch.markdown ?? current.markdown,
        content: patch.content ?? current.content ?? null,
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
      await enqueueOfflineMutation(localStorageArea, {
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
      if (patch.markdown !== undefined) {
        await imageSync?.updateReferences(previousMarkdown, nextMarkdown).catch(() => undefined);
      }
      setHealthStatus(backendHealthStatus, "offline", t("status.offline"));
      saveStatus(saveStatusEl, t("status.offlinePending"));
    };

    const queueOfflineDeleteAction = async (
      itemId: string,
      kind: OfflineDeleteMutationKind,
    ): Promise<void> => {
      await enqueueOfflineDeleteMutation(localStorageArea, {
        id: mutationId(),
        workspaceId,
        itemId,
        kind,
        createdAt: new Date().toISOString(),
      });
      setHealthStatus(backendHealthStatus, "offline", t("status.offline"));
      saveStatus(saveStatusEl, t("status.offlinePending"));
    };

    flushOfflineMutations = async (): Promise<void> => {
      const pendingDeleteMutations = (await loadOfflineDeleteMutations(localStorageArea))
        .filter((entry) => entry.workspaceId === workspaceId);
      for (const mutation of pendingDeleteMutations) {
        try {
          if (mutation.kind !== "restore") {
            blockDocSavesForItem(mutation.itemId);
            await waitForPendingDocSavesToSettle(saveQueue);
          }
          if (mutation.kind === "trash") {
            await session.trashItem(mutation.itemId);
          } else if (mutation.kind === "restore") {
            await session.restoreItem(mutation.itemId);
          } else {
            await session.hardDeleteItem(mutation.itemId);
          }
          await removeOfflineDeleteMutation(localStorageArea, mutation.id);
        } catch (e) {
          if (e instanceof BackendApiError && e.code === "not_found") {
            await removeOfflineDeleteMutation(localStorageArea, mutation.id);
            continue;
          }
          if (shouldQueueAsOfflinePending(e)) {
            setHealthStatus(backendHealthStatus, "offline", t("status.offline"));
            saveStatus(saveStatusEl, t("status.offlinePending"));
            return;
          }
          notifyError(e);
          return;
        }
      }

      const pending = (await loadOfflineMutations(localStorageArea)).filter((entry) => entry.workspaceId === workspaceId);
      if (pending.length === 0) {
        if (pendingDeleteMutations.length > 0) {
          scheduleTreeRefresh();
          renderAll();
          saveStatus(saveStatusEl, t("status.synced"));
        }
        return;
      }
      const revisionByItem = new Map<string, number>();
      for (const doc of workspace.docs) {
        revisionByItem.set(doc.id, doc.revision);
      }

      for (const mutation of pending) {
        try {
          const currentDoc = workspace.docs.find((doc) => doc.id === mutation.itemId);
          if (shouldSkipDocSave(blockedDocSaveIds, mutation.itemId, currentDoc)) {
            await removeOfflineMutation(localStorageArea, mutation.id);
            continue;
          }
          const expectedRevision = revisionByItem.get(mutation.itemId) ?? mutation.expectedRevision;
          const saveResult = await savePatchWithConflictRetry(
            mutation.itemId,
            mutation.patch,
            expectedRevision,
            currentDoc?.updatedAt ?? mutation.createdAt,
          );
          if (saveResult.status === "skipped") {
            await removeOfflineMutation(localStorageArea, mutation.id);
            continue;
          }
          if (saveResult.status === "remote-newer") {
            revisionByItem.set(mutation.itemId, saveResult.doc.revision);
            updateDocById(mutation.itemId, (doc) => ({
              ...doc,
              title: saveResult.doc.title,
              markdown: saveResult.doc.markdown,
              content: saveResult.doc.content ?? doc.content ?? null,
              revision: saveResult.doc.revision,
              updatedAt: saveResult.doc.updatedAt,
            }));
            await removeOfflineMutation(localStorageArea, mutation.id);
            continue;
          }
          const saved = saveResult.doc;
          revisionByItem.set(mutation.itemId, saved.revision);
          updateDocById(mutation.itemId, (doc) => ({
            ...doc,
            title: saved.title,
            markdown: saved.markdown,
            content: saved.content ?? doc.content ?? null,
            revision: saved.revision,
            updatedAt: saved.updatedAt,
          }));
          await removeOfflineMutation(localStorageArea, mutation.id);
        } catch (e) {
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
      saveStatus(saveStatusEl, t("status.synced"));
    };

    const hydrateStructuredDocInPlace = (doc: WorkspaceDoc, cached: WorkspaceDoc): void => {
      void (async () => {
        const needsRemoteLoad = !dirtyDocIds.has(doc.id) && (
          !hydratedDocIds.has(doc.id) || (cached.revision ?? 0) < (doc.revision ?? 0) || cached.content == null
        );
        const full = needsRemoteLoad
          ? await session.loadItem(doc.id)
          : (localCollaborativeDocCache.get(doc.id) ?? cached);
        markDocHydrated(doc.id);
        const normalizedContent = normalizedContentForDoc(full);
        updateDocById(doc.id, (current) => ({
          ...current,
          title: full.title,
          revision: full.revision,
          updatedAt: full.updatedAt,
          content: normalizedContent,
        }));
        if (active.id === doc.id) {
          active = {
            ...active,
            title: full.title,
            revision: full.revision,
            updatedAt: full.updatedAt,
            content: normalizedContent,
          };
          syncEditorWithActive();
          renderAll();
        }
      })().catch((error) => notifyError(error));
    };

    const switchActiveDoc = (doc: WorkspaceDoc): void => {
      if (active.id !== doc.id) {
        flushPendingDocSave(active.id);
      }
      if (doc.kind === "welcome") {
        const next = { ...doc, markdown: buildLocalizedWelcomeMarkdown(workspace) };
        replaceDoc(next);
        syncEditorWithActive();
        renderAll();
        return;
      }

      if (isStructuredDoc(doc) || doc.kind === "folder") {
        const cached = localCollaborativeDocCache.get(doc.id) ?? workspace.docs.find((item) => item.id === doc.id) ?? doc;
        replaceDoc(cached);
        stopActiveCollaborativeTransport();
        syncEditorWithActive();
        renderAll();
        if (doc.kind === "folder") return;
        hydrateStructuredDocInPlace(doc, cached);
        return;
      }

      const cached = localCollaborativeDocCache.get(doc.id) ?? workspace.docs.find((item) => item.id === doc.id) ?? doc;
      const collaborator = getCollaboratorForDoc(normalizeLoadedDoc(cached));
      const initialMarkdown = collaborator.getMarkdown();
      replaceDoc({
        ...cached,
        markdown: initialMarkdown,
      });
      bindEditorToActiveDoc();
      if (editor && shouldResyncEditorMarkdown(editor.getMarkdown(), initialMarkdown)) {
        editor.setMarkdown(initialMarkdown, true);
      }
      syncEditorWithActive();
      renderAll();

      void (async () => {
        const full = hydratedDocIds.has(doc.id)
          ? (localCollaborativeDocCache.get(doc.id) ?? cached)
          : await session.loadItem(doc.id);
        markDocHydrated(doc.id);
        const hydrated = normalizeLoadedDoc(await hydrateDocWithLocalDraft(full));
        const collaborator = getCollaboratorForDoc(doc);
        const hydratedMarkdown = hydrated.markdown;
        const isActiveDocComposing = active.id === doc.id && editor?.isComposing() === true;
        if (!dirtyDocIds.has(doc.id) && !isActiveDocComposing) {
          if (collaborator.getMarkdown() !== hydratedMarkdown) {
            collaborator.applyLocalMarkdown(hydratedMarkdown);
          }
          updateDocById(doc.id, (current) => ({
            ...current,
            title: hydrated.title,
            revision: hydrated.revision,
            updatedAt: hydrated.updatedAt,
            markdown: hydratedMarkdown,
          }));
        }
        if (active.id === doc.id && !dirtyDocIds.has(doc.id) && !isActiveDocComposing) {
          active = {
            ...active,
            title: hydrated.title,
            revision: hydrated.revision,
            updatedAt: hydrated.updatedAt,
            markdown: hydratedMarkdown,
          };
          if (editor && shouldResyncEditorMarkdown(editor.getMarkdown(), hydratedMarkdown)) {
            editor.setMarkdown(hydratedMarkdown, true);
          }
          syncEditorWithActive();
          renderAll();
        }
        void imageSync?.warmMarkdowns([collaborator.getMarkdown()]).catch(() => undefined);
      })();
    };

    const onDropToFolder = (targetFolderId: string | null, draggedId: string) => {
      void (async () => {
        const previous = workspace.docs.find((doc) => doc.id === draggedId);
        if (!previous) return;
        const optimisticUpdatedAt = new Date().toISOString();
        workspace = applyOptimisticMove(workspace, draggedId, targetFolderId, optimisticUpdatedAt);
        const optimistic = workspace.docs.find((doc) => doc.id === draggedId);
        if (!optimistic) return;
        localCollaborativeDocCache.set(draggedId, optimistic);
        if (active.id === draggedId) {
          active = optimistic;
        }
        renderAll();
        try {
          replaceDoc(await session.moveItem(draggedId, targetFolderId));
          markDocHydrated(draggedId);
          renderAll();
          scheduleTreeRefresh();
          saveStatus(saveStatusEl, t("doc.moved"));
        } catch (e) {
          replaceDoc(previous);
          renderAll();
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
        const hasChildren = doc.kind === "folder" && workspace.docs.some((child) => (
          child.parentId === doc.id && !child.inTrash
        ));
        const collapsed = isFolderCollapsed(doc);
        if (doc.kind === "folder") {
          btn.classList.add(collapsed ? "is-collapsed" : "is-expanded");
          btn.setAttribute("aria-expanded", String(!collapsed));
        }
        const disclosure = document.createElement("span");
        disclosure.className = "doc-list-item-disclosure";
        disclosure.setAttribute("aria-hidden", "true");
        disclosure.textContent = "";
        disclosure.classList.add("is-empty");
        const icon = document.createElement("span");
        icon.className = "doc-list-item-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = displayDocIcon(doc);
        if (!icon.textContent) {
          icon.classList.add("is-empty");
        }
        const label = document.createElement("span");
        label.className = "doc-list-item-label";
        label.textContent = displayDocTitle(doc);
        btn.replaceChildren(disclosure, icon, label);
        btn.style.paddingLeft = `${8 + (depthMap.get(doc.id) ?? 0) * 14}px`;
        if (doc.id === ROOT_FOLDER_ID) {
          btn.classList.add("doc-root");
        }
        if (doc.id === active.id) btn.classList.add("active");
        btn.addEventListener("click", () => {
          if (!opts.showTrashActions && doc.kind === "folder") {
            toggleFolderCollapsed(doc);
          }
          switchActiveDoc(doc);
        });

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
              const previous = workspace.docs.find((current) => current.id === doc.id) ?? doc;
              const optimistic = {
                ...previous,
                updatedAt: new Date().toISOString(),
              };
              workspace = applyOptimisticRestoreState(workspace, doc.id, optimistic.updatedAt);
              const restored = workspace.docs.find((current) => current.id === doc.id);
              if (!restored) return;
              localCollaborativeDocCache.set(doc.id, restored);
              if (active.id === doc.id) {
                active = restored;
              }
              const localOperationId = recordLocalDeleteOperation(doc.id, "restore");
              renderAll();
              try {
                releaseDocSaveBlocksForItem(doc.id);
                replaceDoc(await session.restoreItem(doc.id));
                markDocHydrated(doc.id);
                renderAll();
                scheduleTreeRefresh();
                saveStatus(saveStatusEl, t("doc.restored"));
              } catch (err) {
                if (shouldQueueAsOfflinePending(err)) {
                  await queueOfflineDeleteAction(doc.id, "restore");
                  removeLocalOperation(localOperationId);
                  return;
                }
                removeLocalOperation(localOperationId);
                blockDocSavesForItem(doc.id);
                replaceDoc(previous);
                renderAll();
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
              const localOperationId = recordLocalDeleteOperation(doc.id, "hard-delete");
              try {
                const full = workspace.docs.find((current) => current.id === doc.id) ?? doc;
                blockDocSavesForItem(doc.id);
                removeDocById(doc.id);
                syncEditorWithActive();
                renderAll();
                await waitForPendingDocSavesToSettle(saveQueue);
                await session.hardDeleteItem(doc.id);
                if (imageSync) {
                  await imageSync.updateReferences(full.markdown ?? "", "").catch(() => undefined);
                }
                removeCollaborativeSnapshot(collaborativeMarkdownSnapshotKey(workspaceId, doc.id));
                scheduleTreeRefresh();
                saveStatus(saveStatusEl, t("doc.hardDeleted"));
              } catch (err) {
                if (shouldQueueAsOfflinePending(err)) {
                  removeCollaborativeSnapshot(collaborativeMarkdownSnapshotKey(workspaceId, doc.id));
                  await queueOfflineDeleteAction(doc.id, "hard-delete");
                  removeLocalOperation(localOperationId);
                  return;
                }
                removeLocalOperation(localOperationId);
                replaceDoc(doc);
                releaseDocSaveBlocksForItem(doc.id);
                syncEditorWithActive();
                renderAll();
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
              const snapshot = snapshotWorkspaceState();
              const localOperationId = recordLocalDeleteOperation(doc.id, "trash");
              try {
                blockDocSavesForItem(doc.id);
                applyOptimisticTrash(doc.id);
                syncEditorWithActive();
                renderAll();
                await waitForPendingDocSavesToSettle(saveQueue);
                const trashed = await session.trashItem(doc.id);
                updateDocById(doc.id, () => trashed);
                markDocHydrated(doc.id);
                renderAll();
                scheduleTreeRefresh();
                saveStatus(saveStatusEl, t("doc.trashed"));
              } catch (err) {
                if (shouldQueueAsOfflinePending(err)) {
                  await queueOfflineDeleteAction(doc.id, "trash");
                  removeLocalOperation(localOperationId);
                  return;
                }
                removeLocalOperation(localOperationId);
                restoreWorkspaceState(snapshot);
                releaseDocSaveBlocksForItem(doc.id);
                syncEditorWithActive();
                renderAll();
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
    const blockedDocSaveIds = new Set<string>();

    const collectAffectedDocIds = (itemId: string): string[] => {
      const affected = new Set<string>([itemId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const doc of workspace.docs) {
          if (!doc.parentId || affected.has(doc.id) || !affected.has(doc.parentId)) continue;
          affected.add(doc.id);
          changed = true;
        }
      }
      return [...affected];
    };

    const blockDocSavesForItem = (itemId: string): void => {
      for (const affectedId of collectAffectedDocIds(itemId)) {
        discardPendingDocSave(pendingDocSaves, blockedDocSaveIds, affectedId, (timer) => window.clearTimeout(timer));
        dirtyDocIds.delete(affectedId);
        removeLocalEditOperations(affectedId);
        localCollaborativeDocCache.delete(affectedId);
        void removeBackendDocDraft(workspaceId, affectedId, Number.MAX_SAFE_INTEGER).catch(() => undefined);
      }
    };

    const releaseDocSaveBlock = (itemId: string): void => {
      releasePendingDocSaveBlock(blockedDocSaveIds, itemId);
    };

    const releaseDocSaveBlocksForItem = (itemId: string): void => {
      for (const affectedId of collectAffectedDocIds(itemId)) {
        releaseDocSaveBlock(affectedId);
      }
    };

    const scheduleDocSave = (
      itemId: string,
      expectedRevision: number,
      patch: OfflineMutationPatch,
      nextTitle: string,
      previousMarkdown: string,
      nextMarkdown: string,
      delayMs: number,
    ): void => {
      if (isCreatePendingDocId(itemId)) {
        return;
      }
      const currentDoc = workspace.docs.find((doc) => doc.id === itemId);
      if (shouldSkipDocSave(blockedDocSaveIds, itemId, currentDoc)) {
        return;
      }
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
          if (draftPatch.content !== undefined) {
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
          const draft = await upsertBackendDocDraft(workspaceId, itemId, draftPatch, current.expectedRevision);
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

    const flushPendingDocSave = (itemId: string): void => {
      const current = pendingDocSaves.get(itemId);
      if (!current) return;
      if (current.timer !== undefined) {
        window.clearTimeout(current.timer);
      }
      pendingDocSaves.delete(itemId);
      void (async () => {
        const draftPatch = current.patch;
        if (draftPatch.content !== undefined) {
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
        const draft = await upsertBackendDocDraft(workspaceId, itemId, draftPatch, current.expectedRevision);
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
    };

    editor = createWysiwygEditor({
      container: markdownHost,
      initialMarkdown: active.kind === "welcome" ? buildLocalizedWelcomeMarkdown(workspace) : active.kind === "page" ? active.markdown : "",
      collaboratorBinding:
        active.kind === "page" && active.id !== WELCOME_DOC_ID
          ? {
              collaborator: getCollaboratorForDoc(active),
              storageKey: collaborativeMarkdownSnapshotKey(workspaceId, active.id),
            }
          : undefined,
      onMentionQueryChange: updateMentionPicker,
      onChange: (markdown) => {
        if (active.kind !== "page" || active.id === WELCOME_DOC_ID) return;
        const itemId = active.id;
        const persistencePlan = planPageEditPersistence(collaborativeMarkdownDocs.has(itemId));
        const previousMarkdown = localCollaborativeDocCache.get(itemId)?.markdown
          ?? workspace.docs.find((doc) => doc.id === itemId)?.markdown
          ?? "";
        syncMentionInboxFromMarkdown({
          previousMarkdown,
          nextMarkdown: markdown,
          docId: itemId,
          docTitle: displayDocTitle(active),
        });
        if (collaborativeMarkdownDocs.has(itemId)) {
          const nextMarkdown = markdown;
          const nextDoc = updateDocById(itemId, (doc) => ({
            ...doc,
            markdown: nextMarkdown,
            updatedAt: new Date().toISOString(),
          }));
          if (nextDoc) {
            localCollaborativeDocCache.set(itemId, nextDoc);
          }
          void imageSync?.updateReferences(previousMarkdown, nextMarkdown).catch(() => undefined);
        }
        const expectedRevision = active.revision;
        if (persistencePlan.commitLocalEdit) {
          commitLocalEdit(itemId, { markdown });
        }
        if (persistencePlan.scheduleSave) {
          scheduleDocSave(itemId, expectedRevision, { markdown }, active.title, previousMarkdown, markdown, 240);
        }
      },
      imageSync: imageSync.editorSync,
    });
    markdownHost.addEventListener("keydown", (event) => {
      if (mentionPicker.handleKeyDown(event)) {
        event.stopPropagation();
      }
    }, true);
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
      if (active.kind === "welcome" || active.id === ROOT_FOLDER_ID || active.kind === "folder") return;
      const itemId = active.id;
      const expectedRevision = active.revision;
      const title = normalizeDocTitleInput(titleInput.value, defaultTitleForKind(active.kind));
      const currentMarkdown = workspace.docs.find((doc) => doc.id === itemId)?.markdown ?? "";
      commitLocalEdit(itemId, { title });
      renderAll();
      scheduleDocSave(itemId, expectedRevision, { title }, title, currentMarkdown, currentMarkdown, 400);
    });
    searchInput.addEventListener("input", () => renderAll());

    const refreshWorkspaceInfoPanel = async (): Promise<void> => {
      workspaceInfoIdEl.textContent = workspaceId;
      workspaceInfoUserIdEl.textContent = identity.userId;
      workspaceInfoUserIdEl.title = identity.userId;
      workspaceInfoProfileStatus.textContent = "";
      workspaceInfoWorkspaceNameStatus.textContent = "";
      workspaceInfoWorkspaceNameInput.disabled = false;
      workspaceInfoSaveWorkspaceNameBtn.disabled = false;
      workspaceInfoWorkspaceNameInput.value = workspace.workspaceTitle.trim();
      try {
        await refreshJoinedMembers();
        const serverMembers = await session.listMembers().catch(() => []);
        const currentMember = serverMembers.find((member) => member.user_id === identity.userId);
        workspaceInfoNicknameInput.value = participantNickname || currentMember?.nickname || "";
        workspaceInfoProfileStatus.textContent = t("drawer.profile.currentNickname", {
          nickname: workspaceInfoNicknameInput.value.trim() || currentMember?.nickname || "",
        });
      } catch {
        workspaceInfoProfileStatus.textContent = t("drawer.profile.loadingNicknameFailed");
      }
    };

    rerenderActiveWorkbench = renderAll;
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

    closeConnectAgentDialog = (): void => {
      const activeEl = document.activeElement as HTMLElement | null;
      if (activeEl && connectAgentDialogRoot.contains(activeEl)) activeEl.blur();
      connectAgentDialogRoot.classList.remove("is-open");
      connectAgentDialogRoot.setAttribute("aria-hidden", "true");
      connectAgentBtn.setAttribute("aria-expanded", "false");
    };

    const openConnectAgentDialog = (): void => {
      closeWorkspaceInfoDrawer();
      closeMessageDrawer();
      const browserSkillUrl = getRuntimeUrl("agent/SKILL.md");
      const backendSkillUrl = new URL("/agent/SKILL.md", JUSTWORK_BACKEND_URL).toString();
      connectAgentPromptText.value = buildConnectAgentPrompt(workspaceId, password, rememberWorkspacePassword);
      connectAgentDownloadSkillLink.href = browserSkillUrl;
      connectAgentBackendSkillLink.href = backendSkillUrl;
      connectAgentDialogRoot.classList.add("is-open");
      connectAgentDialogRoot.setAttribute("aria-hidden", "false");
      connectAgentBtn.setAttribute("aria-expanded", "true");
      connectAgentPromptText.focus();
      connectAgentPromptText.select();
    };

    connectAgentDialogCloseBtn.addEventListener("click", closeConnectAgentDialog);
    connectAgentDialogBackdrop.addEventListener("click", closeConnectAgentDialog);
    connectAgentBtn.addEventListener("click", openConnectAgentDialog);
    connectAgentCopyBtn.addEventListener("click", () => void copyViaClipboard(connectAgentPromptText.value));

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
          const nextNickname = workspaceInfoNicknameInput.value.trim();
          if (!nextNickname) {
            workspaceInfoProfileStatus.textContent = "";
            workspaceInfoNicknameInput.focus();
            return;
          }
          participantNickname = nextNickname;
          await setWorkspaceNickname(workspaceId, identity.userId, nextNickname);
          try {
            await session.updateProfile(nextNickname);
          } catch {
            // The local nickname is the source of truth for presence and inbox mentions.
          }
          imageSync?.announcePresence(nextNickname);
          communityState = {
            ...communityState,
            members: [
              ...communityState.members.filter((member) => member.sessionId !== sessionId),
              {
                sessionId,
                displayName: nextNickname,
                userId: identity.userId,
                joinedAt:
                  communityState.members.find((member) => member.sessionId === sessionId)?.joinedAt ??
                  new Date().toISOString(),
              },
            ],
          };
          joinedMembers = await upsertWorkspaceJoinedMembers(localStorageArea, workspaceId, [{
            displayName: nextNickname,
            userId: identity.userId,
            source: "profile",
          }]);
          rebuildPeopleEntries();
          renderInboxPanel();
          workspaceInfoProfileStatus.textContent = t("drawer.profile.savedNickname");
          saveStatus(saveStatusEl, t("drawer.profile.savedNickname"));
        } catch (e) {
          workspaceInfoProfileStatus.textContent = "";
          notifyError(e);
        }
      })();
    });

    workspaceInfoSaveWorkspaceNameBtn.addEventListener("click", () => {
      void (async () => {
        const nextTitle = workspaceInfoWorkspaceNameInput.value.trim();
        workspaceInfoWorkspaceNameStatus.textContent = t("drawer.profile.saveInProgress");
        try {
          const savedTitle = await session.updateWorkspaceTitle(nextTitle);
          workspace = {
            ...workspace,
            workspaceTitle: savedTitle,
          };
          scheduleTreeRefresh();
          renderAll();
          const nextLabel = savedTitle;
          await touchRecentWorkspaceEntry(workspaceId, nextLabel);
          void renderGateRecents();
          workspaceInfoWorkspaceNameInput.value = nextLabel;
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

    const createOptimisticDoc = (kind: BackendWorkspaceItemKind, title: string, parentId: string | null): WorkspaceDoc => {
      const now = new Date().toISOString();
      const content = kind === "table"
        ? normalizeStructuredDocumentContent("table", createDefaultTableContent())
        : kind === "board"
          ? normalizeStructuredDocumentContent("board", createDefaultBoardContent())
          : null;
      return {
        id: createClientDocId(),
        kind,
        title,
        markdown: "",
        content,
        revision: 0,
        updatedAt: now,
        lastVisitedAt: now,
        parentId,
        pinned: false,
        inTrash: false,
      };
    };

    const insertOptimisticDoc = (doc: WorkspaceDoc): void => {
      creatingDocIds.add(doc.id);
      active = doc;
      localCollaborativeDocCache.set(doc.id, doc);
      workspace = {
        ...workspace,
        docs: [...workspace.docs, doc],
        activeDocId: doc.id,
      };
    };

    const replaceOptimisticDoc = (optimisticId: string, created: WorkspaceDoc): void => {
      creatingDocIds.delete(optimisticId);
      dirtyDocIds.delete(optimisticId);
      localCollaborativeDocCache.delete(optimisticId);
      hydratedDocIds.delete(optimisticId);
      localCollaborativeDocCache.set(created.id, created);
      const hasOptimisticDoc = workspace.docs.some((doc) => doc.id === optimisticId);
      workspace = {
        ...workspace,
        docs: hasOptimisticDoc
          ? workspace.docs.map((doc) => (doc.id === optimisticId ? created : doc))
          : [...workspace.docs, created],
        activeDocId: workspace.activeDocId === optimisticId ? created.id : workspace.activeDocId,
      };
      if (active.id === optimisticId) {
        active = created;
      }
    };

    const rollbackOptimisticDoc = (optimisticId: string, previousActive: WorkspaceDoc): void => {
      creatingDocIds.delete(optimisticId);
      dirtyDocIds.delete(optimisticId);
      clearOptimisticCreatePatch(optimisticCreatePatches, optimisticId);
      localCollaborativeDocCache.delete(optimisticId);
      hydratedDocIds.delete(optimisticId);
      workspace = {
        ...workspace,
        docs: workspace.docs.filter((doc) => doc.id !== optimisticId),
        activeDocId: previousActive.id,
      };
      active = workspace.docs.find((doc) => doc.id === previousActive.id) ?? previousActive;
    };

    const createAndOpen = async (kind: BackendWorkspaceItemKind, title: string): Promise<void> => {
      const parentId = currentParentId();
      const previousActive = active;
      const optimistic = createOptimisticDoc(kind, title, parentId);
      const localCreateOperationId = recordLocalCreateOperation(optimistic);
      insertOptimisticDoc(optimistic);
      syncEditorWithActive();
      renderAll();
      saveStatus(saveStatusEl, i18n.locale === "zh-CN" ? "?????" : "Creating?");
      try {
        const created = await session.createItem(kind, title, parentId, optimistic.id);
        markDocHydrated(created.id);
        if (created.kind === "page") {
          const promoted = promoteOptimisticCreateDoc(optimisticCreatePatches, optimistic.id, created);
          replaceOptimisticDoc(optimistic.id, promoted.doc);
          updateLocalCreateOperationDoc(promoted.doc);
          if (promoted.patch) {
            if (promoted.patch.markdown !== undefined) {
              const collaborator = getCollaboratorForDoc(promoted.doc);
              if (collaborator.getMarkdown() !== promoted.patch.markdown) {
                collaborator.applyLocalMarkdown(promoted.patch.markdown);
              }
              saveCollaborativeSnapshot(
                collaborativeMarkdownSnapshotKey(workspaceId, promoted.doc.id),
                collaborator.encodeUpdate(),
              );
            }
            commitLocalEdit(promoted.doc.id, promoted.patch);
            const nextTitle = promoted.patch.title ?? promoted.doc.title;
            const nextMarkdown = promoted.patch.markdown ?? promoted.doc.markdown;
            scheduleDocSave(
              promoted.doc.id,
              promoted.doc.revision,
              promoted.patch,
              nextTitle,
              created.markdown,
              nextMarkdown,
              180,
            );
          }
        } else {
          const promoted = promoteOptimisticCreateDoc(optimisticCreatePatches, optimistic.id, {
            ...created,
            content: normalizedContentForDoc(created),
          });
          replaceOptimisticDoc(optimistic.id, promoted.doc);
          updateLocalCreateOperationDoc(promoted.doc);
          if (promoted.patch) {
            const collaborator = getStructuredCollaboratorForDoc(promoted.doc);
            if (promoted.patch.content) {
              const stagedContent = normalizeStructuredDocumentContent(
                promoted.doc.kind === "table" ? "table" : "board",
                promoted.patch.content,
              );
              collaborator.applyLocalContent(stagedContent);
              saveCollaborativeSnapshot(
                collaborativeMarkdownSnapshotKey(workspaceId, promoted.doc.id),
                collaborator.encodeUpdate(),
              );
            }
            const syncedContent = promoted.patch.content ? collaborator.getContent() : undefined;
            const savePatch: OfflineMutationPatch = {
              ...promoted.patch,
              content: syncedContent ?? promoted.patch.content,
            };
            commitLocalEdit(promoted.doc.id, savePatch);
            scheduleDocSave(
              promoted.doc.id,
              promoted.doc.revision,
              savePatch,
              savePatch.title ?? promoted.doc.title,
              "",
              "",
              180,
            );
          }
        }
        syncEditorWithActive();
        renderAll();
        scheduleTreeRefresh();
        saveStatus(
          saveStatusEl,
          kind === "folder"
            ? t("doc.createdFolder")
            : kind === "table"
              ? t("doc.createdTable")
              : kind === "board"
                ? t("doc.createdBoard")
                : t("doc.createdFile"),
        );
      } catch (e) {
        removeLocalOperation(localCreateOperationId);
        rollbackOptimisticDoc(optimistic.id, previousActive);
        syncEditorWithActive();
        renderAll();
        notifyError(e);
      }
    };

    newFileBtn.addEventListener("click", () => void createAndOpen("page", defaultTitleForKind("page")));
    newTableBtn.addEventListener("click", () => void createAndOpen("table", defaultTitleForKind("table")));
    newBoardBtn.addEventListener("click", () => void createAndOpen("board", defaultTitleForKind("board")));
    newFolderBtn.addEventListener("click", () => void createAndOpen("folder", t("editor.untitledFolder")));

    pinBtn.addEventListener("click", () => {
      void (async () => {
        if (pinBtn.disabled) return;
        const itemId = active.id;
        const previousDoc = workspace.docs.find((doc) => doc.id === itemId);
        if (!previousDoc) return;
        const nextPinned = !previousDoc.pinned;
        const optimisticUpdatedAt = new Date().toISOString();
        workspace = applyOptimisticPinned(workspace, itemId, nextPinned, optimisticUpdatedAt);
        const optimistic = workspace.docs.find((doc) => doc.id === itemId);
        if (!optimistic) return;
        localCollaborativeDocCache.set(itemId, optimistic);
        if (active.id === itemId) {
          active = optimistic;
        }
        renderAll();
        saveStatus(saveStatusEl, nextPinned ? t("doc.pinned") : t("doc.unpinned"));
        try {
          const saved = await session.setPinned(itemId, nextPinned);
          markDocHydrated(itemId);
          updateDocById(itemId, (doc) => ({
            ...doc,
            pinned: saved.pinned,
            revision: saved.revision,
            updatedAt: saved.updatedAt,
          }));
          scheduleTreeRefresh();
        } catch (e) {
          updateDocById(itemId, () => previousDoc);
          renderAll();
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
        const itemId = active.id;
        const previous = workspace.docs.find((doc) => doc.id === itemId);
        if (!previous) return;
        const snapshot = snapshotWorkspaceState();
        const localOperationId = recordLocalDeleteOperation(itemId, "trash");
        blockDocSavesForItem(itemId);
        applyOptimisticTrash(itemId);
        syncEditorWithActive();
        renderAll();
        try {
          await waitForPendingDocSavesToSettle(saveQueue);
          const trashed = await session.trashItem(itemId);
          updateDocById(trashed.id, () => trashed);
          renderAll();
          scheduleTreeRefresh();
          saveStatus(saveStatusEl, t("doc.trashed"));
        } catch (e) {
          if (shouldQueueAsOfflinePending(e)) {
            await queueOfflineDeleteAction(itemId, "trash");
            removeLocalOperation(localOperationId);
            return;
          }
          removeLocalOperation(localOperationId);
          restoreWorkspaceState(snapshot);
          releaseDocSaveBlocksForItem(itemId);
          syncEditorWithActive();
          renderAll();
          notifyError(e);
        }
      })();
    });

    syncEditorWithActive();
    renderAll();
    void flushOfflineMutations();

    saveStatus(saveStatusEl, t("status.saved"));

    mounted = true;
    showWorkbench();
    if (active.kind === "table" || active.kind === "board") {
      const cached = localCollaborativeDocCache.get(active.id) ?? active;
      hydrateStructuredDocInPlace(active, cached);
    }
    void pullQuota();
    if (workspaceSyncTimer !== undefined) {
      window.clearInterval(workspaceSyncTimer);
    }
    workspaceSyncTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void persistRefreshTree().then(() => renderAll()).catch(() => undefined);
      }
    }, REMOTE_WORKSPACE_POLL_MS);
    window.addEventListener("focus", () => {
      if (mounted) {
        void persistRefreshTree().then(() => renderAll()).catch(() => undefined);
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (mounted && document.visibilityState === "visible") {
        void persistRefreshTree().then(() => renderAll()).catch(() => undefined);
      }
    });

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
          workspace_title: created.workspace_title,
          items: created.items,
        }, setupRememberPasswordInput.checked);
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
        await mountWithPassword(wsId, password, undefined, undefined, unlockRememberPasswordInput.checked);
      } catch (e) {
        setHealthStatus(backendHealthStatus, "error", t("status.backendError"));
        showGate("unlock", formatBackendOrUnknownError(e));
      } finally {
        setGateBusy(false, "unlock");
      }
    })();
  });

  createWorkspaceBtn.addEventListener("click", () => {
    showGate("setup");
  });

  lockWorkspaceBtn.addEventListener("click", () => {
    tableView?.destroy?.();
    boardView?.destroy?.();
    editor?.destroy();
    imageSync?.disconnect();
    imageSync = undefined;
    window.location.reload();
  });

  window.addEventListener("beforeunload", () => {
    window.clearInterval(healthTimer);
    if (workspaceSyncTimer !== undefined) {
      window.clearInterval(workspaceSyncTimer);
    }
    tableView?.destroy?.();
    boardView?.destroy?.();
    editor?.destroy();
    imageSync?.disconnect();
  });

  showGate(savedWsId ? "unlock" : "setup");
}
