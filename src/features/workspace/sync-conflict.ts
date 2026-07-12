import type { OfflineMutationPatch } from "./offline-queue";
import { resolveWorkspaceMutationConflict } from "./mutation-log";

export type ConflictRetryPatch = OfflineMutationPatch & {
  expectedRevision: number;
};

export function shouldRetryLocalPatchAfterConflict(localUpdatedAt: string | undefined, remoteUpdatedAt: string | undefined): boolean {
  return resolveWorkspaceMutationConflict(
    { createdAt: localUpdatedAt ?? "" },
    { updatedAt: remoteUpdatedAt ?? "" },
  ).action === "retry-local";
}

export function buildLocalFirstConflictRetryPatch(
  patch: OfflineMutationPatch,
  remoteRevision: number,
): ConflictRetryPatch {
  return {
    ...patch,
    expectedRevision: remoteRevision,
  };
}
