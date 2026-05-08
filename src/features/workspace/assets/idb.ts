import type { WorkspaceAssetBackend, WorkspaceImageAssetRecord } from "./types";

const DB_VERSION = 1;
const STORE_NAME = "assets";

function openDatabase(name: string): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("indexedDB is not available"));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("failed to open indexedDB"));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function txComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("indexedDB transaction aborted"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
    request.onsuccess = () => resolve(request.result);
  });
}

export async function createIndexedDbWorkspaceAssetBackend(name: string): Promise<WorkspaceAssetBackend> {
  const db = await openDatabase(name);

  return {
    async get(key: string) {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const record = await requestResult(store.get(key));
      await txComplete(tx);
      return (record as WorkspaceImageAssetRecord | undefined) ? { ...(record as WorkspaceImageAssetRecord), meta: { ...(record as WorkspaceImageAssetRecord).meta }, bytes: (record as WorkspaceImageAssetRecord).bytes.slice(0) } : undefined;
    },
    async set(key: string, record: WorkspaceImageAssetRecord) {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put({ ...record, meta: { ...record.meta }, bytes: record.bytes.slice(0) }, key);
      await txComplete(tx);
    },
    async delete(key: string) {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key);
      await txComplete(tx);
    },
    async listKeys(prefix: string) {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const keys: string[] = [];
      const request = store.openKeyCursor();
      await new Promise<void>((resolve, reject) => {
        request.onerror = () => reject(request.error ?? new Error("indexedDB cursor failed"));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          const key = String(cursor.key);
          if (key.startsWith(prefix)) keys.push(key);
          cursor.continue();
        };
      });
      await txComplete(tx);
      return keys;
    },
  };
}

