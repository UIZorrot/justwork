import type { WorkspaceDocContent } from "../../shared/storage-keys";

export type CollaborativeDocState = {
  title: string;
  markdown: string;
  content?: WorkspaceDocContent | null;
};

export type CollaborativeSaveRequest = {
  nextTitle: string;
  nextMarkdown: string;
  content?: WorkspaceDocContent | null;
};

export type CollaborativeSaveResolution = {
  shouldKeepDirty: boolean;
  shouldReseedSnapshot: boolean;
  retainedTitle: string | null;
  retainedMarkdown: string | null;
  retainedContent: WorkspaceDocContent | null;
};

export function resolveSaveMutationId(
  pendingMutationId: string | undefined,
  createMutationId: () => string,
): string {
  return pendingMutationId ?? createMutationId();
}

export function hasNewerLocalEditGeneration(requestGeneration: number, currentGeneration: number): boolean {
  return currentGeneration > requestGeneration;
}

function stableContentKey(content: WorkspaceDocContent | null | undefined): string {
  return JSON.stringify(content ?? null);
}

export function hasStaleCollaborativeSave(
  liveDoc: CollaborativeDocState | null | undefined,
  request: CollaborativeSaveRequest,
): boolean {
  if (!liveDoc) return true;
  return (
    liveDoc.title !== request.nextTitle ||
    liveDoc.markdown !== request.nextMarkdown ||
    stableContentKey(liveDoc.content) !== stableContentKey(request.content)
  );
}

export function hasUnexpectedCollaborativeSaveResult(
  savedDoc: CollaborativeDocState | null | undefined,
  request: CollaborativeSaveRequest,
  options: { ignoreMarkdown?: boolean; ignoreTitle?: boolean } = {},
): boolean {
  if (!savedDoc) return true;
  return (
    (!options.ignoreTitle && savedDoc.title !== request.nextTitle) ||
    (!options.ignoreMarkdown && savedDoc.markdown !== request.nextMarkdown) ||
    (
      request.content !== undefined &&
      stableContentKey(savedDoc.content) !== stableContentKey(request.content)
    )
  );
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
    retainedContent: shouldKeepDirty ? liveDoc?.content ?? null : null,
  };
}
