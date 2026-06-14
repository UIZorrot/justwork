import type { WorkspaceDoc, WorkspaceDocContent, WorkspaceDocsState } from "@/shared/storage-keys";

export type WorkspaceOperationKind = "edit" | "trash" | "restore" | "hard-delete";

export type WorkspaceOperationPatch = {
  title?: string;
  markdown?: string;
  content?: WorkspaceDocContent | null;
};

export type WorkspaceOperation = {
  id: string;
  workspaceId: string;
  itemId: string;
  kind: WorkspaceOperationKind;
  patch?: WorkspaceOperationPatch;
  baseRevision?: number;
  localSeq: number;
  createdAt: string;
};

export type WorkspaceOperationReplayResult = {
  state: WorkspaceDocsState;
  operations: WorkspaceOperation[];
};

function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortOperations(operations: WorkspaceOperation[]): WorkspaceOperation[] {
  return [...operations].sort((a, b) => {
    if (a.localSeq !== b.localSeq) return a.localSeq - b.localSeq;
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

function isRemoteNewerThanEdit(doc: WorkspaceDoc, operation: WorkspaceOperation): boolean {
  if (typeof operation.baseRevision !== "number") return false;
  if (doc.revision <= operation.baseRevision) return false;
  return timestampMs(doc.updatedAt) > timestampMs(operation.createdAt);
}

function isDeleteOperationConfirmed(doc: WorkspaceDoc | undefined, operation: WorkspaceOperation): boolean {
  if (operation.kind === "trash") return !doc || doc.inTrash;
  if (operation.kind === "restore") return Boolean(doc && !doc.inTrash);
  if (operation.kind === "hard-delete") return !doc;
  return false;
}

function replayEdit(
  state: WorkspaceDocsState,
  operation: WorkspaceOperation,
): WorkspaceOperationReplayResult {
  const current = state.docs.find((doc) => doc.id === operation.itemId);
  if (!current || isRemoteNewerThanEdit(current, operation)) {
    return { state, operations: [] };
  }
  const patch = operation.patch ?? {};
  const nextDoc: WorkspaceDoc = {
    ...current,
    title: patch.title ?? current.title,
    markdown: patch.markdown ?? current.markdown,
    content: patch.content ?? current.content ?? null,
    updatedAt: timestampMs(operation.createdAt) >= timestampMs(current.updatedAt)
      ? operation.createdAt
      : current.updatedAt,
  };
  return {
    state: {
      ...state,
      docs: state.docs.map((doc) => (doc.id === operation.itemId ? nextDoc : doc)),
    },
    operations: [operation],
  };
}

function replayDelete(
  state: WorkspaceDocsState,
  operation: WorkspaceOperation,
): WorkspaceOperationReplayResult {
  const current = state.docs.find((doc) => doc.id === operation.itemId);
  if (isDeleteOperationConfirmed(current, operation)) {
    return { state, operations: [] };
  }
  const affected = collectAffectedIds(state.docs, operation.itemId);
  if (operation.kind === "hard-delete") {
    return {
      state: {
        ...state,
        docs: state.docs.filter((doc) => !affected.has(doc.id)),
      },
      operations: [operation],
    };
  }
  const inTrash = operation.kind === "trash";
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
    operations: [operation],
  };
}

export function applyWorkspaceOperationJournal(
  state: WorkspaceDocsState,
  operations: WorkspaceOperation[],
): WorkspaceOperationReplayResult {
  let nextState = {
    ...state,
    docs: state.docs.map((doc) => ({ ...doc })),
  };
  const retained: WorkspaceOperation[] = [];
  for (const operation of sortOperations(operations)) {
    const result = operation.kind === "edit"
      ? replayEdit(nextState, operation)
      : replayDelete(nextState, operation);
    nextState = result.state;
    retained.push(...result.operations);
  }
  return {
    state: nextState,
    operations: retained,
  };
}
