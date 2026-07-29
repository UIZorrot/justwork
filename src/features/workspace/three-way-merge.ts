export type ThreeWayMergeResult<T> = {
  value: T;
  conflicts: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function syncValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => syncValuesEqual(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return syncValuesEqual(leftKeys, rightKeys) && leftKeys.every((key) => syncValuesEqual(left[key], right[key]));
  }
  return false;
}

function stableIdArray(value: unknown[]): value is Array<Record<string, unknown> & { id: string }> {
  const ids = new Set<string>();
  return value.every((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)) return false;
    ids.add(entry.id);
    return true;
  });
}

function mergeArray(base: unknown[], local: unknown[], remote: unknown[], path: string): ThreeWayMergeResult<unknown[]> {
  if (!stableIdArray(base) || !stableIdArray(local) || !stableIdArray(remote)) {
    return { value: remote, conflicts: [path] };
  }
  const baseIds = base.map((entry) => entry.id);
  const localIds = local.map((entry) => entry.id);
  const remoteIds = remote.map((entry) => entry.id);
  let order: string[];
  if (syncValuesEqual(localIds, remoteIds)) order = localIds;
  else if (syncValuesEqual(localIds, baseIds)) order = remoteIds;
  else if (syncValuesEqual(remoteIds, baseIds)) order = localIds;
  else return { value: remote, conflicts: [`${path}.$order`] };

  const baseById = new Map(base.map((entry) => [entry.id, entry]));
  const localById = new Map(local.map((entry) => [entry.id, entry]));
  const remoteById = new Map(remote.map((entry) => [entry.id, entry]));
  const merged: unknown[] = [];
  const conflicts: string[] = [];
  for (const id of order) {
    const baseEntry = baseById.get(id);
    const localEntry = localById.get(id);
    const remoteEntry = remoteById.get(id);
    if (localEntry === undefined || remoteEntry === undefined) {
      const changedSide = localEntry ?? remoteEntry;
      if (baseEntry === undefined || syncValuesEqual(changedSide, baseEntry)) continue;
      conflicts.push(`${path}.${id}`);
      if (remoteEntry !== undefined) merged.push(remoteEntry);
      continue;
    }
    const result = mergeSyncValue(baseEntry, localEntry, remoteEntry, `${path}.${id}`);
    merged.push(result.value);
    conflicts.push(...result.conflicts);
  }
  return { value: merged, conflicts };
}

function mergeRecord(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  path: string,
): ThreeWayMergeResult<Record<string, unknown>> {
  const merged: Record<string, unknown> = {};
  const conflicts: string[] = [];
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  for (const key of keys) {
    const childPath = path ? `${path}.${key}` : key;
    const hasBase = Object.hasOwn(base, key);
    const hasLocal = Object.hasOwn(local, key);
    const hasRemote = Object.hasOwn(remote, key);
    if (!hasLocal || !hasRemote) {
      if (!hasLocal && !hasRemote) continue;
      const surviving = hasLocal ? local[key] : remote[key];
      if (!hasBase || syncValuesEqual(surviving, base[key])) continue;
      conflicts.push(childPath);
      if (hasRemote) merged[key] = remote[key];
      continue;
    }
    const result = mergeSyncValue(hasBase ? base[key] : undefined, local[key], remote[key], childPath);
    merged[key] = result.value;
    conflicts.push(...result.conflicts);
  }
  return { value: merged, conflicts };
}

export function mergeSyncValue<T>(base: T, local: T, remote: T, path = "value"): ThreeWayMergeResult<T> {
  if (syncValuesEqual(local, remote)) return { value: local, conflicts: [] };
  if (syncValuesEqual(local, base)) return { value: remote, conflicts: [] };
  if (syncValuesEqual(remote, base)) return { value: local, conflicts: [] };
  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
    return mergeArray(base, local, remote, path) as ThreeWayMergeResult<T>;
  }
  if (isRecord(base) && isRecord(local) && isRecord(remote)) {
    return mergeRecord(base, local, remote, path) as ThreeWayMergeResult<T>;
  }
  return { value: remote, conflicts: [path] };
}
