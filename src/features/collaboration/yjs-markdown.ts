import * as Y from "yjs";

export type MarkdownCollaborator = {
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  getMarkdown: () => string;
  applyLocalMarkdown: (markdown: string) => void;
  applyRemoteUpdate: (update: Uint8Array) => void;
  encodeUpdate: () => Uint8Array;
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

  if (options.initialMarkdown) {
    text.insert(0, options.initialMarkdown);
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
      });
    },
    applyRemoteUpdate: (update) => {
      Y.applyUpdate(doc, update);
    },
    encodeUpdate: () => Y.encodeStateAsUpdate(doc),
    destroy: () => {
      doc.destroy();
    },
  };
}
