import type { WorkspaceDoc } from "@/shared/storage-keys";

export function overlayDirtyCollaborativeDocs(
  docs: WorkspaceDoc[],
  dirtyDocIds: Set<string>,
  localCollaborativeDocCache: Map<string, WorkspaceDoc>,
): WorkspaceDoc[] {
  return docs.map((doc) => {
    if (dirtyDocIds.has(doc.id)) return localCollaborativeDocCache.get(doc.id) ?? doc;
    return localCollaborativeDocCache.get(doc.id) ?? doc;
  });
}
