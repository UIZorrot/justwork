const LOCAL_INBOX_STORAGE_PREFIX = "justwork.workspace.inbox.v1";

export type LocalInboxNotification = {
  id: string;
  dedupeKey: string;
  workspaceId: string;
  docId: string;
  docTitle: string;
  mentionText: string;
  createdAt: string;
  isRead: boolean;
};

export type LocalInboxState = {
  notifications: LocalInboxNotification[];
};

type InboxStorageArea = Pick<chrome.storage.StorageArea, "get" | "set">;
type MentionOccurrence = {
  index: number;
  line: string;
  snippet: string;
  occurrenceKey: string;
};

function inboxStorageKey(workspaceId: string, userId: string): string {
  return `${LOCAL_INBOX_STORAGE_PREFIX}:${workspaceId}:${userId}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeNotificationId(): string {
  return `inbox_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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

export function extractMentionSnippet(markdown: string, mention: string): string {
  return findMentionOccurrences(markdown, mention)[0]?.snippet ?? "";
}

function isMentionBoundaryBefore(char: string | undefined): boolean {
  return !char || !/[\p{L}\p{N}_@.-]/u.test(char);
}

function isMentionBoundaryAfter(char: string | undefined): boolean {
  return !char || !/[\p{L}\p{N}_-]/u.test(char);
}

function mentionSignature(snippet: string, occurrenceIndex: number): string {
  return `${occurrenceIndex}:${snippet.trim().toLowerCase()}`;
}

function findMentionOccurrences(markdown: string, mention: string): MentionOccurrence[] {
  const trimmedMention = mention.trim();
  if (!trimmedMention) return [];
  const lowerMarkdown = markdown.toLowerCase();
  const needle = `@${trimmedMention.toLowerCase()}`;
  const matches: MentionOccurrence[] = [];
  let searchFrom = 0;
  let occurrenceIndex = 0;
  while (searchFrom < lowerMarkdown.length) {
    const index = lowerMarkdown.indexOf(needle, searchFrom);
    if (index === -1) break;
    searchFrom = index + needle.length;
    const before = index > 0 ? markdown[index - 1] : undefined;
    const after = markdown[index + needle.length];
    if (!isMentionBoundaryBefore(before) || !isMentionBoundaryAfter(after)) {
      continue;
    }
    const lineStart = markdown.lastIndexOf("\n", index);
    const lineEnd = markdown.indexOf("\n", index);
    const rawLine = markdown.slice(lineStart === -1 ? 0 : lineStart + 1, lineEnd === -1 ? markdown.length : lineEnd).trim();
    const snippet = rawLine.slice(0, 180) || markdown.slice(index, Math.min(markdown.length, index + 180)).trim();
    matches.push({
      index,
      line: rawLine,
      snippet,
      occurrenceKey: mentionSignature(snippet, occurrenceIndex),
    });
    occurrenceIndex += 1;
  }
  return matches;
}

export function hasMention(markdown: string, mention: string): boolean {
  return findMentionOccurrences(markdown, mention).length > 0;
}

export function createMentionNotification(params: {
  workspaceId: string;
  docId: string;
  docTitle: string;
  mentionText: string;
  occurrenceKey?: string;
  createdAt?: string;
  recipientDisplayName: string;
}): LocalInboxNotification {
  const createdAt = params.createdAt ?? new Date().toISOString();
  const dedupeKey = [
    params.workspaceId,
    params.docId,
    params.recipientDisplayName.trim().toLowerCase(),
    params.occurrenceKey?.trim().toLowerCase() || params.mentionText.trim().toLowerCase(),
  ].join(":");
  return {
    id: makeNotificationId(),
    dedupeKey,
    workspaceId: params.workspaceId,
    docId: params.docId,
    docTitle: params.docTitle,
    mentionText: params.mentionText || `@${params.recipientDisplayName}`,
    createdAt,
    isRead: false,
  };
}

export function extractMentionNotifications(params: {
  previousMarkdown: string;
  nextMarkdown: string;
  workspaceId: string;
  docId: string;
  docTitle: string;
  recipientDisplayName: string;
}): LocalInboxNotification[] {
  const recipient = params.recipientDisplayName.trim();
  if (!recipient) return [];
  const previousMatches = findMentionOccurrences(params.previousMarkdown, recipient);
  const nextMatches = findMentionOccurrences(params.nextMarkdown, recipient);
  if (nextMatches.length === 0 || nextMatches.length <= previousMatches.length) return [];
  const newMatches = nextMatches.slice(previousMatches.length);
  return newMatches.map((match) => createMentionNotification({
    workspaceId: params.workspaceId,
    docId: params.docId,
    docTitle: params.docTitle,
    mentionText: match.snippet || `@${recipient}`,
    occurrenceKey: match.occurrenceKey,
    recipientDisplayName: recipient,
  }));
}

export function extractMentionNotification(params: {
  previousMarkdown: string;
  nextMarkdown: string;
  workspaceId: string;
  docId: string;
  docTitle: string;
  recipientDisplayName: string;
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
