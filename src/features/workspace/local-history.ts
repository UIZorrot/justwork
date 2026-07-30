import type { OfflineMutationPatch } from "@/features/workspace/offline-queue";
import type { WorkspaceDocContent } from "@/shared/storage-keys";

const LOCAL_HISTORY_STORAGE_PREFIX = "justwork.workspace.localHistory.v1";
export const LOCAL_HISTORY_MAX_EVENTS = 200;

export type LocalHistoryOp =
  | "workspace.item.set"
  | "workspace.item.create"
  | "workspace.item.move"
  | "workspace.item.pin"
  | "workspace.item.trash"
  | "workspace.item.restore"
  | "workspace.item.hard_delete"
  | "workspace.settings"
  | "workspace.member.profile"
  | "workspace.member.join"
  | "doc.patch"
  | "history.revert";

export type LocalHistorySnapshot = {
  title?: string;
  markdown?: string;
  content?: WorkspaceDocContent | null;
  pinned?: boolean;
  inTrash?: boolean;
  parentId?: string | null;
  orderKey?: number;
  orderRank?: string;
};

export type LocalHistoryEvent = {
  id: string;
  workspaceId: string;
  op: LocalHistoryOp;
  itemId: string;
  timestamp: string;
  title: string;
  before: LocalHistorySnapshot;
  after: LocalHistorySnapshot;
  actorUserId?: string;
};

export type LocalHistoryState = {
  events: LocalHistoryEvent[];
};

type HistoryStorageArea = Pick<chrome.storage.StorageArea, "get" | "set">;

const historyStorageQueues = new WeakMap<object, Promise<void>>();

function mutateHistoryStorage<T>(storage: HistoryStorageArea, mutation: () => Promise<T>): Promise<T> {
  const key = storage as object;
  const previous = historyStorageQueues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(mutation);
  historyStorageQueues.set(key, result.then(() => undefined, () => undefined));
  return result;
}

function historyStorageKey(workspaceId: string): string {
  return `${LOCAL_HISTORY_STORAGE_PREFIX}:${workspaceId}`;
}

