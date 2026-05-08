import type { MarkdownCollaborator } from "./yjs-markdown";

export type MarkdownEditorSurface = {
  readonly root: HTMLElement;
  getMarkdown: () => string;
  setMarkdown: (markdown: string, clearHistory?: boolean) => void;
};

export type VditorMarkdownBinding = {
  applyLocalEditorMarkdown: (markdown: string) => void;
  applyRemoteMarkdown: (markdown: string) => void;
  destroy: () => void;
};

export function createVditorMarkdownBinding(
  editor: MarkdownEditorSurface,
  collaborator: MarkdownCollaborator,
): VditorMarkdownBinding {
  let suppress = false;

  const syncCollaboratorFromEditor = (): void => {
    if (suppress) return;
    collaborator.applyLocalMarkdown(editor.getMarkdown());
  };

  const syncEditorFromCollaborator = (): void => {
    const markdown = collaborator.getMarkdown();
    if (editor.getMarkdown() === markdown) return;
    suppress = true;
    editor.setMarkdown(markdown, false);
    suppress = false;
  };

  collaborator.text.observe(syncEditorFromCollaborator);
  editor.root.addEventListener("input", syncCollaboratorFromEditor, true);
  editor.root.addEventListener("change", syncCollaboratorFromEditor, true);

  return {
    applyLocalEditorMarkdown: (markdown) => {
      if (suppress) return;
      collaborator.applyLocalMarkdown(markdown);
    },
    applyRemoteMarkdown: (markdown) => {
      if (editor.getMarkdown() === markdown) return;
      suppress = true;
      editor.setMarkdown(markdown, false);
      suppress = false;
    },
    destroy: () => {
      collaborator.text.unobserve(syncEditorFromCollaborator);
      editor.root.removeEventListener("input", syncCollaboratorFromEditor, true);
      editor.root.removeEventListener("change", syncCollaboratorFromEditor, true);
    },
  };
}
