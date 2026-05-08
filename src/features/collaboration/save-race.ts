export type CollaborativeDocState = {
  title: string;
  markdown: string;
};

export type CollaborativeSaveRequest = {
  nextTitle: string;
  nextMarkdown: string;
};

export type CollaborativeSaveResolution = {
  shouldKeepDirty: boolean;
  shouldReseedSnapshot: boolean;
  retainedTitle: string | null;
  retainedMarkdown: string | null;
};

export function hasStaleCollaborativeSave(
  liveDoc: CollaborativeDocState | null | undefined,
  request: CollaborativeSaveRequest,
): boolean {
  if (!liveDoc) return true;
  return liveDoc.title !== request.nextTitle || liveDoc.markdown !== request.nextMarkdown;
}

export function reconcileCollaborativeSave(
  liveDoc: CollaborativeDocState | null | undefined,
  isStale: boolean,
  hasNewerDraft = false,
): CollaborativeSaveResolution {
  const shouldKeepDirty = isStale || hasNewerDraft;
  return {
    shouldKeepDirty,
    shouldReseedSnapshot: !shouldKeepDirty,
    retainedTitle: shouldKeepDirty ? liveDoc?.title ?? null : null,
    retainedMarkdown: shouldKeepDirty ? liveDoc?.markdown ?? null : null,
  };
}
