import type { OfflineMutationPatch } from "./offline-queue";

export type ConflictRetryPatch = OfflineMutationPatch & {
  expectedRevision: number;
};

function timestampMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function shouldRetryLocalPatchAfterConflict(localUpdatedAt: string | undefined, remoteUpdatedAt: string | undefined): boolean {
  return timestampMs(localUpdatedAt) >= timestampMs(remoteUpdatedAt);
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
