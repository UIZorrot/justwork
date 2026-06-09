import { STORAGE_KEYS } from "../../shared/storage-keys";

export type InboxCooldownEntry = {
  workspaceId: string;
  docId: string;
  userId: string;
  lastTriggeredAt: string;
  activeNotificationId: string | null;
};

export type InboxCooldownLedger = Record<string, InboxCooldownEntry>;

type InboxStorageArea = Pick<chrome.storage.StorageArea, "get" | "set">;

const COOLDOWN_MS = 24 * 60 * 60 * 1000;

function entryKey(workspaceId: string, docId: string, userId: string): string {
  return `${workspaceId}:${docId}:${userId}`;
}

function storageKey(workspaceId: string, userId: string): string {
  return `${STORAGE_KEYS.BACKEND_WORKSPACE_INBOX_COOLDOWN}:${workspaceId}:${userId}`;
}

function normalizeLedger(value: unknown): InboxCooldownLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const next: InboxCooldownLedger = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Partial<InboxCooldownEntry>;
    if (
      typeof entry.workspaceId !== "string" ||
      typeof entry.docId !== "string" ||
      typeof entry.userId !== "string" ||
      typeof entry.lastTriggeredAt !== "string"
    ) {
      continue;
    }
    next[key] = {
      workspaceId: entry.workspaceId,
      docId: entry.docId,
      userId: entry.userId,
      lastTriggeredAt: entry.lastTriggeredAt,
      activeNotificationId: typeof entry.activeNotificationId === "string" ? entry.activeNotificationId : null,
    };
  }
  return next;
}

export function canCreateInboxNotification(
  ledger: InboxCooldownLedger,
  params: { workspaceId: string; docId: string; userId: string; now: string },
): boolean {
  const existing = ledger[entryKey(params.workspaceId, params.docId, params.userId)];
  if (!existing) return true;
  if (existing.activeNotificationId) return false;
  return (Date.parse(params.now) - Date.parse(existing.lastTriggeredAt)) >= COOLDOWN_MS;
}

export function recordInboxNotification(
  ledger: InboxCooldownLedger,
  params: { workspaceId: string; docId: string; userId: string; notificationId: string; now: string },
): InboxCooldownLedger {
  return {
    ...ledger,
    [entryKey(params.workspaceId, params.docId, params.userId)]: {
      workspaceId: params.workspaceId,
      docId: params.docId,
      userId: params.userId,
      lastTriggeredAt: params.now,
      activeNotificationId: params.notificationId,
    },
  };
}

export function clearActiveInboxNotification(
  ledger: InboxCooldownLedger,
  params: { workspaceId: string; docId: string; userId: string },
): InboxCooldownLedger {
  const key = entryKey(params.workspaceId, params.docId, params.userId);
  const entry = ledger[key];
  if (!entry) return ledger;
  return {
    ...ledger,
    [key]: {
      ...entry,
      activeNotificationId: null,
    },
  };
}

export async function loadInboxCooldownLedger(
  storage: InboxStorageArea,
  workspaceId: string,
  userId: string,
): Promise<InboxCooldownLedger> {
  const key = storageKey(workspaceId, userId);
  const raw = await storage.get(key);
  return normalizeLedger(raw[key]);
}

export async function saveInboxCooldownLedger(
  storage: InboxStorageArea,
  workspaceId: string,
  userId: string,
  ledger: InboxCooldownLedger,
): Promise<void> {
  await storage.set({ [storageKey(workspaceId, userId)]: ledger });
}
