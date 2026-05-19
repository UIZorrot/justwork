export type PendingDocSaveLike = {
  timer: number | undefined;
};

export function discardPendingDocSave<T extends PendingDocSaveLike>(
  pendingDocSaves: Map<string, T>,
  blockedItemIds: Set<string>,
  itemId: string,
  clearTimer: (timer: number) => void,
): void {
  const pending = pendingDocSaves.get(itemId);
  if (pending?.timer !== undefined) {
    clearTimer(pending.timer);
  }
  pendingDocSaves.delete(itemId);
  blockedItemIds.add(itemId);
}

export function releasePendingDocSaveBlock(blockedItemIds: Set<string>, itemId: string): void {
  blockedItemIds.delete(itemId);
}

export function shouldSkipDocSave(
  blockedItemIds: Set<string>,
  itemId: string,
  doc: { inTrash: boolean } | null | undefined,
): boolean {
  return blockedItemIds.has(itemId) || !doc || doc.inTrash;
}
