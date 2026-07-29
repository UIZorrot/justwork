/** 集中管理 storage key，避免散落魔法字符串 */
export const STORAGE_KEYS = {
  DOC_V1_DRAFT: "justwork.doc.draft.v1",
  DOC_V2: "justwork.doc.v2",
  DOCS_V1: "justwork.docs.v1",
  BRIDGE_SETTINGS: "justwork.bridge.settings",
  LAST_BACKEND_WORKSPACE_ID: "justwork.backend.lastWorkspaceId",
  UI_LOCALE: "justwork.ui.locale.v1",
  /** 最近使用过的工作区（仅本地，用于门页快捷选择） */
  BACKEND_WORKSPACE_RECENTS: "justwork.backend.workspaceRecents.v1",
  /** 各工作区记住的密码（仅本地，不会同步到后端） */
  BACKEND_WORKSPACE_PASSWORDS: "justwork.backend.workspacePasswords.v1",
  /** 各工作区的本地显示名（用于成员在线状态和 message drawer） */
  BACKEND_WORKSPACE_NICKNAMES: "justwork.backend.workspaceNicknames.v1",
  BACKEND_WORKSPACE_MEMBER_DIRECTORY: "justwork.backend.workspaceMembers.v1",
  BACKEND_WORKSPACE_INBOX_COOLDOWN: "justwork.backend.workspaceInboxCooldown.v1",
  OFFLINE_MUTATION_QUEUE: "justwork.offline.queue.v1",
  OFFLINE_DELETE_MUTATION_QUEUE: "justwork.offline.delete-queue.v1",
  WORKSPACE_MUTATION_LOG: "justwork.workspace.mutationLog.v1",
  BACKEND_DOC_DRAFTS: "justwork.backend.docDrafts.v1",
  COLLABORATIVE_MARKDOWN_SNAPSHOT_PREFIX: "justwork:collaboration:snapshot:",
} as const;

export type DocPayloadV2 = {
  markdown: string;
  revision: number;
};

export type WorkspaceTableContent = {
  frozenHeader?: boolean;
  columns: Array<{ id: string; title: string; type: string; width?: number }>;
  rows: Array<{ id: string; cells: Record<string, string> }>;
};

export type WorkspaceBoardTemplateField = {
  id: string;
  name: string;
  defaultValue?: string;
};

export type WorkspaceBoardCardField = {
  id: string;
  templateFieldId?: string | null;
  name: string;
  value: string;
};

export type WorkspaceBoardTemplate = {
  columnId: string;
  title: string;
  cardTitle: string;
  fields: WorkspaceBoardTemplateField[];
};

export type WorkspaceBoardContent = {
  template: WorkspaceBoardTemplate;
  columns: Array<{ id: string; title: string; color?: string; cardIds: string[] }>;
  cards: Array<{ id: string; title: string; fields: WorkspaceBoardCardField[] }>;
};

export type WorkspaceDocContent = WorkspaceTableContent | WorkspaceBoardContent;

export type WorkspaceDocKind = "welcome" | "page" | "folder" | "table" | "board";

export type WorkspaceDoc = {
  id: string;
  title: string;
  markdown: string;
  content?: WorkspaceDocContent | null;
  revision: number;
  updatedAt: string;
  lastVisitedAt: string;
  parentId: string | null;
  orderKey: number;
  pinned: boolean;
  inTrash: boolean;
  kind: WorkspaceDocKind;
};

export type WorkspaceDocsState = {
  activeDocId: string;
  docs: WorkspaceDoc[];
  workspaceTitle: string;
  workspaceDescription: string;
};

export type BridgeSettings = {
  enabled: boolean;
  /** 无尾部斜杠，如 http://127.0.0.1:17373 */
  baseUrl: string;
  token?: string;
};

export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = {
  enabled: false,
  baseUrl: "http://127.0.0.1:17373",
};
