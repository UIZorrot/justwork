import * as Y from "yjs";
import {
  normalizeStructuredDocumentContent,
  type StructuredDocumentContent,
  type StructuredDocumentKind,
} from "../workspace/structured-document";

export type StructuredCollaborator = {
  readonly doc: Y.Doc;
  getContent: () => StructuredDocumentContent;
  applyLocalContent: (content: StructuredDocumentContent) => void;
  applyRemoteUpdate: (update: Uint8Array) => void;
  encodeUpdate: () => Uint8Array;
  onUpdate: (handler: (update: Uint8Array, origin: "local" | "remote") => void) => () => void;
  destroy: () => void;
};

export type StructuredCollaboratorOptions = {
  kind: StructuredDocumentKind;
  initialContent?: StructuredDocumentContent;
};

const KEYED_ARRAY_TYPE = "justwork-keyed-array-v1";

function stableArrayEntryKey(value: unknown): string | null {
  if (typeof value === "string" && value) return `value:${value}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const field of ["id", "columnId", "templateFieldId", "sheetId"]) {
    if (typeof record[field] === "string" && record[field]) return `${field}:${record[field]}`;
  }
  return null;
}

function canUseKeyedArray(values: unknown[]): boolean {
  const keys = values.map(stableArrayEntryKey);
  return keys.every((key): key is string => key !== null) && new Set(keys).size === keys.length;
}

function createKeyedArray(values: unknown[]): Y.Map<unknown> {
  const entries = values.map((value) => [stableArrayEntryKey(value)!, toYValue(value)] as const);
  const rankEntries = values.map((value, index) => [stableArrayEntryKey(value)!, index * 1024] as const);
  return new Y.Map<unknown>([
    ["__type", KEYED_ARRAY_TYPE],
    ["items", new Y.Map<unknown>(entries)],
    ["ranks", new Y.Map<number>(rankEntries)],
  ]);
}

function isKeyedArray(value: unknown): boolean {
  return value instanceof Y.Map && value.get("__type") === KEYED_ARRAY_TYPE;
}

function syncKeyedArray(container: Y.Map<unknown>, values: unknown[]): void {
  const items = container.get("items") as Y.Map<unknown> | undefined;
  const ranks = container.get("ranks") as Y.Map<number> | undefined;
  if (!(items instanceof Y.Map) || !(ranks instanceof Y.Map)) return;
  const nextKeys = values.map(stableArrayEntryKey);
  if (nextKeys.some((key) => key === null)) return;
  const keep = new Set(nextKeys as string[]);
  for (const key of [...items.keys()]) {
    if (!keep.has(key)) items.delete(key);
  }
  for (const key of [...ranks.keys()]) {
    if (!keep.has(key)) ranks.delete(key);
  }
  values.forEach((value, index) => {
    const key = nextKeys[index]!;
    const existing = items.get(key);
    if (existing instanceof Y.Map && value && typeof value === "object" && !Array.isArray(value)) {
      syncYMap(existing, value as Record<string, unknown>);
    } else if (existing === undefined || fromYValue(existing) !== value) {
      items.set(key, toYValue(value));
    }
    // Each item's rank is an independent CRDT register. Concurrent cell/card
    // edits no longer delete and recreate unrelated rows, columns, or cards.
    const nextRank = index * 1024;
    if (ranks.get(key) !== nextRank) ranks.set(key, nextRank);
  });
}

function toYValue(value: unknown): Y.Map<unknown> | Y.Array<unknown> | string | number | boolean | null {
  if (Array.isArray(value)) {
    if (value.length > 0 && canUseKeyedArray(value)) return createKeyedArray(value);
    const array = new Y.Array<unknown>();
    array.insert(0, value.map((entry) => toYValue(entry)));
    return array;
  }
  if (value && typeof value === "object") {
    return new Y.Map<unknown>(
      Object.entries(value as Record<string, unknown>).map(
        ([key, entry]) => [key, toYValue(entry)] as const,
      ),
    );
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  return "";
}

function fromYValue(value: unknown): unknown {
  if (value instanceof Y.Map) {
    if (isKeyedArray(value)) {
      const items = (value as Y.Map<unknown>).get("items") as Y.Map<unknown> | undefined;
      const ranks = (value as Y.Map<unknown>).get("ranks") as Y.Map<number> | undefined;
      if (!(items instanceof Y.Map) || !(ranks instanceof Y.Map)) return [];
      return [...items.entries()]
        .sort(([leftKey], [rightKey]) => (
          (ranks.get(leftKey) ?? 0) - (ranks.get(rightKey) ?? 0) || leftKey.localeCompare(rightKey)
        ))
        .map(([, entry]) => fromYValue(entry));
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of value.entries()) {
      result[key] = fromYValue(entry);
    }
    return result;
  }
  if (value instanceof Y.Array) {
    return value.toArray().map((entry) => fromYValue(entry));
  }
  return value;
}

function syncYMap(target: Y.Map<unknown>, next: Record<string, unknown>): void {
  for (const key of [...target.keys()]) {
    if (!(key in next)) {
      target.delete(key);
    }
  }
  for (const [key, value] of Object.entries(next)) {
    const existing = target.get(key);
    if (isKeyedArray(existing) && Array.isArray(value) && canUseKeyedArray(value)) {
      syncKeyedArray(existing as Y.Map<unknown>, value);
      continue;
    }
    if (existing instanceof Y.Map && value && typeof value === "object" && !Array.isArray(value)) {
      syncYMap(existing, value as Record<string, unknown>);
      continue;
    }
    if (existing instanceof Y.Array && Array.isArray(value)) {
      if (canUseKeyedArray(value)) {
        target.set(key, createKeyedArray(value));
        continue;
      }
      syncYArray(existing, value);
      continue;
    }
    if (!(existing instanceof Y.Map) && !(existing instanceof Y.Array) && Object.is(existing, value)) {
      continue;
    }
    target.set(key, toYValue(value));
  }
}

function syncYArray(target: Y.Array<unknown>, next: unknown[]): void {
  target.delete(0, target.length);
  target.insert(0, next.map((entry) => toYValue(entry)));
}

export function createStructuredCollaborator(
  options: StructuredCollaboratorOptions,
): StructuredCollaborator {
  const doc = new Y.Doc();
  const root = doc.getMap("content");
  const handlers = new Set<(update: Uint8Array, origin: "local" | "remote") => void>();
  const localOrigin = Symbol("local-structured-update");
  const remoteOrigin = Symbol("remote-structured-update");

  const emitUpdate = (update: Uint8Array, origin: "local" | "remote"): void => {
    for (const handler of handlers) handler(update, origin);
  };

  doc.on("update", (update, origin) => {
    if (origin === remoteOrigin) {
      emitUpdate(update, "remote");
      return;
    }
    emitUpdate(update, "local");
  });

  const applyContent = (content: StructuredDocumentContent, origin: symbol): void => {
    doc.transact(() => {
      syncYMap(root, content as unknown as Record<string, unknown>);
    }, origin);
  };

  // Only the elected bootstrap client may seed a brand-new CRDT document. If
  // every client writes its local fallback here, a late join can overwrite or
  // duplicate the already-authoritative structured state.
  if (options.initialContent !== undefined) {
    applyContent(options.initialContent, localOrigin);
  }

  return {
    doc,
    getContent: () => {
      const raw = fromYValue(root) as Record<string, unknown>;
      return normalizeStructuredDocumentContent(options.kind, raw);
    },
    applyLocalContent: (content) => {
      applyContent(content, localOrigin);
    },
    applyRemoteUpdate: (update) => {
      Y.applyUpdate(doc, update, remoteOrigin);
    },
    encodeUpdate: () => Y.encodeStateAsUpdate(doc),
    onUpdate: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    destroy: () => {
      handlers.clear();
      doc.destroy();
    },
  };
}
