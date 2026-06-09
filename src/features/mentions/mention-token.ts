export type MentionToken = {
  mentionId: string;
  displayName: string;
  userRef: string;
  userId?: string;
};

export type MentionTokenMatch = MentionToken & {
  raw: string;
  index: number;
};

const TOKEN_PREFIX = "justwork-mention";
const TOKEN_PATTERN = /\[@([^\]]+)\]\(justwork-mention:([^)]+)\)/g;
const TOKEN_PAYLOAD_VERSION = "v2";

function cyrb53(value: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function createMentionUserRef(userId: string): string {
  return `u_${cyrb53(userId).toString(36)}`;
}

export function encodeMentionToken(token: {
  mentionId: string;
  displayName: string;
  userId?: string;
  userRef?: string;
}): string {
  const userRef = token.userRef?.trim() || (token.userId ? createMentionUserRef(token.userId) : "");
  if (!userRef) {
    throw new Error("Mention token requires userId or userRef");
  }
  const payload = `${TOKEN_PAYLOAD_VERSION}:${token.mentionId}:${userRef}`;
  return `[@${token.displayName}](${TOKEN_PREFIX}:${payload})`;
}

export function decodeMentionToken(markdown: string): MentionToken | null {
  const match = markdown.match(/^\[@([^\]]+)\]\(justwork-mention:([^)]+)\)$/);
  if (!match) return null;
  const displayName = match[1] ?? "";
  const payload = match[2] ?? "";
  if (payload.startsWith(`${TOKEN_PAYLOAD_VERSION}:`)) {
    const [, mentionId = "", userRef = ""] = payload.split(":");
    if (!mentionId || !userRef) return null;
    return {
      mentionId,
      displayName,
      userRef,
    };
  }
  try {
    const parsed = JSON.parse(decodeURIComponent(payload));
    if (
      typeof parsed?.mentionId !== "string" ||
      typeof parsed?.userId !== "string" ||
      typeof parsed?.displayName !== "string"
    ) {
      return null;
    }
    return {
      mentionId: parsed.mentionId,
      displayName: parsed.displayName,
      userId: parsed.userId,
      userRef: createMentionUserRef(parsed.userId),
    };
  } catch {
    return null;
  }
}

export function extractMentionTokenMatches(markdown: string): MentionTokenMatch[] {
  const matches: MentionTokenMatch[] = [];
  for (const match of markdown.matchAll(TOKEN_PATTERN)) {
    const raw = match[0];
    if (!raw) continue;
    const decoded = decodeMentionToken(raw);
    if (!decoded) continue;
    matches.push({
      ...decoded,
      raw,
      index: match.index ?? 0,
    });
  }
  return matches;
}

export function extractMentionTokens(markdown: string): MentionToken[] {
  return extractMentionTokenMatches(markdown).map(({ raw: _raw, index: _index, ...token }) => token);
}

export function replaceMentionTokensWithLabels(markdown: string): string {
  return markdown.replace(TOKEN_PATTERN, (_raw, displayName) => `@${displayName}`);
}

export function findMentionTokenById(markdown: string, mentionId: string): MentionTokenMatch | null {
  return extractMentionTokenMatches(markdown).find((token) => token.mentionId === mentionId) ?? null;
}

export function extractMentionSnippet(markdown: string, mentionId: string): string {
  const match = findMentionTokenById(markdown, mentionId);
  if (!match) return "";
  const lineStart = markdown.lastIndexOf("\n", match.index);
  const lineEnd = markdown.indexOf("\n", match.index);
  const line = markdown.slice(lineStart === -1 ? 0 : lineStart + 1, lineEnd === -1 ? markdown.length : lineEnd).trim();
  const snippetSource = line || markdown.slice(match.index, Math.min(markdown.length, match.index + 180)).trim();
  return replaceMentionTokensWithLabels(snippetSource).slice(0, 180);
}
