/**
 * 将 Backend HTTP API 包装为工作台可用的操作面。
 * 密码仅在会话内存中使用，不写 chrome.storage。
 */

import {
  createBackendClient,
  type BackendClientOptions,
  type HistoryEvent,
  type WorkspaceItem,
  type WorkspaceTreeItem,
} from "@/features/backend/client";
import type { WorkspaceDoc, WorkspaceDocsState } from "@/shared/storage-keys";

const ROOT_FOLDER_ID = "root";

export function apiTreeItemToPartialDoc(item: WorkspaceTreeItem): WorkspaceDoc {
  return {
    id: item.id,
    title: item.title,
    markdown: "",
    revision: item.revision,
    updatedAt: item.updated_at,
    lastVisitedAt: item.updated_at,
    parentId: item.parent_id,
    pinned: item.pinned,
    inTrash: item.in_trash,
    kind: item.kind as WorkspaceDoc["kind"],
  };
}

export function apiItemToDoc(item: WorkspaceItem): WorkspaceDoc {
  return {
    id: item.id,
    title: item.title,
    markdown: item.markdown,
    revision: item.revision,
    updatedAt: item.updated_at,
    lastVisitedAt: item.updated_at,
    parentId: item.parent_id,
    pinned: item.pinned,
    inTrash: item.in_trash,
    kind: item.kind as WorkspaceDoc["kind"],
  };
}

/** 由 tree + item 拼出的最小 WorkspaceDocsState，仅供侧边栏渲染 */
export function buildDocsStateFromTree(
  items: WorkspaceTreeItem[],
  activeDocId: string,
  workspaceDescription: string,
): WorkspaceDocsState {
  const docs = items.map((it) => ({
    ...apiTreeItemToPartialDoc(it),
    markdown: "",
    lastVisitedAt: it.updated_at,
  }));
  return {
    activeDocId,
    docs,
    workspaceDescription,
  };
}

export type BackendWorkspaceSessionOptions = BackendClientOptions & {
  workspaceId: string;
  /** 工作区密码：仅存会话闭包，不落盘 */
  password: string;
};

/**
 * 会话级 Backend 运行时：所有文档读写均走后端。
 */
export function createBackendWorkspaceSession(opts: BackendWorkspaceSessionOptions) {
  const client = createBackendClient({
    baseUrl: opts.baseUrl,
    getToken: opts.getToken,
    signingIdentity: opts.signingIdentity,
  });
  const pwd = () => ({ password: opts.password });

  return {
    client,
    workspaceId: opts.workspaceId,

    async loadTree() {
      const r = await client.getTree(opts.workspaceId, pwd());
      return {
        active_item_id: r.active_item_id,
        items: r.items,
      };
    },

    async loadItem(itemId: string) {
      const r = await client.getItem(opts.workspaceId, itemId, pwd());
      return apiItemToDoc(r.item);
    },

    async saveItem(itemId: string, patch: { title?: string; markdown?: string; expectedRevision?: number }) {
      const r = await client.updateItem(opts.workspaceId, itemId, {
        password: opts.password,
        title: patch.title ?? null,
        markdown: patch.markdown ?? null,
        expected_revision: patch.expectedRevision ?? null,
      });
      return apiItemToDoc(r.item);
    },

    async createItem(kind: "page" | "folder", title: string, parentId: string | null = ROOT_FOLDER_ID) {
      const r = await client.createItem(opts.workspaceId, {
        password: opts.password,
        kind,
        title,
        parent_id: parentId,
      });
      return apiItemToDoc(r.item);
    },

    async setPinned(itemId: string, pinned: boolean) {
      const r = await client.pinItem(opts.workspaceId, itemId, {
        password: opts.password,
        pinned,
      });
      return apiItemToDoc(r.item);
    },

    async moveItem(itemId: string, parentId: string | null) {
      const r = await client.moveItem(opts.workspaceId, itemId, {
        password: opts.password,
        parent_id: parentId,
      });
      return apiItemToDoc(r.item);
    },

    async trashItem(itemId: string) {
      const r = await client.trashItem(opts.workspaceId, itemId, pwd());
      return apiItemToDoc(r.item);
    },

    async restoreItem(itemId: string) {
      const r = await client.restoreItem(opts.workspaceId, itemId, pwd());
      return apiItemToDoc(r.item);
    },

    async hardDeleteItem(itemId: string) {
      const r = await client.hardDeleteItem(opts.workspaceId, itemId, pwd());
      return apiItemToDoc(r.item);
    },

    async search(query: string) {
      const r = await client.search(opts.workspaceId, {
        password: opts.password,
        query,
      });
      return r.results;
    },

    async listHistory(): Promise<HistoryEvent[]> {
      const r = await client.listHistory(opts.workspaceId, pwd());
      return r.events;
    },

    async revertHistoryEvent(eventId: string): Promise<WorkspaceDoc> {
      const r = await client.revertHistory(opts.workspaceId, eventId, pwd());
      return apiItemToDoc(r.item);
    },
  };
}

export type BackendWorkspaceSession = ReturnType<typeof createBackendWorkspaceSession>;

export { ROOT_FOLDER_ID };
