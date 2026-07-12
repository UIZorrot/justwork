import { STORAGE_KEYS } from "../../shared/storage-keys";
import type { OfflineQueueStorage } from "./offline-queue";
import type { WorkspaceDoc, WorkspaceDocsState } from "../../shared/storage-keys";
import {
  enqueueStoredWorkspaceMutation,
  loadWorkspaceMutationLog,
  removeStoredWorkspaceMutation,
  type WorkspaceMutation,
} from "./mutation-log";

export type OfflineDeleteMutationKind = "trash" | "restore" | "hard-delete";

export type OfflineDeleteMutation = {
  id: string;
  workspaceId: string;
  itemId: string;
  kind: OfflineDeleteMutationKind;
  expectedRevision?: number;
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
    (value.expectedRevision === undefined || typeof value.expectedRevision === "number") &&
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

function nextClientSeq(mutations: WorkspaceMutation[]): number {
  return mutations.reduce((max, mutation) => Math.max(max, mutation.clientSeq), 0) + 1;
}

async function mirrorOfflineDeleteMutationToWorkspaceLog(
  storage: OfflineQueueStorage,
  current: OfflineDeleteMutation[],
  mutation: OfflineDeleteMutation,
): Promise<void> {
  const existing = current.find((entry) => entry.workspaceId === mutation.workspaceId && entry.itemId === mutation.itemId);
  if (existing) {
    await removeStoredWorkspaceMutation(storage, existing.id);
  }
  const mutations = await loadWorkspaceMutationLog(storage);
  await enqueueStoredWorkspaceMutation(storage, {
    id: mutation.id,
    workspaceId: mutation.workspaceId,
    itemId: mutation.itemId,
    kind: mutation.kind,
    status: "pending",
    clientSeq: nextClientSeq(mutations),
    createdAt: mutation.createdAt,
  });
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
  await mirrorOfflineDeleteMutationToWorkspaceLog(storage, current, mutation);
  return next;
}

export async function removeOfflineDeleteMutation(
  storage: OfflineQueueStorage,
  mutationId: string,
): Promise<OfflineDeleteMutation[]> {
  const current = await loadOfflineDeleteMutations(storage);
  const next = current.filter((entry) => entry.id !== mutationId);
  await saveOfflineDeleteMutations(storage, next);
  await removeStoredWorkspaceMutation(storage, mutationId);
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
