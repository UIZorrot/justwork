type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

type StorageAreaLike = {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

function getChromeStorageArea(area: "local" | "session"): StorageAreaLike | null {
  const chromeStorage = globalThis.chrome?.storage;
  if (!chromeStorage) return null;
  if (area === "session" && chromeStorage.session) return chromeStorage.session;
  if (area === "local" && chromeStorage.local) return chromeStorage.local;
  return null;
}

function createWebStorageArea(storage: StorageLike | undefined): StorageAreaLike {
  return {
    async get(keys) {
      if (!storage) return {};
      if (keys == null) return {};
      const names = Array.isArray(keys)
        ? keys
        : typeof keys === "string"
          ? [keys]
          : Object.keys(keys);
      const result: Record<string, unknown> = {};
      for (const name of names) {
        const raw = storage.getItem(name);
        if (raw == null) continue;
        try {
          result[name] = JSON.parse(raw);
        } catch {
          result[name] = raw;
        }
      }
      return result;
    },
    async set(items) {
      if (!storage) return;
      for (const [key, value] of Object.entries(items)) {
        storage.setItem(key, JSON.stringify(value));
      }
    },
    async remove(keys) {
      if (!storage) return;
      const names = Array.isArray(keys) ? keys : [keys];
      for (const name of names) {
        storage.removeItem(name);
      }
    },
  };
}

export function getLocalStorageArea(): StorageAreaLike {
  return getChromeStorageArea("local") ?? createWebStorageArea(globalThis.localStorage);
}

export function getSessionStorageArea(): StorageAreaLike {
  return getChromeStorageArea("session") ?? createWebStorageArea(globalThis.sessionStorage);
}

export function resolveWebRuntimeUrl(path: string, baseUrl: string): string {
  return new URL(path.replace(/^\/+/, ""), baseUrl).toString();
}

export function getRuntimeUrl(path: string): string {
  const normalizedPath = path.replace(/^\/+/, "");
  if (globalThis.chrome?.runtime?.getURL) {
    return globalThis.chrome.runtime.getURL(normalizedPath);
  }
  if (typeof globalThis.document !== "undefined") {
    // The hosted workbench is deployed below /app/. Resolving from the origin
    // incorrectly requests /vendor/... and prevents Vditor from loading Lute.
    return resolveWebRuntimeUrl(normalizedPath, globalThis.document.baseURI);
  }
  if (typeof globalThis.location !== "undefined") {
    return resolveWebRuntimeUrl(normalizedPath, `${globalThis.location.origin}/`);
  }
  return normalizedPath;
}

export async function sendRuntimeMessage(message: unknown): Promise<void> {
  if (globalThis.chrome?.runtime?.sendMessage) {
    await globalThis.chrome.runtime.sendMessage(message);
  }
}
