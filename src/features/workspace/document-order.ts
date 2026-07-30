import type { WorkspaceDoc } from "@/shared/storage-keys";

const ORDER_STEP = 1024;
const MAX_ORDER_RANK = (1n << 128n) - 1n;
const ORDER_RANK_STEP = 1n << 64n;

function rankBase(rank: string | undefined): bigint | null {
  if (!rank || !/^[0-9a-f]{32}(?:~[A-Za-z0-9_-]+)?$/.test(rank)) return null;
  return BigInt(`0x${rank.slice(0, 32)}`);
}

function uniqueRankSuffix(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replaceAll("-", "");
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

export function compareDocumentOrder(
  left: Pick<WorkspaceDoc, "orderKey" | "orderRank" | "id">,
  right: Pick<WorkspaceDoc, "orderKey" | "orderRank" | "id">,
): number {
  if (left.orderRank && right.orderRank && left.orderRank !== right.orderRank) {
    return left.orderRank.localeCompare(right.orderRank);
  }
  return left.orderKey - right.orderKey || left.id.localeCompare(right.id);
}

export function orderRankForInsertion(
  docs: WorkspaceDoc[],
  parentId: string | null,
  beforeId: string | null,
  movingId?: string,
): string {
  const siblings = docs
    .filter((doc) => doc.parentId === parentId && doc.id !== movingId && !doc.inTrash)
    .sort(compareDocumentOrder);
  const index = beforeId === null ? siblings.length : Math.max(0, siblings.findIndex((doc) => doc.id === beforeId));
  const previous = index > 0 ? rankBase(siblings[index - 1]?.orderRank) ?? 0n : 0n;
  const next = index < siblings.length ? rankBase(siblings[index]?.orderRank) ?? MAX_ORDER_RANK : MAX_ORDER_RANK;
  let midpoint = index === siblings.length
    ? previous + ORDER_RANK_STEP
    : previous + (next - previous) / 2n;
  if (midpoint > MAX_ORDER_RANK) midpoint = MAX_ORDER_RANK;
  if (midpoint <= previous || midpoint >= next) {
    // Concurrent insertions can exhaust a single midpoint. The unique suffix
    // still provides deterministic convergence until a later normalization.
    midpoint = previous;
  }
  return `${midpoint.toString(16).padStart(32, "0")}~${uniqueRankSuffix()}`;
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
