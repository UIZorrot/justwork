import { STORAGE_KEYS, type WorkspaceDocContent } from "../../shared/storage-keys";
import {
  clearStoredWorkspaceMutationsForWorkspace,
  enqueueStoredWorkspaceMutation,
  loadWorkspaceMutationLog,
  removeStoredWorkspaceMutation,
  type WorkspaceMutation,
} from "./mutation-log";

export type OfflineMutationPatch = {
  title?: string;
  markdown?: string;
  content?: WorkspaceDocContent | null;
};

export type OfflineMutation = {
  id: string;
  workspaceId: string;
  itemId: string;
  patch: OfflineMutationPatch;
  expectedRevision: number;
  createdAt: string;
};

export type OfflineQueueStorage = {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOfflineMutation(value: unknown): value is OfflineMutation {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.itemId === "string" &&
    isObject(value.patch) &&
    typeof value.expectedRevision === "number" &&
    typeof value.createdAt === "string"
  );
}

export async function loadOfflineMutations(storage: OfflineQueueStorage): Promise<OfflineMutation[]> {
  const data = await storage.get(STORAGE_KEYS.OFFLINE_MUTATION_QUEUE);
  const raw = data[STORAGE_KEYS.OFFLINE_MUTATION_QUEUE];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isOfflineMutation);
}

async function saveOfflineMutations(storage: OfflineQueueStorage, mutations: OfflineMutation[]): Promise<void> {
  await storage.set({ [STORAGE_KEYS.OFFLINE_MUTATION_QUEUE]: mutations });
}

function nextClientSeq(mutations: WorkspaceMutation[]): number {
  return mutations.reduce((max, mutation) => Math.max(max, mutation.clientSeq), 0) + 1;
}

async function mirrorOfflineMutationToWorkspaceLog(
  storage: OfflineQueueStorage,
  current: OfflineMutation[],
  mutation: OfflineMutation,
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
    kind: "edit",
    status: "pending",
    patch: mutation.patch,
    baseRevision: mutation.expectedRevision,
    clientSeq: nextClientSeq(mutations),
    createdAt: mutation.createdAt,
  });
}

export function mergeOfflineMutation(current: OfflineMutation[], next: OfflineMutation): OfflineMutation[] {
  const existingIndex = current.findIndex(
    (entry) => entry.workspaceId === next.workspaceId && entry.itemId === next.itemId,
  );
  if (existingIndex === -1) return [...current, next];

  const existing = current[existingIndex]!;
  const merged: OfflineMutation = {
    ...existing,
    id: next.id,
    patch: {
      ...existing.patch,
      ...next.patch,
    },
    createdAt: next.createdAt,
  };
  return current.map((entry, index) => (index === existingIndex ? merged : entry));
}

export async function enqueueOfflineMutation(
  storage: OfflineQueueStorage,
  mutation: OfflineMutation,
): Promise<OfflineMutation[]> {
  const current = await loadOfflineMutations(storage);
  const next = mergeOfflineMutation(current, mutation);
  await saveOfflineMutations(storage, next);
  await mirrorOfflineMutationToWorkspaceLog(storage, current, mutation);
  return next;
}

export async function removeOfflineMutation(
  storage: OfflineQueueStorage,
  mutationId: string,
): Promise<OfflineMutation[]> {
  const current = await loadOfflineMutations(storage);
  const next = current.filter((entry) => entry.id !== mutationId);
  await saveOfflineMutations(storage, next);
  await removeStoredWorkspaceMutation(storage, mutationId);
  return next;
}

export async function clearOfflineMutationsForWorkspace(
  storage: OfflineQueueStorage,
  workspaceId: string,
): Promise<OfflineMutation[]> {
  const current = await loadOfflineMutations(storage);
  const next = current.filter((entry) => entry.workspaceId !== workspaceId);
  await saveOfflineMutations(storage, next);
  await clearStoredWorkspaceMutationsForWorkspace(storage, workspaceId);
  return next;
}
