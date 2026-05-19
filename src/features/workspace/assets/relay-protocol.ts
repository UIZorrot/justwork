import type { WorkspaceImageAssetMeta } from "./types";

export type RelayJoinMessage = {
  type: "relay.join";
  workspaceId: string;
  ticket: string;
  localAssetIds?: string[];
  sessionId?: string;
  displayName?: string;
  userId?: string;
};

export type RelayLeaveMessage = {
  type: "relay.leave";
  workspaceId: string;
  sessionId?: string;
};

export type WorkspacePresenceSnapshotMessage = {
  type: "workspace.presence.snapshot";
  workspaceId: string;
  members: WorkspacePresenceMember[];
};

export type WorkspacePresenceJoinMessage = {
  type: "workspace.presence.join";
  workspaceId: string;
  member: WorkspacePresenceMember;
};

export type WorkspacePresenceLeaveMessage = {
  type: "workspace.presence.leave";
  workspaceId: string;
  sessionId: string;
};

export type WorkspacePresenceSyncMessage = {
  type: "workspace.presence.sync";
  workspaceId: string;
};

export type WorkspacePresenceMember = {
  sessionId: string;
  displayName: string;
  userId?: string;
  joinedAt: string;
};

export type AssetManifestMessage = {
  type: "asset.manifest";
  meta: WorkspaceImageAssetMeta;
};

export type AssetRequestMessage = {
  type: "asset.request";
  workspaceId: string;
  assetId: string;
};

export type AssetMissingMessage = {
  type: "asset.missing";
  workspaceId: string;
  assetId: string;
};

export type AssetAckMessage = {
  type: "asset.ack";
  workspaceId: string;
  assetId: string;
};

export type AssetChunkMessage = {
  type: "asset.chunk";
  workspaceId: string;
  assetId: string;
  index: number;
  total: number;
  chunkBase64: string;
};

export type RelayMessage =
  | RelayJoinMessage
  | RelayLeaveMessage
  | AssetManifestMessage
  | AssetRequestMessage
  | AssetMissingMessage
  | AssetAckMessage
  | AssetChunkMessage
  | WorkspacePresenceSnapshotMessage
  | WorkspacePresenceJoinMessage
  | WorkspacePresenceLeaveMessage
  | WorkspacePresenceSyncMessage;

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);
}

function isMeta(value: unknown): value is WorkspaceImageAssetMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as WorkspaceImageAssetMeta;
  return (
    isString(meta.workspaceId) &&
    isString(meta.assetId) &&
    isString(meta.mimeType) &&
    isFiniteInteger(meta.sizeBytes) &&
    isString(meta.sha256)
  );
}

export function parseRelayMessage(value: unknown): RelayMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const msg = value as Record<string, unknown>;
  if (!isString(msg.type)) return null;

  switch (msg.type) {
    case "relay.join":
      if (isString(msg.workspaceId) && isString(msg.ticket)) {
        const localAssetIds = Array.isArray(msg.localAssetIds) ? msg.localAssetIds.filter(isString) : undefined;
        return {
          type: "relay.join",
          workspaceId: msg.workspaceId,
          ticket: msg.ticket,
          localAssetIds,
          sessionId: isString(msg.sessionId) ? msg.sessionId : undefined,
          displayName: isString(msg.displayName) ? msg.displayName : undefined,
          userId: isString(msg.userId) ? msg.userId : undefined,
        };
      }
      return null;
    case "relay.leave":
      return isString(msg.workspaceId)
        ? {
            type: "relay.leave",
            workspaceId: msg.workspaceId,
            sessionId: isString(msg.sessionId) ? msg.sessionId : undefined,
          }
        : null;
    case "asset.manifest":
      return isMeta(msg.meta) ? { type: "asset.manifest", meta: msg.meta } : null;
    case "asset.request":
      return isString(msg.workspaceId) && isString(msg.assetId)
        ? { type: "asset.request", workspaceId: msg.workspaceId, assetId: msg.assetId }
        : null;
    case "asset.missing":
      return isString(msg.workspaceId) && isString(msg.assetId)
        ? { type: "asset.missing", workspaceId: msg.workspaceId, assetId: msg.assetId }
        : null;
    case "asset.ack":
      return isString(msg.workspaceId) && isString(msg.assetId)
        ? { type: "asset.ack", workspaceId: msg.workspaceId, assetId: msg.assetId }
        : null;
    case "asset.chunk":
      return isString(msg.workspaceId) &&
        isString(msg.assetId) &&
        isFiniteInteger(msg.index) &&
        isFiniteInteger(msg.total) &&
        isString(msg.chunkBase64)
        ? {
            type: "asset.chunk",
            workspaceId: msg.workspaceId,
            assetId: msg.assetId,
            index: msg.index,
          total: msg.total,
          chunkBase64: msg.chunkBase64,
        }
        : null;
    case "workspace.presence.snapshot":
      return isString(msg.workspaceId) && Array.isArray(msg.members)
        ? {
            type: "workspace.presence.snapshot",
            workspaceId: msg.workspaceId,
            members: msg.members.filter(isPresenceMember),
          }
        : null;
    case "workspace.presence.join":
      return isString(msg.workspaceId) && isPresenceMember(msg.member)
        ? { type: "workspace.presence.join", workspaceId: msg.workspaceId, member: msg.member }
        : null;
    case "workspace.presence.leave":
      return isString(msg.workspaceId) && isString(msg.sessionId)
        ? { type: "workspace.presence.leave", workspaceId: msg.workspaceId, sessionId: msg.sessionId }
        : null;
    case "workspace.presence.sync":
      return isString(msg.workspaceId) ? { type: "workspace.presence.sync", workspaceId: msg.workspaceId } : null;
    default:
      return null;
  }
}

function isPresenceMember(value: unknown): value is WorkspacePresenceMember {
  if (typeof value !== "object" || value === null) return false;
  const member = value as WorkspacePresenceMember;
  return (
    isString(member.sessionId) &&
    isString(member.displayName) &&
    (member.userId === undefined || isString(member.userId)) &&
    isString(member.joinedAt)
  );
}

export function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]!);
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(view).toString("base64");
}

export function base64ToBytes(base64: string): ArrayBuffer {
  let binary: string;
  if (typeof atob === "function") {
    binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  return Uint8Array.from(Buffer.from(base64, "base64")).buffer;
}

export function chunkBytes(bytes: ArrayBuffer, chunkSize = 256 * 1024): ArrayBuffer[] {
  const view = new Uint8Array(bytes);
  const chunks: ArrayBuffer[] = [];
  for (let offset = 0; offset < view.length; offset += chunkSize) {
    chunks.push(view.slice(offset, offset + chunkSize).buffer);
  }
  if (chunks.length === 0) chunks.push(new ArrayBuffer(0));
  return chunks;
}
