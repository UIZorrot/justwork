import { createWorkspaceImageAssetStore } from "./assets/asset-store";
import { collectWorkspaceAssetRefs, createWorkspaceImageMarkdownCodec } from "./assets/markdown-images";
import { createIndexedDbWorkspaceAssetBackend } from "./assets/idb";
import type { EditorImageSync, EditorImageUploadResult } from "@/features/editor/types";
import { createWorkspaceImageRelayClient } from "./image-relay";
import type { RelayJoinResponse } from "@/features/backend/client";
import type { WorkspaceImageAssetMeta } from "./assets/types";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export type WorkspaceImageSync = {
  editorSync: EditorImageSync;
  warmMarkdowns(markdowns: string[]): Promise<void>;
  updateReferences(previousMarkdown: string, nextMarkdown: string): Promise<void>;
  connect(): Promise<void>;
  disconnect(): void;
};

type WorkspaceImageSyncOptions = {
  workspaceId: string;
  baseUrl: string;
  joinRelay: () => Promise<RelayJoinResponse>;
  onAssetChanged?: () => void;
};

export async function createWorkspaceImageSync(opts: WorkspaceImageSyncOptions): Promise<WorkspaceImageSync> {
  const backend = await createIndexedDbWorkspaceAssetBackend(`justwork-assets:${opts.workspaceId}`);
  const store = createWorkspaceImageAssetStore({ workspaceId: opts.workspaceId, backend });
  const codec = createWorkspaceImageMarkdownCodec({ workspaceId: opts.workspaceId, store });
  let relayConnection: Promise<void> | undefined;

  const relay = createWorkspaceImageRelayClient({
    baseUrl: opts.baseUrl,
    workspaceId: opts.workspaceId,
    joinRelay: opts.joinRelay,
    onReady: async () => {
      const assetIds = await store.listAssetIds();
      for (const assetId of assetIds) {
        const record = await store.get(assetId);
        if (record) {
          await relay.sendAsset(record.meta, record.bytes);
        }
      }
    },
    onManifest: async (message) => {
      if (!(await store.has(message.meta.assetId))) {
        relay.requestAsset(message.meta.assetId);
        return;
      }
      relay.acknowledge(message.meta.assetId);
    },
    onRequest: async (message) => {
      const record = await store.get(message.assetId);
      if (!record) {
        relay.notifyMissing(message.assetId);
        return;
      }
      await relay.sendAsset(record.meta, record.bytes);
    },
    onAssetComplete: async (meta, bytes) => {
      const next = await store.put({
        bytes,
        mimeType: meta.mimeType,
        filename: meta.filename,
        width: meta.width,
        height: meta.height,
      });
      if (next.assetId !== meta.assetId || next.sha256 !== meta.sha256) {
        await store.delete(next.assetId);
        relay.notifyMissing(meta.assetId);
        return;
      }
      const record = await store.get(next.assetId);
      if (record) {
        const localUrl = await store.loadBlobUrl(record.meta.assetId);
        if (localUrl) store.rememberAssetUrl(record.meta.assetId, localUrl);
      }
      opts.onAssetChanged?.();
    },
  });

  const ensureRelayConnected = async (): Promise<void> => {
    if (!relayConnection) {
      relayConnection = relay.connect().catch((error) => {
        relayConnection = undefined;
        throw error;
      });
    }
    await relayConnection;
  };

  const warmMarkdowns = async (markdowns: string[]): Promise<void> => {
    await codec.warmMarkdowns(markdowns);
  };

  const updateReferences = async (previousMarkdown: string, nextMarkdown: string): Promise<void> => {
    const beforeRefs = collectWorkspaceAssetRefs(previousMarkdown, opts.workspaceId);
    const afterRefs = collectWorkspaceAssetRefs(nextMarkdown, opts.workspaceId);
    await store.updateReferenceCounts(beforeRefs, afterRefs);
    await store.sweepUnreferenced();
  };

  const editorSync: EditorImageSync = {
    toEditorMarkdown: codec.rewriteForEditor,
    fromEditorMarkdown: codec.rewriteFromEditor,
    uploadFiles: async (files) => {
      await ensureRelayConnected().catch(() => undefined);
      const results: EditorImageUploadResult[] = [];
      for (const file of files) {
        const bytes = await file.arrayBuffer();
        const meta: WorkspaceImageAssetMeta = await store.put({
          bytes,
          mimeType: file.type || "application/octet-stream",
          filename: file.name || "image",
        });
        const record = await store.get(meta.assetId);
        if (!record) continue;
        const localUrl = await store.loadBlobUrl(meta.assetId);
        if (!localUrl) continue;
        store.rememberAssetUrl(meta.assetId, localUrl);
        results.push({
          assetId: meta.assetId,
          localUrl,
          html: `<img src="${escapeHtml(localUrl)}" alt="${escapeHtml(file.name || "image")}" />`,
        });
        await relay.sendAsset(record.meta, record.bytes);
      }
      return results;
    },
    dispose: () => {
      store.clearTransientUrls();
      relay.disconnect();
      relayConnection = undefined;
    },
  };

  return {
    editorSync,
    warmMarkdowns,
    updateReferences,
    connect: async () => {
      await ensureRelayConnected();
    },
    disconnect: () => {
      relay.disconnect();
      relayConnection = undefined;
    },
  };
}
