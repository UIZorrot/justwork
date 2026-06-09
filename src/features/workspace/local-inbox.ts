import {
  createMentionUserRef,
  extractMentionSnippet,
  extractMentionTokenMatches,
  type MentionToken,
} from "../mentions/mention-token";
import {
  canCreateInboxNotification,
  clearActiveInboxNotification,
  loadInboxCooldownLedger,
  recordInboxNotification,
  saveInboxCooldownLedger,
  type InboxCooldownLedger,
} from "./inbox-cooldown";

const LOCAL_INBOX_STORAGE_PREFIX = "justwork.workspace.inbox.v1";

export type LocalInboxNotification = {
  id: string;
  dedupeKey: string;
  workspaceId: string;
  docId: string;
  docTitle: string;
  targetUserId: string;
  mentionId: string;
  mentionText: string;
  createdAt: string;
  isRead: boolean;
};

export type LocalInboxState = {
  notifications: LocalInboxNotification[];
};

type InboxStorageArea = Pick<chrome.storage.StorageArea, "get" | "set">;

function inboxStorageKey(workspaceId: string, userId: string): string {
  return `${LOCAL_INBOX_STORAGE_PREFIX}:${workspaceId}:${userId}`;
}

function makeNotificationId(): string {
  return `inbox_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function notificationDedupeKey(workspaceId: string, docId: string, targetUserId: string, mentionId: string): string {
  return `${workspaceId}:${docId}:${targetUserId}:${mentionId}`;
}

function normalizeNotification(value: unknown): LocalInboxNotification | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<LocalInboxNotification>;
  if (
    typeof record.id !== "string" ||
    typeof record.dedupeKey !== "string" ||
    typeof record.workspaceId !== "string" ||
    typeof record.docId !== "string" ||
    typeof record.docTitle !== "string" ||
    typeof record.targetUserId !== "string" ||
    typeof record.mentionId !== "string" ||
    typeof record.mentionText !== "string" ||
    typeof record.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: record.id,
    dedupeKey: record.dedupeKey,
    workspaceId: record.workspaceId,
    docId: record.docId,
    docTitle: record.docTitle,
    targetUserId: record.targetUserId,
    mentionId: record.mentionId,
    mentionText: record.mentionText,
    createdAt: record.createdAt,
    isRead: record.isRead === true,
  };
}

function normalizeState(value: unknown): LocalInboxState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { notifications: [] };
  }
  const raw = (value as { notifications?: unknown }).notifications;
  if (!Array.isArray(raw)) {
    return { notifications: [] };
  }
  return {
    notifications: raw.map(normalizeNotification).filter((item): item is LocalInboxNotification => item !== null),
  };
}

async function readInboxState(storage: InboxStorageArea, key: string): Promise<LocalInboxState> {
  const raw = await storage.get(key);
  return normalizeState(raw[key]);
}

async function writeInboxState(storage: InboxStorageArea, key: string, state: LocalInboxState): Promise<void> {
  await storage.set({ [key]: state });
}

export function createMentionNotification(params: {
  workspaceId: string;
  docId: string;
  docTitle: string;
  targetUserId: string;
  mentionId: string;
  mentionText: string;
  createdAt?: string;
}): LocalInboxNotification {
  const createdAt = params.createdAt ?? new Date().toISOString();
  return {
    id: makeNotificationId(),
    dedupeKey: notificationDedupeKey(params.workspaceId, params.docId, params.targetUserId, params.mentionId),
    workspaceId: params.workspaceId,
    docId: params.docId,
    docTitle: params.docTitle,
    targetUserId: params.targetUserId,
    mentionId: params.mentionId,
    mentionText: params.mentionText,
    createdAt,
    isRead: false,
  };
}

function extractTargetMentions(markdown: string, targetUserId: string): MentionToken[] {
  const targetUserRef = createMentionUserRef(targetUserId);
  return extractMentionTokenMatches(markdown)
    .filter((token) => token.userRef === targetUserRef || token.userId === targetUserId)
    .map(({ raw: _raw, index: _index, ...token }) => token);
}

export function extractMentionNotifications(params: {
  previousMarkdown: string;
  nextMarkdown: string;
  workspaceId: string;
  docId: string;
  docTitle: string;
  recipientUserId: string;
  createdAt?: string;
}): LocalInboxNotification[] {
  const previousMentions = extractTargetMentions(params.previousMarkdown, params.recipientUserId);
  const nextMentions = extractTargetMentions(params.nextMarkdown, params.recipientUserId);
  if (nextMentions.length === 0 || nextMentions.length <= previousMentions.length) {
    return [];
  }
  const previousIds = new Set(previousMentions.map((mention) => mention.mentionId));
  return nextMentions
    .filter((mention) => !previousIds.has(mention.mentionId))
    .map((mention) => createMentionNotification({
      workspaceId: params.workspaceId,
      docId: params.docId,
      docTitle: params.docTitle,
      targetUserId: params.recipientUserId,
      mentionId: mention.mentionId,
      mentionText: extractMentionSnippet(params.nextMarkdown, mention.mentionId) || `@${mention.displayName}`,
      createdAt: params.createdAt,
    }));
}

export function extractMentionNotification(params: {
  previousMarkdown: string;
  nextMarkdown: string;
  workspaceId: string;
  docId: string;
  docTitle: string;
  recipientUserId: string;
  createdAt?: string;
}): LocalInboxNotification | null {
  return extractMentionNotifications(params)[0] ?? null;
}

export async function loadLocalInboxState(
  storage: InboxStorageArea,
  workspaceId: string,
  userId: string,
): Promise<LocalInboxState> {
  return await readInboxState(storage, inboxStorageKey(workspaceId, userId));
}

export async function appendLocalInboxNotification(
  storage: InboxStorageArea,
  workspaceId: string,
  userId: string,
  notification: LocalInboxNotification,
): Promise<LocalInboxState> {
  const key = inboxStorageKey(workspaceId, userId);
  const state = await readInboxState(storage, key);
  if (state.notifications.some((item) => item.dedupeKey === notification.dedupeKey)) {
    return state;
  }
  const next: LocalInboxState = {
    notifications: [notification, ...state.notifications].slice(0, 100),
  };
  await writeInboxState(storage, key, next);
  return next;
}

export async function appendMentionNotificationsWithCooldown(
  storage: InboxStorageArea,
  workspaceId: string,
  userId: string,
  notifications: LocalInboxNotification[],
  now = new Date().toISOString(),
): Promise<{ state: LocalInboxState; ledger: InboxCooldownLedger; added: LocalInboxNotification[] }> {
  const key = inboxStorageKey(workspaceId, userId);
  let state = await readInboxState(storage, key);
  let ledger = await loadInboxCooldownLedger(storage, workspaceId, userId);
  const added: LocalInboxNotification[] = [];
  for (const notification of notifications) {
    if (state.notifications.some((item) => item.dedupeKey === notification.dedupeKey)) {
      continue;
    }
    if (!canCreateInboxNotification(ledger, {
      workspaceId,
      docId: notification.docId,
      userId,
      now,
    })) {
      continue;
    }
    state = {
      notifications: [notification, ...state.notifications].slice(0, 100),
    };
    ledger = recordInboxNotification(ledger, {
      workspaceId,
      docId: notification.docId,
      userId,
      notificationId: notification.id,
      now,
    });
    added.push(notification);
  }
  if (added.length > 0) {
    await writeInboxState(storage, key, state);
    await saveInboxCooldownLedger(storage, workspaceId, userId, ledger);
  }
  return { state, ledger, added };
}

export async function dismissLocalInboxNotification(
  storage: InboxStorageArea,
  workspaceId: string,
  userId: string,
  notificationId: string,
): Promise<LocalInboxState> {
  const key = inboxStorageKey(workspaceId, userId);
  const state = await readInboxState(storage, key);
  const target = state.notifications.find((notification) => notification.id === notificationId) ?? null;
  const next: LocalInboxState = {
    notifications: state.notifications.filter((notification) => notification.id !== notificationId),
  };
  await writeInboxState(storage, key, next);
  if (target) {
    const ledger = await loadInboxCooldownLedger(storage, workspaceId, userId);
    const nextLedger = clearActiveInboxNotification(ledger, {
      workspaceId,
      docId: target.docId,
      userId,
    });
    await saveInboxCooldownLedger(storage, workspaceId, userId, nextLedger);
  }
  return next;
}

export async function markLocalInboxNotificationRead(
  storage: InboxStorageArea,
  workspaceId: string,
  userId: string,
  notificationId: string,
): Promise<LocalInboxState> {
  const key = inboxStorageKey(workspaceId, userId);
  const state = await readInboxState(storage, key);
  const next: LocalInboxState = {
    notifications: state.notifications.map((notification) => (
      notification.id === notificationId ? { ...notification, isRead: true } : notification
    )),
  };
  await writeInboxState(storage, key, next);
  return next;
}

export async function markAllLocalInboxNotificationsRead(
  storage: InboxStorageArea,
  workspaceId: string,
  userId: string,
): Promise<LocalInboxState> {
  const key = inboxStorageKey(workspaceId, userId);
  const state = await readInboxState(storage, key);
  const next: LocalInboxState = {
    notifications: state.notifications.map((notification) => ({ ...notification, isRead: true })),
  };
  await writeInboxState(storage, key, next);
  return next;
}
