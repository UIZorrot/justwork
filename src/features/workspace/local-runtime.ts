import type { RuntimeStorage } from "@justwork/workspace-runtime";
import { getLocalStorageArea } from "@/shared/browser-platform";

export function getBrowserLocalStorage(): Storage | undefined {
  return typeof globalThis.localStorage === "undefined" ? undefined : globalThis.localStorage;
}

export function createChromeRuntimeStorage(): RuntimeStorage {
  const storage = getLocalStorageArea();
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const raw = await storage.get(key);
      return raw[key] as T | undefined;
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      await storage.set({ [key]: value });
    },
    async remove(key: string): Promise<void> {
      await storage.remove(key);
    },
  };
}
