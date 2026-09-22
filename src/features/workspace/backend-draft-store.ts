import { STORAGE_KEYS } from "../../shared/storage-keys";
import type { BackendDocDraft } from "./backend-doc-drafts";
import { withStorageTransaction } from "./storage-transaction";

type StorageArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
};
type DraftPatch = Pick<BackendDocDraft, "title" | "markdown" | "content">;

export function createBackendDraftStore(storage: StorageArea, legacySession?: StorageArea) {
  const keyFor = (workspaceId: string, itemId: string) =>
    `${STORAGE_KEYS.BACKEND_DOC_DRAFTS}:${encodeURIComponent(workspaceId)}:${encodeURIComponent(itemId)}`;

  async function read(workspaceId: string, itemId: string): Promise<BackendDocDraft | null> {
    const key = keyFor(workspaceId, itemId);
    const stored = await storage.get(key);
    // A null tombstone prevents a previously acknowledged v1 draft resurrecting.
    if (stored[key] !== undefined) return stored[key] as BackendDocDraft | null;
    const sources = await Promise.all([storage, ...(legacySession ? [legacySession] : [])]
      .map((area) => area.get(STORAGE_KEYS.BACKEND_DOC_DRAFTS)));
    let draft: BackendDocDraft | null = null;
    for (const source of sources) {
      const candidate = (source[STORAGE_KEYS.BACKEND_DOC_DRAFTS] as Record<string, BackendDocDraft> | undefined)
        ?.[`${workspaceId}::${itemId}`];
      if (candidate && (!draft || candidate.seq > draft.seq)) draft = candidate;
    }
    return draft;
  }

  return {
    getRecovery: async (workspaceId: string, itemId: string) => {
      const key = `${keyFor(workspaceId, itemId)}:recovery`;
      return (await storage.get(key))[key] as BackendDocDraft | undefined;
    },
    preserveRecovery: async (draft: BackendDocDraft) => {
      const key = `${keyFor(draft.workspaceId, draft.itemId)}:recovery`;
      await storage.set({ [key]: draft });
    },
    get: (workspaceId: string, itemId: string) =>
      withStorageTransaction(keyFor(workspaceId, itemId), () => read(workspaceId, itemId)),
    upsert: (workspaceId: string, itemId: string, patch: DraftPatch, baseRevision?: number) =>
      withStorageTransaction(keyFor(workspaceId, itemId), async () => {
        const previous = await read(workspaceId, itemId);
        const draft: BackendDocDraft = {
          ...previous,
          ...patch,
          workspaceId,
          itemId,
          seq: Math.max(Date.now(), previous?.seq ?? 0) + 1,
          updatedAt: new Date().toISOString(),
          baseRevision: baseRevision ?? previous?.baseRevision,
        };
        await storage.set({ [keyFor(workspaceId, itemId)]: draft });
        return draft;
      }),
    remove: (workspaceId: string, itemId: string, acknowledgedSeq: number) =>
      withStorageTransaction(keyFor(workspaceId, itemId), async () => {
        const current = await read(workspaceId, itemId);
        if (!current || current.seq > acknowledgedSeq) return false;
        await storage.set({ [keyFor(workspaceId, itemId)]: null });
        return true;
      }),
  };
}
