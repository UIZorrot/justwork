import type { BackendClient } from "@/features/backend/client";
import { STORAGE_KEYS } from "@/shared/storage-keys";
import type { WorkspacePresenceMember } from "./assets/relay-protocol";

type StorageAreaLike = Pick<chrome.storage.StorageArea, "get" | "set">;

export type WorkspaceJoinedMember = {
  memberKey: string;
  displayName: string;
  userId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  source: "profile" | "presence" | "local";
};

export type WorkspacePeopleEntry = {
  memberKey: string;
  displayName: string;
  userId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  isOnline: boolean;
  onlineSessionCount: number;
  source: "profile" | "presence" | "local";
};

type MemberDirectoryMap = Record<string, WorkspaceJoinedMember[]>;

function normalizeDisplayName(displayName: string): string {
  return displayName.trim().replace(/\s+/g, " ");
}

function normalizeMemberKey(displayName: string, userId?: string | null): string {
  const trimmedUserId = typeof userId === "string" ? userId.trim() : "";
  if (trimmedUserId) return `user:${trimmedUserId}`;
  return `name:${normalizeDisplayName(displayName).toLowerCase()}`;
}

function workspaceDirectoryStorageKey(): string {
  return STORAGE_KEYS.BACKEND_WORKSPACE_MEMBER_DIRECTORY;
}

function normalizeJoinedMember(value: unknown): WorkspaceJoinedMember | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<WorkspaceJoinedMember>;
  if (
    typeof record.memberKey !== "string" ||
    typeof record.displayName !== "string" ||
    typeof record.firstSeenAt !== "string" ||
    typeof record.lastSeenAt !== "string"
  ) {
    return null;
  }
  return {
    memberKey: record.memberKey,
    displayName: record.displayName,
    userId: typeof record.userId === "string" ? record.userId : null,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    source:
      record.source === "profile" || record.source === "presence" || record.source === "local"
        ? record.source
        : "local",
  };
}

async function loadMemberDirectoryMap(storage: StorageAreaLike): Promise<MemberDirectoryMap> {
  const raw = await storage.get(workspaceDirectoryStorageKey());
  const value = raw[workspaceDirectoryStorageKey()];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const next: MemberDirectoryMap = {};
  for (const [workspaceId, members] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(members)) continue;
    next[workspaceId] = members
      .map(normalizeJoinedMember)
      .filter((member): member is WorkspaceJoinedMember => member !== null);
  }
  return next;
}

async function saveMemberDirectoryMap(storage: StorageAreaLike, map: MemberDirectoryMap): Promise<void> {
  await storage.set({ [workspaceDirectoryStorageKey()]: map });
}

export async function loadWorkspaceJoinedMembers(
  storage: StorageAreaLike,
  workspaceId: string,
): Promise<WorkspaceJoinedMember[]> {
  const map = await loadMemberDirectoryMap(storage);
  return map[workspaceId] ?? [];
}

export async function upsertWorkspaceJoinedMembers(
  storage: StorageAreaLike,
  workspaceId: string,
  incoming: Array<{
    displayName: string;
    userId?: string | null;
    source: "profile" | "presence" | "local";
    seenAt?: string;
  }>,
): Promise<WorkspaceJoinedMember[]> {
  const map = await loadMemberDirectoryMap(storage);
  const current = new Map((map[workspaceId] ?? []).map((member) => [member.memberKey, member] as const));
  for (const candidate of incoming) {
    const displayName = normalizeDisplayName(candidate.displayName);
    if (!displayName) continue;
    const seenAt = candidate.seenAt ?? new Date().toISOString();
    const memberKey = normalizeMemberKey(displayName, candidate.userId ?? null);
    const existing = current.get(memberKey);
    current.set(memberKey, {
      memberKey,
      displayName,
      userId: candidate.userId ?? existing?.userId ?? null,
      firstSeenAt: existing?.firstSeenAt ?? seenAt,
      lastSeenAt: seenAt,
      source: candidate.source === "profile" ? "profile" : existing?.source === "profile" ? "profile" : candidate.source,
    });
  }
  const next = Array.from(current.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  map[workspaceId] = next;
  await saveMemberDirectoryMap(storage, map);
  return next;
}

export async function replaceWorkspaceJoinedMembers(
  storage: StorageAreaLike,
  workspaceId: string,
  members: WorkspaceJoinedMember[],
): Promise<WorkspaceJoinedMember[]> {
  const map = await loadMemberDirectoryMap(storage);
  const next = members
    .map(normalizeJoinedMember)
    .filter((member): member is WorkspaceJoinedMember => member !== null)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  map[workspaceId] = next;
  await saveMemberDirectoryMap(storage, map);
  return next;
}

export async function loadWorkspaceJoinedMembersFromApi(
  client: BackendClient,
  workspaceId: string,
  password: string,
): Promise<WorkspaceJoinedMember[]> {
  const response = await client.listMembers(workspaceId, { password });
  const members: WorkspaceJoinedMember[] = [];
  for (const member of response.members) {
    const displayName = normalizeDisplayName(member.nickname || member.display_name || "");
    if (!displayName) continue;
    members.push({
      memberKey: normalizeMemberKey(displayName, member.user_id ?? null),
      displayName,
      userId: typeof member.user_id === "string" ? member.user_id : null,
      firstSeenAt: member.joined_at || new Date().toISOString(),
      lastSeenAt: member.joined_at || new Date().toISOString(),
      source: "profile",
    });
  }
  return members;
}

export function mergeWorkspacePeople(
  joinedMembers: WorkspaceJoinedMember[],
  onlineMembers: WorkspacePresenceMember[],
): WorkspacePeopleEntry[] {
  const entries = new Map<string, WorkspacePeopleEntry>();
  for (const member of joinedMembers) {
    entries.set(member.memberKey, {
      memberKey: member.memberKey,
      displayName: member.displayName,
      userId: member.userId,
      firstSeenAt: member.firstSeenAt,
      lastSeenAt: member.lastSeenAt,
      isOnline: false,
      onlineSessionCount: 0,
      source: member.source,
    });
  }
  for (const member of onlineMembers) {
    const displayName = normalizeDisplayName(member.displayName);
    if (!displayName) continue;
    const memberKey = normalizeMemberKey(displayName, member.userId);
    const existing = entries.get(memberKey);
    entries.set(memberKey, {
      memberKey,
      displayName,
      userId: existing?.userId ?? null,
      firstSeenAt: existing?.firstSeenAt ?? member.joinedAt,
      lastSeenAt: member.joinedAt,
      isOnline: true,
      onlineSessionCount: (existing?.onlineSessionCount ?? 0) + 1,
      source: existing?.source ?? "presence",
    });
  }
  return Array.from(entries.values()).sort((a, b) => {
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
}
