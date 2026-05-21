export const TRANSPORT_CONNECTING = 0;
export const TRANSPORT_OPEN = 1;
export const TRANSPORT_CLOSING = 2;
export const TRANSPORT_CLOSED = 3;

export function isTransportUsable(readyState: number): boolean {
  return readyState === TRANSPORT_CONNECTING || readyState === TRANSPORT_OPEN;
}

export function safeSendCollaborativeUpdate(
  readyState: number,
  sendUpdate: () => void,
  onClosed: () => void,
): void {
  if (!isTransportUsable(readyState)) {
    onClosed();
    return;
  }
  try {
    sendUpdate();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Collaborative transport is closed")) {
      onClosed();
      return;
    }
    throw error;
  }
}
