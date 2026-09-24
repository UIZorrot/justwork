import type { WorkspaceDoc, WorkspaceDocContent } from "../../shared/storage-keys";

export type BackendDocDraft = {
  workspaceId: string;
  itemId: string;
  markdown?: string;
  title?: string;
  content?: WorkspaceDocContent | null;
  seq: number;
  updatedAt: string;
  baseRevision?: number;
};

export function shouldApplyBackendDocDraft(doc: WorkspaceDoc, draft: BackendDocDraft): boolean {
  if (typeof draft.baseRevision === "number") {
    return draft.baseRevision >= (doc.revision ?? 0);
  }
  if (draft.updatedAt && doc.updatedAt) {
    return draft.updatedAt >= doc.updatedAt;
  }
  return true;
}

export function applyBackendDocDraft(doc: WorkspaceDoc, draft: BackendDocDraft): WorkspaceDoc {
  if (!shouldApplyBackendDocDraft(doc, draft)) {
    return doc;
  }
  return {
    ...doc,
    title: draft.title ?? doc.title,
    markdown: draft.markdown ?? doc.markdown,
    content: draft.content ?? doc.content ?? null,
  };
}

export type DraftSavePatch = {
  title?: unknown;
  markdown?: unknown;
  content?: unknown;
};

/**
 * After a save completes, decide whether a remaining draft means the user kept
 * editing. Only compare fields that were part of the in-flight patch — leftover
 * draft fields from earlier edits must not keep the doc sticky-dirty forever.
 */
export function draftIndicatesNewerLocalEdit(
  draft: BackendDocDraft | null,
  submittedSeq: number,
  patch: DraftSavePatch,
  submitted: {
    title: string;
    markdown: string;
    content?: WorkspaceDocContent | null;
  },
  valuesEqual: (left: unknown, right: unknown) => boolean,
): boolean {
  if (!draft) return false;
  if (draft.seq > submittedSeq) return true;
  if (patch.title !== undefined && draft.title !== undefined && draft.title !== submitted.title) {
    return true;
  }
  if (patch.markdown !== undefined && draft.markdown !== undefined && draft.markdown !== submitted.markdown) {
    return true;
  }
  if (
    patch.content !== undefined
    && draft.content !== undefined
    && !valuesEqual(draft.content, submitted.content)
  ) {
    return true;
  }
  return false;
}
