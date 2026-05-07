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
  OFFLINE_MUTATION_QUEUE: "justwork.offline.queue.v1",
} as const;

export type DocPayloadV2 = {
  markdown: string;
  revision: number;
};

export type WorkspaceDoc = {
  id: string;
  title: string;
  markdown: string;
  revision: number;
  updatedAt: string;
  lastVisitedAt: string;
  parentId: string | null;
  pinned: boolean;
  inTrash: boolean;
  kind: "welcome" | "page" | "folder";
};

export type WorkspaceDocsState = {
  activeDocId: string;
  docs: WorkspaceDoc[];
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
