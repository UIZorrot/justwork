import { mergeUpdates } from "yjs";

export type CollaborativeUpdateHandler = (update: Uint8Array) => void;
export type CollaborativeStatusHandler = (readyState: number) => void;

export type CollaborativeTransport = {
  readonly readyState: number;
  sendUpdate: (update: Uint8Array) => void;
  onUpdate: (handler: CollaborativeUpdateHandler) => () => void;
  onStatus: (handler: CollaborativeStatusHandler) => () => void;
  close: () => void;
};

type PendingUpdate = {
  id: string;
  update: Uint8Array;
  lastSentAt: number;
  attempts: number;
};

const MAX_PENDING_UPDATES = 256;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_SOCKET_BUFFERED_BYTES = 1024 * 1024;
const RETRY_AFTER_MS = 1_500;
const SEND_WINDOW = 32;
const UPDATE_BATCH_MS = 250;
const durablePendingByRoom = new Map<string, Map<string, PendingUpdate>>();

function roomKey(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete("ticket");
  return parsed.toString();
}

function updateId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  return `${Date.now().toString(36)}-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function encodeBase64(update: Uint8Array): string {
  let binary = "";
  for (const byte of update) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function createCollaborativeTransport(
  url: string,
  protocols?: string | string[],
): CollaborativeTransport {
  const socket = new WebSocket(url, protocols);
  const handlers = new Set<CollaborativeUpdateHandler>();
  const statusHandlers = new Set<CollaborativeStatusHandler>();
  const key = roomKey(url);
  const pendingUpdates = durablePendingByRoom.get(key) ?? new Map<string, PendingUpdate>();
  durablePendingByRoom.set(key, pendingUpdates);
  let stagedUpdates: Uint8Array[] = [];
  let stagedBytes = 0;
  let batchTimer: number | undefined;

  const stagePendingUpdate = (): void => {
    if (stagedUpdates.length === 0) return;
    const update = stagedUpdates.length === 1 ? stagedUpdates[0]! : mergeUpdates(stagedUpdates);
    stagedUpdates = [];
    stagedBytes = 0;
    const id = updateId();
    pendingUpdates.set(id, { id, update, lastSentAt: 0, attempts: 0 });
  };

  const flushPendingUpdates = (): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    let sent = 0;
    for (const pending of pendingUpdates.values()) {
      if (sent >= SEND_WINDOW || socket.bufferedAmount >= MAX_SOCKET_BUFFERED_BYTES) break;
      if (pending.lastSentAt > 0 && now - pending.lastSentAt < RETRY_AFTER_MS) continue;
      socket.send(JSON.stringify({
        type: "collab.update",
        updateId: pending.id,
        payloadBase64: encodeBase64(pending.update),
      }));
      pending.lastSentAt = now;
      pending.attempts += 1;
      sent += 1;
    }
  };

  const retryTimer = window.setInterval(flushPendingUpdates, 500);

  const schedulePendingUpdate = (): void => {
    if (batchTimer !== undefined) return;
    batchTimer = window.setTimeout(() => {
      batchTimer = undefined;
      stagePendingUpdate();
      flushPendingUpdates();
    }, UPDATE_BATCH_MS);
  };

  socket.binaryType = "arraybuffer";
  const notifyStatus = (): void => {
    for (const handler of statusHandlers) handler(socket.readyState);
  };
  socket.addEventListener("open", () => {
    flushPendingUpdates();
    notifyStatus();
  });
  socket.addEventListener("close", notifyStatus);
  socket.addEventListener("error", notifyStatus);
  socket.addEventListener("message", (event) => {
    const payload = event.data;
    if (typeof payload === "string") {
      try {
        const message = JSON.parse(payload) as {
          type?: string;
          updateId?: string;
          payloadBase64?: string;
        };
        if (message.type === "collab.ack" && message.updateId) {
          pendingUpdates.delete(message.updateId);
          if (pendingUpdates.size === 0 && stagedUpdates.length === 0) durablePendingByRoom.delete(key);
          flushPendingUpdates();
          return;
        }
        if (message.type === "collab.update" && message.payloadBase64) {
          const update = decodeBase64(message.payloadBase64);
          for (const handler of handlers) handler(update);
        }
      } catch {
        // Ignore malformed control frames; canonical state is reloaded on reconnect.
      }
      return;
    }
    if (payload instanceof ArrayBuffer) {
      const update = new Uint8Array(payload);
      for (const handler of handlers) handler(update);
      return;
    }
    if (payload instanceof Blob) {
      void payload.arrayBuffer().then((buffer) => {
        const update = new Uint8Array(buffer);
        for (const handler of handlers) handler(update);
      });
    }
  });

  return {
    get readyState() {
      return socket.readyState;
    },
    sendUpdate: (update) => {
      if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
        throw new Error("Collaborative transport is closed");
      }
      const pendingBytes = Array.from(pendingUpdates.values()).reduce(
        (total, entry) => total + entry.update.byteLength,
        0,
      );
      if (
        pendingUpdates.size + (stagedUpdates.length > 0 ? 1 : 0) >= MAX_PENDING_UPDATES ||
        pendingBytes + stagedBytes + update.byteLength > MAX_PENDING_BYTES
      ) {
        throw new Error("Collaborative transport backpressure limit reached");
      }
      const staged = update.slice();
      stagedUpdates.push(staged);
      stagedBytes += staged.byteLength;
      durablePendingByRoom.set(key, pendingUpdates);
      schedulePendingUpdate();
    },
    onUpdate: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    onStatus: (handler) => {
      statusHandlers.add(handler);
      return () => {
        statusHandlers.delete(handler);
      };
    },
    close: () => {
      if (batchTimer !== undefined) window.clearTimeout(batchTimer);
      batchTimer = undefined;
      stagePendingUpdate();
      flushPendingUpdates();
      window.clearInterval(retryTimer);
      socket.close();
      handlers.clear();
      statusHandlers.clear();
    },
  };
}
