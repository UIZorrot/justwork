import { STORAGE_KEYS } from "@/shared/storage-keys";
import { getBrowserLocalStorage } from "@/features/workspace/local-runtime";

const SNAPSHOT_PREFIX = STORAGE_KEYS.COLLABORATIVE_MARKDOWN_SNAPSHOT_PREFIX;

function storageKey(documentKey: string): string {
  return `${SNAPSHOT_PREFIX}${documentKey}`;
}

function epochStorageKey(documentKey: string): string {
  return `${storageKey(documentKey)}:epoch`;
}

function encodeSnapshot(snapshot: Uint8Array): string {
  let binary = "";
  for (const byte of snapshot) binary += String.fromCharCode(byte);
  if (typeof btoa === "function") {
    return btoa(binary);
  }
  return Buffer.from(snapshot).toString("base64");
}

function decodeSnapshot(encoded: string): Uint8Array {
  try {
    if (typeof atob === "function") {
      const binary = atob(encoded);
      const snapshot = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        snapshot[index] = binary.charCodeAt(index);
      }
      return snapshot;
    }
    return new Uint8Array(Buffer.from(encoded, "base64"));
  } catch {
    return new Uint8Array();
  }
}

function getLocalStorage(): Storage | undefined {
  return getBrowserLocalStorage();
}

export function saveCollaborativeSnapshot(documentKey: string, snapshot: Uint8Array): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(storageKey(documentKey), encodeSnapshot(snapshot));
  } catch {
    // A local recovery cache must never interrupt the editor or realtime transport.
    // The server remains authoritative if the browser storage quota is exhausted.
  }
}

export function saveCollaborativeSnapshotEpoch(documentKey: string, epoch: string): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(epochStorageKey(documentKey), epoch);
  } catch {
    // Best effort for the same reason as the snapshot write above.
  }
}

export function loadCollaborativeSnapshotEpoch(documentKey: string): string | null {
  const storage = getLocalStorage();
  if (!storage) return null;
  return storage.getItem(epochStorageKey(documentKey));
}

export function loadCollaborativeSnapshot(documentKey: string): Uint8Array | null {
  const storage = getLocalStorage();
  if (!storage) return null;
  const encoded = storage.getItem(storageKey(documentKey));
  if (encoded === null) return null;
  const snapshot = decodeSnapshot(encoded);
  if (snapshot.length === 0 && encoded.length > 0) {
    storage.removeItem(storageKey(documentKey));
    return null;
  }
  return snapshot;
}

export function removeCollaborativeSnapshot(documentKey: string): void {
  const storage = getLocalStorage();
  if (!storage) return;
  storage.removeItem(storageKey(documentKey));
  storage.removeItem(epochStorageKey(documentKey));
}
