import * as Y from "yjs";
import {
  normalizeStructuredDocumentContent,
  type StructuredDocumentContent,
  type StructuredDocumentKind,
} from "@/features/workspace/structured-document";

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
  initialContent: StructuredDocumentContent;
};

function toYValue(value: unknown): Y.Map<unknown> | Y.Array<unknown> | string | number | boolean | null {
  if (Array.isArray(value)) {
    const array = new Y.Array<unknown>();
    array.insert(0, value.map((entry) => toYValue(entry)));
    return array;
  }
  if (value && typeof value === "object") {
    const map = new Y.Map<unknown>();
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      map.set(key, toYValue(entry));
    }
    return map;
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
    if (existing instanceof Y.Map && value && typeof value === "object" && !Array.isArray(value)) {
      syncYMap(existing, value as Record<string, unknown>);
      continue;
    }
    if (existing instanceof Y.Array && Array.isArray(value)) {
      syncYArray(existing, value);
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

  applyContent(options.initialContent, localOrigin);

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
