export type RuntimeStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
};

export const RUNTIME_STORAGE_KEYS = {
  IDENTITY: "justwork.identity.v1",
  WORKSPACE_META: "justwork.workspace.meta.v1",
  WORKSPACE_PAYLOAD: "justwork.workspace.payload.v1",
  LEGACY_DOCS: "justwork.docs.v1",
} as const;

export function createMemoryStorage(initial?: Record<string, unknown>): RuntimeStorage {
  const state = new Map<string, unknown>(Object.entries(initial ?? {}));
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return state.get(key) as T | undefined;
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      state.set(key, value);
    },
    async remove(key: string): Promise<void> {
      state.delete(key);
    },
  };
}
