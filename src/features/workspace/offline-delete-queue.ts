import { STORAGE_KEYS } from "../../shared/storage-keys";
import type { OfflineQueueStorage } from "./offline-queue";
import type { WorkspaceDoc, WorkspaceDocsState } from "../../shared/storage-keys";

export type OfflineDeleteMutationKind = "trash" | "restore" | "hard-delete";

export type OfflineDeleteMutation = {
  id: string;
  workspaceId: string;
  itemId: string;
  kind: OfflineDeleteMutationKind;
  createdAt: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOfflineDeleteMutation(value: unknown): value is OfflineDeleteMutation {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.itemId === "string" &&
    (value.kind === "trash" || value.kind === "restore" || value.kind === "hard-delete") &&
    typeof value.createdAt === "string"
  );
}

export async function loadOfflineDeleteMutations(storage: OfflineQueueStorage): Promise<OfflineDeleteMutation[]> {
  const data = await storage.get(STORAGE_KEYS.OFFLINE_DELETE_MUTATION_QUEUE);
  const raw = data[STORAGE_KEYS.OFFLINE_DELETE_MUTATION_QUEUE];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isOfflineDeleteMutation);
}

async function saveOfflineDeleteMutations(
  storage: OfflineQueueStorage,
  mutations: OfflineDeleteMutation[],
): Promise<void> {
  await storage.set({ [STORAGE_KEYS.OFFLINE_DELETE_MUTATION_QUEUE]: mutations });
}

export function mergeOfflineDeleteMutation(
  current: OfflineDeleteMutation[],
  next: OfflineDeleteMutation,
): OfflineDeleteMutation[] {
  const nextEntries = current.filter(
    (entry) => !(entry.workspaceId === next.workspaceId && entry.itemId === next.itemId),
  );
  return [...nextEntries, next];
}

export async function enqueueOfflineDeleteMutation(
  storage: OfflineQueueStorage,
  mutation: OfflineDeleteMutation,
): Promise<OfflineDeleteMutation[]> {
  const current = await loadOfflineDeleteMutations(storage);
  const next = mergeOfflineDeleteMutation(current, mutation);
  await saveOfflineDeleteMutations(storage, next);
  return next;
}

export async function removeOfflineDeleteMutation(
  storage: OfflineQueueStorage,
  mutationId: string,
): Promise<OfflineDeleteMutation[]> {
  const current = await loadOfflineDeleteMutations(storage);
  const next = current.filter((entry) => entry.id !== mutationId);
  await saveOfflineDeleteMutations(storage, next);
  return next;
}

function collectAffectedIds(docs: WorkspaceDoc[], itemId: string): Set<string> {
  const affected = new Set<string>([itemId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const doc of docs) {
      if (!doc.parentId || affected.has(doc.id) || !affected.has(doc.parentId)) continue;
      affected.add(doc.id);
      changed = true;
    }
  }
  return affected;
}

export function applyOfflineDeleteMutationsToDocs(
  state: WorkspaceDocsState,
  mutations: OfflineDeleteMutation[],
): WorkspaceDocsState {
  let nextDocs = state.docs.map((doc) => ({ ...doc }));
  for (const mutation of mutations) {
    const affected = collectAffectedIds(nextDocs, mutation.itemId);
    if (mutation.kind === "hard-delete") {
      nextDocs = nextDocs.filter((doc) => !affected.has(doc.id));
      continue;
    }
    if (mutation.kind === "restore") {
      nextDocs = nextDocs.map((doc) => (
        affected.has(doc.id)
          ? {
              ...doc,
              inTrash: false,
            }
          : doc
      ));
      continue;
    }
    nextDocs = nextDocs.map((doc) => (
      affected.has(doc.id)
        ? {
            ...doc,
            inTrash: true,
            pinned: false,
          }
        : doc
    ));
  }
  return {
    ...state,
    docs: nextDocs,
  };
}
