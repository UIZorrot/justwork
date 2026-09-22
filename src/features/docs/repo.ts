import { STORAGE_KEYS, type DocPayloadV2, type WorkspaceDoc, type WorkspaceDocsState } from "@/shared/storage-keys";

export const ROOT_FOLDER_ID = "root";

function nowIso(): string {
  return new Date().toISOString();
}

function makeDocId(): string {
  return `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeRootFolderDoc(): WorkspaceDoc {
  return {
    id: ROOT_FOLDER_ID,
    title: "根目录",
    markdown: "",
    revision: 0,
    updatedAt: nowIso(),
    lastVisitedAt: nowIso(),
    parentId: null,
    orderKey: 0,
    pinned: false,
    inTrash: false,
    kind: "folder",
  };
}

function makeInitialDoc(markdown = "", parentId: string | null = null): WorkspaceDoc {
  return {
    id: makeDocId(),
    title: "未命名文档",
    markdown,
    revision: 0,
    updatedAt: nowIso(),
    lastVisitedAt: nowIso(),
    parentId,
    orderKey: 0,
    pinned: false,
    inTrash: false,
    kind: "page",
  };
}

export function looksLikeLegacyWelcomeMarkdown(markdown: string): boolean {
  return (
    markdown.includes("欢迎来到 JustWork") ||
    markdown.includes("Welcome to JustWork") ||
    markdown.includes("这里是你的文档中枢") ||
    markdown.includes("This is your document hub")
  );
}

export function normalizeLegacyWelcomeDoc(doc: WorkspaceDoc): WorkspaceDoc {
  if (doc.kind !== "welcome") return doc;
  return {
    ...doc,
    kind: "page",
  };
}

export function migrateLegacyWelcomeDocs(state: WorkspaceDocsState): WorkspaceDocsState {
  const docs = state.docs.map((doc) => normalizeLegacyWelcomeDoc(doc));
  const activeDocId = docs.some((doc) => doc.id === state.activeDocId && !doc.inTrash)
    ? state.activeDocId
    : docs.find((doc) => doc.kind === "page" && !doc.inTrash)?.id ?? ROOT_FOLDER_ID;
  return { ...state, docs, activeDocId };
}

function getDocById(state: WorkspaceDocsState, id: string): WorkspaceDoc | undefined {
  return state.docs.find((d) => d.id === id);
}

function isFolder(state: WorkspaceDocsState, id: string | null): boolean {
  if (!id) return false;
  return getDocById(state, id)?.kind === "folder";
}

function hasAncestor(state: WorkspaceDocsState, id: string, maybeAncestorId: string): boolean {
  let cur = getDocById(state, id);
  while (cur?.parentId) {
    if (cur.parentId === maybeAncestorId) return true;
    cur = getDocById(state, cur.parentId);
  }
  return false;
}

function normalizeDoc(input: WorkspaceDoc): WorkspaceDoc {
  const now = nowIso();
  return {
    ...input,
    parentId: input.parentId ?? null,
    pinned: Boolean(input.pinned),
    inTrash: Boolean(input.inTrash),
    kind: input.kind ?? "page",
    lastVisitedAt: input.lastVisitedAt ?? input.updatedAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

function ensureRootFolder(state: WorkspaceDocsState): WorkspaceDocsState {
  const hasRoot = state.docs.some((d) => d.id === ROOT_FOLDER_ID && d.kind === "folder" && !d.inTrash);
  if (hasRoot) return state;
  return {
    ...state,
    docs: [makeRootFolderDoc(), ...state.docs],
    activeDocId: state.activeDocId || ROOT_FOLDER_ID,
  };
}

export async function loadWorkspaceDocsState(): Promise<WorkspaceDocsState> {
  const raw = await chrome.storage.local.get([
    STORAGE_KEYS.DOCS_V1,
    STORAGE_KEYS.DOC_V2,
    STORAGE_KEYS.DOC_V1_DRAFT,
  ]);

  const docsV1 = raw[STORAGE_KEYS.DOCS_V1] as WorkspaceDocsState | undefined;
  if (docsV1 && Array.isArray(docsV1.docs) && docsV1.docs.length > 0) {
    const base: WorkspaceDocsState = {
      activeDocId: typeof docsV1.activeDocId === "string" ? docsV1.activeDocId : docsV1.docs[0].id,
      docs: docsV1.docs.map((d) => normalizeDoc(d)),
      workspaceTitle: docsV1.workspaceTitle || "Untitled workspace",
      workspaceDescription: docsV1.workspaceDescription || "这是你的 AI 协同工作区，可沉淀文档、流程与上下文。",
    };
    return migrateLegacyWelcomeDocs(ensureRootFolder(base));
  }

  const workspaceDescription = "这是你的 AI 协同工作区，可沉淀文档、流程与上下文。";

  const legacyV2 = raw[STORAGE_KEYS.DOC_V2] as DocPayloadV2 | undefined;
  if (legacyV2 && typeof legacyV2.markdown === "string") {
    const doc = makeInitialDoc(legacyV2.markdown);
    doc.revision = legacyV2.revision ?? 0;
    return migrateLegacyWelcomeDocs(ensureRootFolder({ activeDocId: doc.id, docs: [doc], workspaceTitle: "Untitled workspace", workspaceDescription }));
  }

  const legacyV1 = raw[STORAGE_KEYS.DOC_V1_DRAFT];
  if (typeof legacyV1 === "string") {
    const doc = makeInitialDoc(legacyV1);
    return migrateLegacyWelcomeDocs(ensureRootFolder({ activeDocId: doc.id, docs: [doc], workspaceTitle: "Untitled workspace", workspaceDescription }));
  }

  const doc = makeInitialDoc("");
  return migrateLegacyWelcomeDocs(ensureRootFolder({ activeDocId: doc.id, docs: [doc], workspaceTitle: "Untitled workspace", workspaceDescription }));
}

export async function saveWorkspaceDocsState(state: WorkspaceDocsState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.DOCS_V1]: state });
}

export function getActiveDoc(state: WorkspaceDocsState): WorkspaceDoc {
  const found = state.docs.find((d) => d.id === state.activeDocId && !d.inTrash);
  if (found) return found;
  const firstAlive = state.docs.find((d) => !d.inTrash);
  return firstAlive ?? getDocById(state, ROOT_FOLDER_ID) ?? state.docs[0];
}

export function upsertDoc(state: WorkspaceDocsState, next: WorkspaceDoc): WorkspaceDocsState {
  const normalized = normalizeDoc(next);
  const docs = state.docs.map((d) => (d.id === normalized.id ? normalized : d));
  return { ...state, docs };
}

export function createDoc(state: WorkspaceDocsState, parentId: string | null): WorkspaceDocsState {
  const safeParentId = isFolder(state, parentId) ? parentId : ROOT_FOLDER_ID;
  const doc = makeInitialDoc("", safeParentId);
  return {
    ...state,
    activeDocId: doc.id,
    docs: [doc, ...state.docs],
  };
}

export function createFolder(state: WorkspaceDocsState, parentId: string | null): WorkspaceDocsState {
  const safeParentId = isFolder(state, parentId) ? parentId : ROOT_FOLDER_ID;
  const doc = makeInitialDoc("", safeParentId);
  doc.title = "新建文件夹";
  doc.kind = "folder";
  return {
    ...state,
    activeDocId: doc.id,
    docs: [doc, ...state.docs],
  };
}

export function reparentDoc(
  state: WorkspaceDocsState,
  docId: string,
  targetFolderId: string | null,
): WorkspaceDocsState {
  const doc = getDocById(state, docId);
  if (!doc || doc.id === ROOT_FOLDER_ID) return state;

  const safeTarget = isFolder(state, targetFolderId) ? targetFolderId : ROOT_FOLDER_ID;
  if (safeTarget === doc.id) return state;
  if (doc.kind === "folder" && safeTarget && hasAncestor(state, safeTarget, doc.id)) return state;

  const docs = state.docs.map((d) =>
    d.id === docId ? { ...d, parentId: safeTarget, updatedAt: nowIso() } : d,
  );
  return { ...state, docs };
}

export function softDeleteDoc(state: WorkspaceDocsState, id: string): WorkspaceDocsState {
  if (id === ROOT_FOLDER_ID) return state;
  const docs = state.docs.map((d) => (d.id === id ? { ...d, inTrash: true, pinned: false, updatedAt: nowIso() } : d));
  const activeDocId = state.activeDocId === id ? ROOT_FOLDER_ID : state.activeDocId;
  return { ...state, docs, activeDocId };
}

export function restoreDoc(state: WorkspaceDocsState, id: string): WorkspaceDocsState {
  const docs = state.docs.map((d) => (d.id === id ? { ...d, inTrash: false, updatedAt: nowIso() } : d));
  return { ...state, docs };
}

export function hardDeleteDoc(state: WorkspaceDocsState, id: string): WorkspaceDocsState {
  if (id === ROOT_FOLDER_ID) return state;
  const docs = state.docs.filter((d) => d.id !== id);
  const activeDocId = state.activeDocId === id ? ROOT_FOLDER_ID : state.activeDocId;
  return { ...state, docs, activeDocId };
}

export function togglePinDoc(state: WorkspaceDocsState, id: string): WorkspaceDocsState {
  if (id === ROOT_FOLDER_ID) return state;
  const docs = state.docs.map((d) => (d.id === id ? { ...d, pinned: !d.pinned, updatedAt: nowIso() } : d));
  return { ...state, docs };
}

export function touchVisited(state: WorkspaceDocsState, id: string): WorkspaceDocsState {
  const docs = state.docs.map((d) => (d.id === id ? { ...d, lastVisitedAt: nowIso() } : d));
  return { ...state, docs };
}

export function buildWelcomeMarkdown(state: WorkspaceDocsState): string {
  const recent = state.docs
    .filter((d) => d.kind !== "welcome" && !d.inTrash)
    .sort((a, b) => b.lastVisitedAt.localeCompare(a.lastVisitedAt))
    .slice(0, 8);

  const recentLines = recent.length
    ? recent.map((d, idx) => `${idx + 1}. ${d.title || "未命名文档"}`).join("\n")
    : "暂无最近访问";

  return [
    "# 欢迎来到 JustWork",
    "",
    state.workspaceDescription,
    "",
    "## 最近访问",
    "",
    recentLines,
    "",
    "## 工作区简介",
    "",
    "- 这里是你的文档中枢，支持层级页面、搜索、Pin、垃圾箱。",
    "- 你可以把常用页面 Pin 到顶部，删除内容先进入垃圾箱再彻底删除。",
  ].join("\n");
}
