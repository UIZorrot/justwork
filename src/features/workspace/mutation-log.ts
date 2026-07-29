import { STORAGE_KEYS, type WorkspaceDoc, type WorkspaceDocContent, type WorkspaceDocsState } from "../../shared/storage-keys";

export type WorkspaceMutationKind =
  | "create"
  | "edit"
  | "move"
  | "pin"
  | "trash"
  | "restore"
  | "hard-delete";
export type WorkspaceMutationStatus = "pending" | "flushing" | "conflicted" | "failed";

export type WorkspaceMutationPatch = {
  title?: string;
  markdown?: string;
  content?: WorkspaceDocContent | null;
  parentId?: string | null;
  orderKey?: number;
  pinned?: boolean;
};

export type WorkspaceMutation = {
  id: string;
  workspaceId: string;
  itemId: string;
  kind: WorkspaceMutationKind;
  status: WorkspaceMutationStatus;
  doc?: WorkspaceDoc;
  patch?: WorkspaceMutationPatch;
  base?: WorkspaceMutationPatch;
  baseRevision?: number;
  clientSeq: number;
  createdAt: string;
  lastError?: string;
};

export type WorkspaceMutationReplayResult = {
  state: WorkspaceDocsState;
  mutations: WorkspaceMutation[];
};

export type WorkspaceMutationLogStorage = {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortMutations(mutations: WorkspaceMutation[]): WorkspaceMutation[] {
  return [...mutations].sort((a, b) => {
    if (a.clientSeq !== b.clientSeq) return a.clientSeq - b.clientSeq;
    return timestampMs(a.createdAt) - timestampMs(b.createdAt);
  });
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

function isDeleteMutationConfirmed(doc: WorkspaceDoc | undefined, mutation: WorkspaceMutation): boolean {
  if (mutation.kind === "trash") return !doc || doc.inTrash;
  if (mutation.kind === "restore") return Boolean(doc && !doc.inTrash);
  if (mutation.kind === "hard-delete") return !doc;
  return false;
}

function isPatchConfirmed(doc: WorkspaceDoc, mutation: WorkspaceMutation): boolean {
  const patch = mutation.patch ?? {};
  if (mutation.kind === "move") return patch.parentId === doc.parentId;
  if (mutation.kind === "pin") return patch.pinned === doc.pinned;
  return false;
}

function replayPatch(
  state: WorkspaceDocsState,
  mutation: WorkspaceMutation,
): WorkspaceMutationReplayResult {
  const current = state.docs.find((doc) => doc.id === mutation.itemId);
  if (!current || isPatchConfirmed(current, mutation)) {
    return { state, mutations: [] };
  }
  const patch = mutation.patch ?? {};
  const nextDoc: WorkspaceDoc = {
    ...current,
    title: patch.title ?? current.title,
    markdown: patch.markdown ?? current.markdown,
    content: patch.content ?? current.content ?? null,
    parentId: patch.parentId === undefined ? current.parentId : patch.parentId,
    orderKey: patch.orderKey ?? current.orderKey,
    pinned: patch.pinned ?? current.pinned,
    // Keep the revision the pending operation was authored against. Adopting
    // the server's newer revision here would bypass conflict detection later.
    revision: mutation.baseRevision === undefined ? current.revision : mutation.baseRevision,
    updatedAt: timestampMs(mutation.createdAt) >= timestampMs(current.updatedAt)
      ? mutation.createdAt
      : current.updatedAt,
  };
  return {
    state: {
      ...state,
      docs: state.docs.map((doc) => (doc.id === mutation.itemId ? nextDoc : doc)),
    },
    mutations: [mutation],
  };
}

function replayCreate(
  state: WorkspaceDocsState,
  mutation: WorkspaceMutation,
): WorkspaceMutationReplayResult {
  const current = state.docs.find((doc) => doc.id === mutation.itemId);
  if (current) {
    return { state, mutations: [] };
  }
  if (!mutation.doc) {
    return { state, mutations: [] };
  }
  const doc = { ...mutation.doc };
  return {
    state: {
      ...state,
      activeDocId: doc.inTrash ? state.activeDocId : doc.id,
      docs: [...state.docs, doc],
    },
    mutations: [mutation],
  };
}

function replayDelete(
  state: WorkspaceDocsState,
  mutation: WorkspaceMutation,
): WorkspaceMutationReplayResult {
  const current = state.docs.find((doc) => doc.id === mutation.itemId);
  if (isDeleteMutationConfirmed(current, mutation)) {
    return { state, mutations: [] };
  }
  const affected = collectAffectedIds(state.docs, mutation.itemId);
  if (mutation.kind === "hard-delete") {
    return {
      state: {
        ...state,
        docs: state.docs.filter((doc) => !affected.has(doc.id)),
      },
      mutations: [mutation],
    };
  }
  const inTrash = mutation.kind === "trash";
  return {
    state: {
      ...state,
      docs: state.docs.map((doc) => (
        affected.has(doc.id)
          ? {
              ...doc,
              inTrash,
              pinned: inTrash ? false : doc.pinned,
            }
          : doc
      )),
    },
    mutations: [mutation],
  };
}

export function enqueueWorkspaceMutation(
  current: WorkspaceMutation[],
  next: WorkspaceMutation,
): WorkspaceMutation[] {
  if (next.kind === "edit" || next.kind === "move" || next.kind === "pin") {
    const existing = current.find((entry) => (
      entry.workspaceId === next.workspaceId &&
      entry.itemId === next.itemId &&
      entry.kind === next.kind
    ));
    if (!existing) return [...current, next];
    return current.map((entry) => (
      entry.id === existing.id
        ? {
            ...entry,
            status: next.status,
            patch: {
              ...(entry.patch ?? {}),
              ...(next.patch ?? {}),
            },
            id: next.kind === "edit" ? entry.id : next.id,
            clientSeq: next.clientSeq,
            createdAt: next.createdAt,
            lastError: next.lastError,
          }
        : entry
    ));
  }

  if (next.kind === "trash" || next.kind === "restore" || next.kind === "hard-delete") {
    return [
      ...current.filter((entry) => !(entry.workspaceId === next.workspaceId && entry.itemId === next.itemId)),
      next,
    ];
  }

  return [
    ...current.filter((entry) => !(entry.workspaceId === next.workspaceId && entry.itemId === next.itemId && entry.kind === "create")),
    next,
  ];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkspaceMutation(value: unknown): value is WorkspaceMutation {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.itemId === "string" &&
    (
      value.kind === "create" ||
      value.kind === "edit" ||
      value.kind === "move" ||
      value.kind === "pin" ||
      value.kind === "trash" ||
      value.kind === "restore" ||
      value.kind === "hard-delete"
    ) &&
    (
      value.status === "pending" ||
      value.status === "flushing" ||
      value.status === "conflicted" ||
      value.status === "failed"
    ) &&
    typeof value.clientSeq === "number" &&
    typeof value.createdAt === "string"
  );
}

async function saveWorkspaceMutationLog(
  storage: WorkspaceMutationLogStorage,
  mutations: WorkspaceMutation[],
): Promise<void> {
  await storage.set({ [STORAGE_KEYS.WORKSPACE_MUTATION_LOG]: mutations });
}

const mutationLogWriteQueues = new WeakMap<object, Promise<void>>();

async function mutateStoredWorkspaceLog(
  storage: WorkspaceMutationLogStorage,
  mutate: (current: WorkspaceMutation[]) => WorkspaceMutation[],
): Promise<WorkspaceMutation[]> {
  let result: WorkspaceMutation[] = [];
  const previous = mutationLogWriteQueues.get(storage) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const stored = await loadWorkspaceMutationLog(storage);
      result = mutate(stored);
      await saveWorkspaceMutationLog(storage, result);
    });
  mutationLogWriteQueues.set(storage, current.catch(() => undefined));
  await current;
  return result;
}

