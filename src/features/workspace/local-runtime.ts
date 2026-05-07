import type { RuntimeStorage } from "@justwork/workspace-runtime";

export function createChromeRuntimeStorage(): RuntimeStorage {
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const raw = await chrome.storage.local.get(key);
      return raw[key] as T | undefined;
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      await chrome.storage.local.set({ [key]: value });
    },
    async remove(key: string): Promise<void> {
      await chrome.storage.local.remove(key);
    },
  };
}
