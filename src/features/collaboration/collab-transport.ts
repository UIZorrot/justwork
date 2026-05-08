export type CollaborativeUpdateHandler = (update: Uint8Array) => void;

export type CollaborativeTransport = {
  readonly readyState: number;
  sendUpdate: (update: Uint8Array) => void;
  onUpdate: (handler: CollaborativeUpdateHandler) => () => void;
  close: () => void;
};

export function createCollaborativeTransport(
  url: string,
  protocols?: string | string[],
): CollaborativeTransport {
  const socket = new WebSocket(url, protocols);
  const handlers = new Set<CollaborativeUpdateHandler>();

  socket.binaryType = "arraybuffer";
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
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(update);
      }
    },
    onUpdate: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    close: () => {
      socket.close();
      handlers.clear();
    },
  };
}
