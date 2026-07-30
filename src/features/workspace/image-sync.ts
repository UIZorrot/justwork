import { createWorkspaceImageAssetStore } from "./assets/asset-store";
import { collectWorkspaceAssetRefs, createWorkspaceImageMarkdownCodec } from "./assets/markdown-images";
import { createIndexedDbWorkspaceAssetBackend } from "./assets/idb";
import type { EditorImageSync, EditorImageUploadResult } from "@/features/editor/types";
import { createWorkspaceImageRelayClient } from "./image-relay";
import type { RelayJoinResponse } from "@/features/backend/client";
import type { WorkspacePresenceMember } from "./assets/relay-protocol";
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
  announcePresence(displayName: string): void;
  getCommunityState(): WorkspaceCommunityState;
};

export type WorkspaceCommunityState = {
  members: WorkspacePresenceMember[];
};

type WorkspaceImageSyncOptions = {
  workspaceId: string;
  baseUrl: string;
  joinRelay: () => Promise<RelayJoinResponse>;
  sessionId: string;
  displayName: string;
  userId?: string;
  onAssetChanged?: () => void;
  onCommunityStateChange?: (state: WorkspaceCommunityState) => void;
  onWorkspaceInvalidated?: () => void;
};

export async function createWorkspaceImageSync(opts: WorkspaceImageSyncOptions): Promise<WorkspaceImageSync> {
  const backend = await createIndexedDbWorkspaceAssetBackend(`justwork-assets:${opts.workspaceId}`);
  const store = createWorkspaceImageAssetStore({ workspaceId: opts.workspaceId, backend });
  const assetIdsByFilename = new Map<string, Set<string>>();

  const indexAsset = (assetId: string, filename?: string): void => {
    const key = filename?.trim();
    if (!key) return;
    let assetIds = assetIdsByFilename.get(key);
    if (!assetIds) {
      assetIds = new Set<string>();
      assetIdsByFilename.set(key, assetIds);
    }
    assetIds.add(assetId);
  };

  const unindexAsset = (assetId: string): void => {
    for (const [filename, assetIds] of assetIdsByFilename) {
      if (!assetIds.delete(assetId)) continue;
      if (assetIds.size === 0) {
        assetIdsByFilename.delete(filename);
      }
      break;
    }
  };

  const resolveAssetIdByFilename = (filename: string): string | null => {
    const assetIds = assetIdsByFilename.get(filename.trim());
    if (!assetIds || assetIds.size !== 1) return null;
    return assetIds.values().next().value ?? null;
  };

  const primeAssetFilenameIndex = async (): Promise<void> => {
    const assetIds = await store.listAssetIds();
    for (const assetId of assetIds) {
      const record = await store.get(assetId);
      indexAsset(assetId, record?.meta.filename);
    }
  };

  await primeAssetFilenameIndex();

  const codec = createWorkspaceImageMarkdownCodec({
    workspaceId: opts.workspaceId,
    store,
    resolveAssetIdByFilename,
  });
  let relayConnection: Promise<void> | undefined;
  const pendingAssetIds = new Set<string>();
  const communityMembers = new Map<string, WorkspacePresenceMember>();
  const emitCommunityState = (): void => {
    opts.onCommunityStateChange?.({
      members: Array.from(communityMembers.values()),
    });
  };

  const queueMissingAssets = async (markdowns: string[]): Promise<void> => {
    const refs = new Set<string>();
    for (const markdown of markdowns) {
      for (const assetId of collectWorkspaceAssetRefs(markdown, opts.workspaceId)) {
        refs.add(assetId);
      }
    }
    for (const assetId of refs) {
      if (await store.has(assetId)) {
        pendingAssetIds.delete(assetId);
      } else {
        pendingAssetIds.add(assetId);
      }
    }
  };

  const flushPendingAssetRequests = async (): Promise<void> => {
    for (const assetId of pendingAssetIds) {
      relay.requestAsset(assetId);
    }
  };

  const relay = createWorkspaceImageRelayClient({
    baseUrl: opts.baseUrl,
    workspaceId: opts.workspaceId,
    joinRelay: opts.joinRelay,
    sessionId: opts.sessionId,
    displayName: opts.displayName,
    userId: opts.userId,
    onReady: async () => {
      relay.syncPresence();
      const assetIds = await store.listAssetIds();
      for (const assetId of assetIds) {
        const record = await store.get(assetId);
        if (record) {
          await relay.sendAsset(record.meta, record.bytes);
        }
      }
      await flushPendingAssetRequests();
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
    onPresenceSnapshot: (message) => {
      communityMembers.clear();
      for (const member of message.members) {
        communityMembers.set(member.sessionId, member);
      }
      emitCommunityState();
    },
    onPresenceJoin: (message) => {
      communityMembers.set(message.member.sessionId, message.member);
      emitCommunityState();
    },
    onPresenceLeave: (message) => {
      communityMembers.delete(message.sessionId);
      emitCommunityState();
    },
    onWorkspaceInvalidated: () => {
      opts.onWorkspaceInvalidated?.();
    },
    onAssetComplete: async (meta, bytes) => {
      const next = await store.put({
        bytes,
        mimeType: meta.mimeType,
        filename: meta.filename,
        width: meta.width,
        height: meta.height,
      });
      indexAsset(next.assetId, next.filename);
      pendingAssetIds.delete(next.assetId);
      if (next.assetId !== meta.assetId || next.sha256 !== meta.sha256) {
        unindexAsset(next.assetId);
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
    await queueMissingAssets(markdowns);
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
      void ensureRelayConnected().catch(() => undefined);
      const results: EditorImageUploadResult[] = [];
      for (const file of files) {
        const bytes = await file.arrayBuffer();
        const meta: WorkspaceImageAssetMeta = await store.put({
          bytes,
          mimeType: file.type || "application/octet-stream",
          filename: file.name || "image",
        });
        indexAsset(meta.assetId, meta.filename);
        const record = await store.get(meta.assetId);
        if (!record) continue;
        const localUrl = await store.loadBlobUrl(meta.assetId);
        if (!localUrl) continue;
        pendingAssetIds.delete(meta.assetId);
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
      emitCommunityState();
      await flushPendingAssetRequests();
    },
    disconnect: () => {
      relay.disconnect();
      relayConnection = undefined;
    },
    announcePresence: (displayName: string) => relay.announcePresence(displayName),
    getCommunityState: () => ({
      members: Array.from(communityMembers.values()),
    }),
  };
}
