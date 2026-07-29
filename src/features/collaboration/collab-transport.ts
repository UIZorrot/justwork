export type CollaborativeUpdateHandler = (update: Uint8Array) => void;
export type CollaborativeStatusHandler = (readyState: number) => void;

export type CollaborativeTransport = {
  readonly readyState: number;
  sendUpdate: (update: Uint8Array) => void;
  onUpdate: (handler: CollaborativeUpdateHandler) => () => void;
  onStatus: (handler: CollaborativeStatusHandler) => () => void;
  close: () => void;
};

export function createCollaborativeTransport(
  url: string,
  protocols?: string | string[],
): CollaborativeTransport {
  const socket = new WebSocket(url, protocols);
  const handlers = new Set<CollaborativeUpdateHandler>();
  const statusHandlers = new Set<CollaborativeStatusHandler>();
  const pendingUpdates: Uint8Array[] = [];

  const flushPendingUpdates = (): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    while (pendingUpdates.length > 0) {
      const next = pendingUpdates.shift();
      if (next) socket.send(next);
    }
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
      pendingUpdates.push(update.slice());
      flushPendingUpdates();
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
      socket.close();
      handlers.clear();
      statusHandlers.clear();
    },
  };
}
