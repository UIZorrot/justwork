import type { WorkspaceDoc } from "../../shared/storage-keys";
import type { OfflineMutationPatch } from "./offline-queue";

export type OptimisticCreatePatchStore = Map<string, OfflineMutationPatch>;

function clonePatch(patch: OfflineMutationPatch): OfflineMutationPatch {
  return {
    ...patch,
    content: patch.content === undefined ? undefined : JSON.parse(JSON.stringify(patch.content)),
  };
}

export function stageOptimisticCreatePatch(
  store: OptimisticCreatePatchStore,
  optimisticId: string,
  patch: OfflineMutationPatch,
): void {
  const existing = store.get(optimisticId);
  store.set(optimisticId, clonePatch({
    ...(existing ?? {}),
    ...patch,
  }));
}

export function clearOptimisticCreatePatch(
  store: OptimisticCreatePatchStore,
  optimisticId: string,
): void {
  store.delete(optimisticId);
}

export function promoteOptimisticCreateDoc(
  store: OptimisticCreatePatchStore,
  optimisticId: string,
  createdDoc: WorkspaceDoc,
): { doc: WorkspaceDoc; patch: OfflineMutationPatch | null } {
  const patch = store.get(optimisticId);
  store.delete(optimisticId);
  if (!patch) {
    return { doc: createdDoc, patch: null };
  }
  const clonedPatch = clonePatch(patch);
  return {
    doc: {
      ...createdDoc,
      title: clonedPatch.title ?? createdDoc.title,
      markdown: clonedPatch.markdown ?? createdDoc.markdown,
      content: clonedPatch.content ?? createdDoc.content ?? null,
    },
    patch: clonedPatch,
  };
}
