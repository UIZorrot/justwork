import * as Y from "yjs";

export type MarkdownCollaborator = {
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  getMarkdown: () => string;
  applyLocalMarkdown: (markdown: string) => void;
  applyRemoteUpdate: (update: Uint8Array, options?: RemoteMarkdownUpdateOptions) => boolean;
  encodeUpdate: () => Uint8Array;
  onUpdate: (handler: (update: Uint8Array, origin: "local" | "remote") => void) => () => void;
  destroy: () => void;
};

export type RemoteMarkdownUpdateOptions = {
  /** Keep unsaved editor text when adopting a snapshot created from an incompatible CRDT baseline. */
  preserveLocalMarkdown?: boolean;
};

export type MarkdownCollaboratorOptions = {
  name?: string;
  initialMarkdown?: string;
};

function applyMarkdownDiff(text: Y.Text, current: string, next: string): void {
  if (current === next) return;

  let prefixLength = 0;
  const sharedLength = Math.min(current.length, next.length);
  while (prefixLength < sharedLength && current[prefixLength] === next[prefixLength]) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  const remainingCurrent = current.length - prefixLength;
  const remainingNext = next.length - prefixLength;
  while (
    suffixLength < remainingCurrent &&
    suffixLength < remainingNext &&
    current[current.length - 1 - suffixLength] === next[next.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const deleteLength = current.length - prefixLength - suffixLength;
  const inserted = next.slice(prefixLength, next.length - suffixLength);
  if (deleteLength > 0) text.delete(prefixLength, deleteLength);
  if (inserted.length > 0) text.insert(prefixLength, inserted);
}

function markdownFromUpdate(update: Uint8Array, textName: string): string {
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, update);
    return candidate.getText(textName).toString();
  } finally {
    candidate.destroy();
  }
}

function mergedMarkdown(currentUpdate: Uint8Array, remoteUpdate: Uint8Array, textName: string): string {
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, currentUpdate);
    Y.applyUpdate(candidate, remoteUpdate);
    return candidate.getText(textName).toString();
  } finally {
    candidate.destroy();
  }
}

function rebasedRemoteUpdate(
  currentUpdate: Uint8Array,
  remoteUpdate: Uint8Array,
  textName: string,
  preservedMarkdown: string | null,
): Uint8Array {
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, currentUpdate);
    const candidateText = candidate.getText(textName);
    candidateText.delete(0, candidateText.length);
    Y.applyUpdate(candidate, remoteUpdate);
    if (preservedMarkdown !== null) {
      applyMarkdownDiff(candidateText, candidateText.toString(), preservedMarkdown);
    }
    return Y.encodeStateAsUpdate(candidate);
  } finally {
    candidate.destroy();
  }
}

function hasDisjointTextBaseline(current: string, remote: string, merged: string): boolean {
  if (!current || !remote || merged === current || merged === remote) return false;
  return merged === `${current}${remote}` || merged === `${remote}${current}`;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function createMarkdownCollaborator(
  options: MarkdownCollaboratorOptions = {},
): MarkdownCollaborator {
  const doc = new Y.Doc();
  const textName = options.name ?? "markdown";
  const text = doc.getText(textName);
  const handlers = new Set<(update: Uint8Array, origin: "local" | "remote") => void>();
  const localOrigin = Symbol("local-markdown-update");
  const remoteOrigin = Symbol("remote-markdown-update");

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

  if (options.initialMarkdown) {
    doc.transact(() => {
      text.insert(0, options.initialMarkdown ?? "");
    }, localOrigin);
  }

  return {
    doc,
    text,
    getMarkdown: () => text.toString(),
    applyLocalMarkdown: (markdown) => {
      doc.transact(() => {
        applyMarkdownDiff(text, text.toString(), markdown);
      }, localOrigin);
    },
    applyRemoteUpdate: (update, remoteOptions = {}) => {
      const beforeState = Y.encodeStateVector(doc);
      const currentMarkdown = text.toString();
      const currentUpdate = Y.encodeStateAsUpdate(doc);
      const remoteMarkdown = markdownFromUpdate(update, textName);
      const merged = mergedMarkdown(currentUpdate, update, textName);

      if (hasDisjointTextBaseline(currentMarkdown, remoteMarkdown, merged)) {
        const rebased = rebasedRemoteUpdate(
          currentUpdate,
          update,
          textName,
          remoteOptions.preserveLocalMarkdown ? currentMarkdown : null,
        );
        Y.applyUpdate(doc, rebased, remoteOrigin);
      } else {
        Y.applyUpdate(doc, update, remoteOrigin);
      }

      return !bytesEqual(beforeState, Y.encodeStateVector(doc));
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