function makeHistoryEventId(): string {
  return `hist_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeSnapshot(value: unknown): LocalHistorySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Partial<LocalHistorySnapshot>;
  const snapshot: LocalHistorySnapshot = {};
  if (typeof record.title === "string") snapshot.title = record.title;
  if (typeof record.markdown === "string") snapshot.markdown = record.markdown;
  if (record.content === null || (record.content && typeof record.content === "object")) {
    snapshot.content = record.content ?? null;
  }
  if (typeof record.pinned === "boolean") snapshot.pinned = record.pinned;
  if (typeof record.inTrash === "boolean") snapshot.inTrash = record.inTrash;
  if (record.parentId === null || typeof record.parentId === "string") {
    snapshot.parentId = record.parentId ?? null;
  }
  if (typeof record.orderKey === "number") snapshot.orderKey = record.orderKey;
  if (typeof record.orderRank === "string") snapshot.orderRank = record.orderRank;
  return snapshot;
}

function normalizeEvent(value: unknown): LocalHistoryEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<LocalHistoryEvent>;
  if (
    typeof record.id !== "string" ||
    typeof record.workspaceId !== "string" ||
    typeof record.op !== "string" ||
    typeof record.itemId !== "string" ||
    typeof record.timestamp !== "string" ||
    typeof record.title !== "string"
  ) {
    return null;
  }
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    op: record.op as LocalHistoryOp,
    itemId: record.itemId,
    timestamp: record.timestamp,
    title: record.title,
    before: normalizeSnapshot(record.before),
    after: normalizeSnapshot(record.after),
    actorUserId: typeof record.actorUserId === "string" ? record.actorUserId : undefined,
  };
}

function normalizeState(value: unknown): LocalHistoryState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { events: [] };
  }
  const record = value as Partial<LocalHistoryState>;
  if (!Array.isArray(record.events)) {
    return { events: [] };
  }
  return {
    events: record.events.map(normalizeEvent).filter((entry): entry is LocalHistoryEvent => entry !== null),
  };
}

function snapshotsEqual(a: LocalHistorySnapshot, b: LocalHistorySnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function shouldRecordLocalHistoryEvent(
  before: LocalHistorySnapshot,
  after: LocalHistorySnapshot,
): boolean {
  return !snapshotsEqual(before, after);
}

export function isRevertableLocalHistoryEvent(event: LocalHistoryEvent): boolean {
  if (event.op === "workspace.item.create") {
    return event.after.inTrash === false;
  }
  if (event.op === "workspace.item.move") {
    return event.before.parentId === null || typeof event.before.parentId === "string";
  }
  if (event.op === "workspace.item.pin") {
    return typeof event.before.pinned === "boolean";
  }
  if (event.op === "workspace.item.trash" || event.op === "workspace.item.restore") {
    return typeof event.before.inTrash === "boolean";
  }
  if (event.op === "workspace.settings" || event.op === "workspace.member.profile") {
    return event.before.title !== undefined;
  }
  if (event.op === "workspace.item.set" || event.op === "doc.patch" || event.op === "history.revert") {
    return (
      event.before.markdown !== undefined ||
      event.before.title !== undefined ||
      event.before.content !== undefined
    );
  }
  return false;
}

export function buildLocalHistoryRevertPatch(event: LocalHistoryEvent): OfflineMutationPatch {
  const patch: OfflineMutationPatch = {};
  if (event.before.title !== undefined) patch.title = event.before.title;
  if (event.before.markdown !== undefined) patch.markdown = event.before.markdown;
  if (event.before.content !== undefined) patch.content = event.before.content;
  return patch;
}

export async function loadLocalHistory(
  storage: HistoryStorageArea,
  workspaceId: string,
): Promise<LocalHistoryState> {
  const data = await storage.get(historyStorageKey(workspaceId));
  return normalizeState(data[historyStorageKey(workspaceId)]);
}

export async function listLocalHistoryEvents(
  storage: HistoryStorageArea,
  workspaceId: string,
): Promise<LocalHistoryEvent[]> {
  const state = await loadLocalHistory(storage, workspaceId);
  return [...state.events].reverse();
}

export async function appendLocalHistoryEvent(
  storage: HistoryStorageArea,
  input: {
    workspaceId: string;
    op: LocalHistoryOp;
    itemId: string;
    title: string;
    before: LocalHistorySnapshot;
    after: LocalHistorySnapshot;
    actorUserId?: string;
    createdAt?: string;
  },
): Promise<LocalHistoryEvent | null> {
  if (!shouldRecordLocalHistoryEvent(input.before, input.after)) {
    return null;
  }
  return mutateHistoryStorage(storage, async () => {
    const state = await loadLocalHistory(storage, input.workspaceId);
    const event: LocalHistoryEvent = {
      id: makeHistoryEventId(),
      workspaceId: input.workspaceId,
      op: input.op,
      itemId: input.itemId,
      timestamp: input.createdAt ?? new Date().toISOString(),
      title: input.title,
      before: input.before,
      after: input.after,
      actorUserId: input.actorUserId,
    };
    const nextEvents = [...state.events, event];
    const trimmed = nextEvents.length > LOCAL_HISTORY_MAX_EVENTS
      ? nextEvents.slice(nextEvents.length - LOCAL_HISTORY_MAX_EVENTS)
      : nextEvents;
    await storage.set({
      [historyStorageKey(input.workspaceId)]: { events: trimmed } satisfies LocalHistoryState,
    });
    return event;
  });
}

export async function findLocalHistoryEvent(
  storage: HistoryStorageArea,
  workspaceId: string,
  eventId: string,
): Promise<LocalHistoryEvent | null> {
  const state = await loadLocalHistory(storage, workspaceId);
  return state.events.find((entry) => entry.id === eventId) ?? null;
}
