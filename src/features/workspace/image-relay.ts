import type { RelayJoinResponse } from "@/features/backend/client";
import {
  base64ToBytes,
  bytesToBase64,
  chunkBytes,
  parseRelayMessage,
  type RelayMessage,
} from "./assets/relay-protocol";
import type { WorkspaceImageAssetMeta } from "./assets/types";

type RelayHandlers = {
  onJoin?: (message: Extract<RelayMessage, { type: "relay.join" }>) => void;
  onLeave?: (message: Extract<RelayMessage, { type: "relay.leave" }>) => void;
  onManifest?: (message: Extract<RelayMessage, { type: "asset.manifest" }>) => void;
  onRequest?: (message: Extract<RelayMessage, { type: "asset.request" }>) => void;
  onMissing?: (message: Extract<RelayMessage, { type: "asset.missing" }>) => void;
  onAck?: (message: Extract<RelayMessage, { type: "asset.ack" }>) => void;
  onAssetComplete?: (meta: WorkspaceImageAssetMeta, bytes: ArrayBuffer) => Promise<void> | void;
  onReady?: () => void;
};

export type WorkspaceImageRelayOptions = RelayHandlers & {
  baseUrl: string;
  workspaceId: string;
  joinRelay: () => Promise<RelayJoinResponse>;
};

function websocketUrl(baseUrl: string, workspaceId: string, ticket: string): string {
  const url = new URL(`/v1/workspaces/${encodeURIComponent(workspaceId)}/relay`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

function isOpen(socket: WebSocket | undefined): socket is WebSocket {
  return !!socket && socket.readyState === WebSocket.OPEN;
}

function concatArrayBuffers(chunks: ArrayBuffer[]): ArrayBuffer {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

export function createWorkspaceImageRelayClient(opts: WorkspaceImageRelayOptions) {
  let socket: WebSocket | undefined;
  const manifests = new Map<string, WorkspaceImageAssetMeta>();
  const partialChunks = new Map<string, { total: number; chunks: ArrayBuffer[] }>();

  const send = (message: RelayMessage): void => {
    if (!isOpen(socket)) return;
    socket.send(JSON.stringify(message));
  };

  const sendAsset = async (meta: WorkspaceImageAssetMeta, bytes: ArrayBuffer): Promise<void> => {
    send({ type: "asset.manifest", meta });
    const chunks = chunkBytes(bytes);
    chunks.forEach((chunk, index) => {
      send({
        type: "asset.chunk",
        workspaceId: meta.workspaceId,
        assetId: meta.assetId,
        index,
        total: chunks.length,
        chunkBase64: bytesToBase64(chunk),
      });
    });
  };

  const connect = async (): Promise<void> => {
    const ticket = await opts.joinRelay();
    return await new Promise<void>((resolve, reject) => {
      socket = new WebSocket(websocketUrl(opts.baseUrl, opts.workspaceId, ticket.ticket));
      let opened = false;
      socket.addEventListener("open", () => {
        opened = true;
        send({
          type: "relay.join",
          workspaceId: opts.workspaceId,
          ticket: ticket.ticket,
        });
        opts.onReady?.();
        resolve();
      });
      socket.addEventListener("message", async (event) => {
        let payload: unknown;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const parsed = parseRelayMessage(payload);
        if (!parsed) return;
        switch (parsed.type) {
          case "relay.join":
            opts.onJoin?.(parsed);
            break;
          case "relay.leave":
            opts.onLeave?.(parsed);
            break;
          case "asset.manifest":
            manifests.set(parsed.meta.assetId, parsed.meta);
            opts.onManifest?.(parsed);
            break;
          case "asset.request":
            opts.onRequest?.(parsed);
            break;
          case "asset.missing":
            opts.onMissing?.(parsed);
            break;
          case "asset.ack":
            opts.onAck?.(parsed);
            break;
          case "asset.chunk": {
            const current = partialChunks.get(parsed.assetId) ?? { total: parsed.total, chunks: [] };
            current.total = parsed.total;
            current.chunks[parsed.index] = base64ToBytes(parsed.chunkBase64);
            partialChunks.set(parsed.assetId, current);
            if (current.chunks.filter(Boolean).length === current.total) {
              const meta = manifests.get(parsed.assetId);
              if (meta) {
                const bytes = concatArrayBuffers(current.chunks);
                partialChunks.delete(parsed.assetId);
                await opts.onAssetComplete?.(meta, bytes);
              }
            }
            break;
          }
        }
      });
      socket.addEventListener("close", () => {
        socket = undefined;
        partialChunks.clear();
        if (!opened) reject(new Error("workspace relay websocket closed before opening"));
      });
      socket.addEventListener("error", () => {
        reject(new Error("workspace relay websocket failed"));
      });
    });
  };

  const disconnect = (): void => {
    if (!socket) return;
    try {
      send({ type: "relay.leave", workspaceId: opts.workspaceId });
    } finally {
      socket.close();
      socket = undefined;
      partialChunks.clear();
    }
  };

  return {
    connect,
    disconnect,
    send,
    sendAsset,
    requestAsset(assetId: string): void {
      send({ type: "asset.request", workspaceId: opts.workspaceId, assetId });
    },
    notifyMissing(assetId: string): void {
      send({ type: "asset.missing", workspaceId: opts.workspaceId, assetId });
    },
    acknowledge(assetId: string): void {
      send({ type: "asset.ack", workspaceId: opts.workspaceId, assetId });
    },
  };
}
