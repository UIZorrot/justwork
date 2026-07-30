export function shouldResetCollaborativeLineage(
  activeEpoch: string | null | undefined,
  cachedEpoch: string | null | undefined,
  serverEpoch: string,
): boolean {
  const knownEpoch = activeEpoch ?? cachedEpoch;
  return Boolean(knownEpoch && knownEpoch !== serverEpoch);
}
