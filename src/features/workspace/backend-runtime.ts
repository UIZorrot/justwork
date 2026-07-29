/**
 * 将 Backend HTTP API 包装为工作台可用的操作面。
 * 密码仅在会话内存中使用，不写 chrome.storage。
 */

import {
  createBackendClient,
  type BackendClientOptions,
  type BackendWorkspaceItemKind,
  type WorkspaceItem,
  type WorkspaceTreeItem,
} from "@/features/backend/client";
import type { WorkspaceDoc, WorkspaceDocContent, WorkspaceDocsState } from "@/shared/storage-keys";

const ROOT_FOLDER_ID = "root";

export function apiTreeItemToPartialDoc(item: WorkspaceTreeItem): WorkspaceDoc {
  return {
    id: item.id,
    title: item.title,
    markdown: "",
    content: null,
    revision: item.revision,
    updatedAt: item.updated_at,
    lastVisitedAt: item.updated_at,
    parentId: item.parent_id,
    orderKey: item.order_key,
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
    content: item.content ?? null,
    revision: item.revision,
    updatedAt: item.updated_at,
    lastVisitedAt: item.updated_at,
    parentId: item.parent_id,
    orderKey: item.order_key,
    pinned: item.pinned,
    inTrash: item.in_trash,
    kind: item.kind as WorkspaceDoc["kind"],
  };
}

/** 由 tree + item 拼出的最小 WorkspaceDocsState，仅供侧边栏渲染 */
export function buildDocsStateFromTree(
  items: WorkspaceTreeItem[],
  activeDocId: string,
  workspaceTitle: string,
  workspaceDescription: string,
): WorkspaceDocsState {
  const docs = items.map((it) => ({
    ...apiTreeItemToPartialDoc(it),
    markdown: "",
    content: null,
    lastVisitedAt: it.updated_at,
  }));
  return {
    activeDocId,
    docs,
    workspaceTitle,
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
    async joinRelay() {
      return client.joinRelay(opts.workspaceId, { password: opts.password });
    },

    async joinCollaborativeMarkdown(itemId: string) {
      return client.joinCollaborativeMarkdown(opts.workspaceId, itemId, { password: opts.password });
    },

    async loadCollaborativeMarkdownState(itemId: string) {
      return client.getCollaborativeMarkdownState(opts.workspaceId, itemId, { password: opts.password });
    },

    async loadTree() {
      const r = await client.getTree(opts.workspaceId, pwd());
      return {
        active_item_id: r.active_item_id,
        workspace_title: r.workspace_title,
        workspace_revision: r.workspace_revision,
        items: r.items,
      };
    },

    async listRevisions() {
      const r = await client.listRevisions(opts.workspaceId, pwd());
      return r.revisions;
    },

    async updateWorkspaceTitle(title: string, expectedRevision: number) {
      const r = await client.updateWorkspaceSettings(opts.workspaceId, {
        password: opts.password,
        title,
        expected_revision: expectedRevision,
      });
      return { title: r.title, revision: r.revision };
    },

    async listMembers() {
      const r = await client.listMembers(opts.workspaceId, pwd());
      return r.members;
    },

    async updateProfile(nickname: string, expectedRevision: number) {
      const r = await client.updateProfile(opts.workspaceId, {
        nickname,
        password: opts.password,
        expected_revision: expectedRevision,
      });
      return r.profile;
    },

    async loadItem(itemId: string) {
      const r = await client.getItem(opts.workspaceId, itemId, pwd());
      return apiItemToDoc(r.item);
    },

    async saveItem(
      itemId: string,
      patch: {
        title?: string;
        markdown?: string;
        content?: WorkspaceDocContent | null;
        collaborativeUpdate?: string;
        expectedRevision: number;
        mutationId?: string;
      },
    ) {
      const r = await client.updateItem(opts.workspaceId, itemId, {
        password: opts.password,
        title: patch.title ?? null,
        markdown: patch.markdown ?? null,
        content: patch.content ?? null,
        collaborative_update: patch.collaborativeUpdate ?? null,
        expected_revision: patch.expectedRevision,
        client_mutation_id: patch.mutationId ?? null,
      });
      return apiItemToDoc(r.item);
    },

    async createItem(
      kind: BackendWorkspaceItemKind,
      title: string,
      parentId: string | null = ROOT_FOLDER_ID,
      clientItemId?: string | null,
      clientMutationId?: string | null,
    ) {
      const r = await client.createItem(opts.workspaceId, {
        password: opts.password,
        kind,
        title,
        parent_id: parentId,
        client_item_id: clientItemId ?? undefined,
        client_mutation_id: clientMutationId ?? null,
      });
      return apiItemToDoc(r.item);
    },

    async setPinned(itemId: string, pinned: boolean, expectedRevision: number, clientMutationId?: string | null) {
      const r = await client.pinItem(opts.workspaceId, itemId, {
        password: opts.password,
        pinned,
        expected_revision: expectedRevision,
        client_mutation_id: clientMutationId ?? null,
      });
      return apiItemToDoc(r.item);
    },

    async moveItem(
      itemId: string,
      parentId: string | null,
      orderKey: number,
      expectedRevision: number,
      clientMutationId?: string | null,
    ) {
      const r = await client.moveItem(opts.workspaceId, itemId, {
        password: opts.password,
        parent_id: parentId,
        order_key: orderKey,
        expected_revision: expectedRevision,
        client_mutation_id: clientMutationId ?? null,
      });
      return apiItemToDoc(r.item);
    },

    async trashItem(itemId: string, expectedRevision: number, clientMutationId?: string | null) {
      const r = await client.trashItem(opts.workspaceId, itemId, {
        password: opts.password,
        expected_revision: expectedRevision,
        client_mutation_id: clientMutationId ?? null,
      });
      return apiItemToDoc(r.item);
    },

    async restoreItem(itemId: string, expectedRevision: number, clientMutationId?: string | null) {
      const r = await client.restoreItem(opts.workspaceId, itemId, {
        password: opts.password,
        expected_revision: expectedRevision,
        client_mutation_id: clientMutationId ?? null,
      });
      return apiItemToDoc(r.item);
    },

    async hardDeleteItem(itemId: string, expectedRevision: number, clientMutationId?: string | null) {
      const r = await client.hardDeleteItem(opts.workspaceId, itemId, {
        password: opts.password,
        expected_revision: expectedRevision,
        client_mutation_id: clientMutationId ?? null,
      });
      return apiItemToDoc(r.item);
    },

    async search(query: string) {
      const r = await client.search(opts.workspaceId, {
        password: opts.password,
        query,
      });
      return r.results;
    },

  };
}

export type BackendWorkspaceSession = ReturnType<typeof createBackendWorkspaceSession>;

export { ROOT_FOLDER_ID };
