import type { WorkspaceDoc, WorkspaceDocsState } from "@/shared/storage-keys";

function collectTrashedIds(docs: WorkspaceDoc[], itemId: string): Set<string> {
  const trashedIds = new Set<string>([itemId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const doc of docs) {
      if (!doc.parentId || trashedIds.has(doc.id) || !trashedIds.has(doc.parentId)) continue;
      trashedIds.add(doc.id);
      changed = true;
    }
  }
  return trashedIds;
}

function nextActiveDocId(docs: WorkspaceDoc[], previousActiveId: string, trashedIds: Set<string>): string {
  if (!trashedIds.has(previousActiveId)) return previousActiveId;
  return docs.find((doc) => !doc.inTrash && !trashedIds.has(doc.id))?.id ?? previousActiveId;
}

export function applyOptimisticTrashState(
  state: WorkspaceDocsState,
  itemId: string,
  updatedAt: string,
): WorkspaceDocsState {
  const trashedIds = collectTrashedIds(state.docs, itemId);
  const docs = state.docs.map((doc) => (
    trashedIds.has(doc.id)
      ? {
          ...doc,
          inTrash: true,
          pinned: false,
          revision: doc.revision,
          updatedAt,
        }
      : doc
  ));
  return {
    ...state,
    docs,
    activeDocId: nextActiveDocId(state.docs, state.activeDocId, trashedIds),
  };
}

export function applyOptimisticRestoreState(
  state: WorkspaceDocsState,
  itemId: string,
  updatedAt: string,
): WorkspaceDocsState {
  const restoredIds = collectTrashedIds(state.docs, itemId);
  return {
    ...state,
    docs: state.docs.map((doc) => (
      restoredIds.has(doc.id)
        ? {
            ...doc,
            inTrash: false,
            revision: doc.revision,
            updatedAt,
          }
        : doc
    )),
  };
}
