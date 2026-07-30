import type { WorkspaceDocsState } from "@/shared/storage-keys";

function updateDocInState(
  state: WorkspaceDocsState,
  itemId: string,
  update: (doc: WorkspaceDocsState["docs"][number]) => WorkspaceDocsState["docs"][number],
): WorkspaceDocsState {
  return {
    ...state,
    docs: state.docs.map((doc) => (doc.id === itemId ? update(doc) : doc)),
  };
}

export function applyOptimisticMove(
  state: WorkspaceDocsState,
  itemId: string,
  parentId: string | null,
  orderKey: number,
  updatedAt: string,
  orderRank?: string,
): WorkspaceDocsState {
  return updateDocInState(state, itemId, (doc) => ({
    ...doc,
    parentId,
    orderKey,
    orderRank: orderRank ?? doc.orderRank,
    revision: doc.revision,
    updatedAt,
  }));
}

export function applyOptimisticPinned(
  state: WorkspaceDocsState,
  itemId: string,
  pinned: boolean,
  updatedAt: string,
): WorkspaceDocsState {
  return updateDocInState(state, itemId, (doc) => ({
    ...doc,
    pinned,
    revision: doc.revision,
    updatedAt,
  }));
}
