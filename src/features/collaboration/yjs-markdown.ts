import * as Y from "yjs";

export type MarkdownCollaborator = {
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  getMarkdown: () => string;
  applyLocalMarkdown: (markdown: string) => void;
  applyRemoteUpdate: (update: Uint8Array) => void;
  encodeUpdate: () => Uint8Array;
  onUpdate: (handler: (update: Uint8Array, origin: "local" | "remote") => void) => () => void;
  destroy: () => void;
};

export type MarkdownCollaboratorOptions = {
  name?: string;
  initialMarkdown?: string;
};

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
        text.delete(0, text.length);
        if (markdown.length > 0) {
          text.insert(0, markdown);
        }
      }, localOrigin);
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