export async function loadWorkspaceMutationLog(
  storage: WorkspaceMutationLogStorage,
  workspaceId?: string,
): Promise<WorkspaceMutation[]> {
  const data = await storage.get(STORAGE_KEYS.WORKSPACE_MUTATION_LOG);
  const raw = data[STORAGE_KEYS.WORKSPACE_MUTATION_LOG];
  const mutations = Array.isArray(raw) ? raw.filter(isWorkspaceMutation) : [];
  return workspaceId ? mutations.filter((entry) => entry.workspaceId === workspaceId) : mutations;
}

export async function enqueueStoredWorkspaceMutation(
  storage: WorkspaceMutationLogStorage,
  mutation: WorkspaceMutation,
): Promise<WorkspaceMutation[]> {
  return mutateStoredWorkspaceLog(storage, (current) => {
    const maxSeq = current.reduce((max, entry) => Math.max(max, entry.clientSeq), 0);
    const normalized = current.some((entry) => entry.id !== mutation.id && entry.clientSeq === mutation.clientSeq)
      ? { ...mutation, clientSeq: maxSeq + 1 }
      : mutation;
    return enqueueWorkspaceMutation(current, normalized);
  });
}

export async function removeStoredWorkspaceMutation(
  storage: WorkspaceMutationLogStorage,
  mutationId: string,
): Promise<WorkspaceMutation[]> {
  return mutateStoredWorkspaceLog(storage, (current) => current.filter((entry) => entry.id !== mutationId));
}

export async function clearStoredWorkspaceMutationsForWorkspace(
  storage: WorkspaceMutationLogStorage,
  workspaceId: string,
): Promise<WorkspaceMutation[]> {
  return mutateStoredWorkspaceLog(storage, (current) => current.filter((entry) => entry.workspaceId !== workspaceId));
}

export async function replaceStoredWorkspaceMutationLogForWorkspace(
  storage: WorkspaceMutationLogStorage,
  workspaceId: string,
  workspaceMutations: WorkspaceMutation[],
): Promise<WorkspaceMutation[]> {
  return mutateStoredWorkspaceLog(storage, (current) => [
    ...current.filter((entry) => entry.workspaceId !== workspaceId),
    ...workspaceMutations.filter((entry) => entry.workspaceId === workspaceId),
  ]);
}

export function applyWorkspaceMutationLog(
  state: WorkspaceDocsState,
  mutations: WorkspaceMutation[],
): WorkspaceMutationReplayResult {
  let nextState = {
    ...state,
    docs: state.docs.map((doc) => ({ ...doc })),
  };
  const retained: WorkspaceMutation[] = [];
  for (const mutation of sortMutations(mutations)) {
    const result = mutation.kind === "create"
      ? replayCreate(nextState, mutation)
      : mutation.kind === "edit" || mutation.kind === "move" || mutation.kind === "pin"
        ? replayPatch(nextState, mutation)
        : replayDelete(nextState, mutation);
    nextState = result.state;
    retained.push(...result.mutations);
  }
  return {
    state: nextState,
    mutations: retained,
  };
}
