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
