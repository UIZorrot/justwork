import type { WorkspaceDoc } from "@/shared/storage-keys";

const ORDER_STEP = 1024;

export function compareDocumentOrder(left: Pick<WorkspaceDoc, "orderKey" | "id">, right: Pick<WorkspaceDoc, "orderKey" | "id">): number {
  return left.orderKey - right.orderKey || left.id.localeCompare(right.id);
}

export function orderKeyForInsertion(
  docs: WorkspaceDoc[],
  parentId: string | null,
  beforeId: string | null,
  movingId?: string,
): number {
  const siblings = docs
    .filter((doc) => doc.parentId === parentId && doc.id !== movingId && !doc.inTrash)
    .sort(compareDocumentOrder);
  if (siblings.length === 0) return 0;
  if (beforeId === null) return siblings[siblings.length - 1]!.orderKey + ORDER_STEP;
  const index = siblings.findIndex((doc) => doc.id === beforeId);
  if (index <= 0) return (siblings[0]?.orderKey ?? 0) - ORDER_STEP;
  const previous = siblings[index - 1]!.orderKey;
  const next = siblings[index]!.orderKey;
  return previous + (next - previous) / 2;
}
