import DiffMatchPatch from "diff-match-patch";

import type { MarkdownCollaborator } from "./yjs-markdown";

export type MarkdownEditorSurface = {
  getMarkdown: () => string;
  setMarkdown: (markdown: string, clearHistory?: boolean) => void;
  onMarkdownInput: (listener: (markdown: string) => void) => () => void;
  isComposing?: () => boolean;
  getCompositionBaseMarkdown?: () => string | null;
};

export type VditorMarkdownBinding = {
  applyLocalEditorMarkdown: (markdown: string) => void;
  applyRemoteMarkdown: (markdown: string) => void;
  destroy: () => void;
};

export type ComposedMarkdownMerge = {
  markdown: string;
  clean: boolean;
};

/** Replay only the IME edit onto current collaborative text. */
export function mergeComposedMarkdown(
  compositionBase: string,
  composedMarkdown: string,
  currentCollaborativeMarkdown: string,
): ComposedMarkdownMerge {
  if (composedMarkdown === compositionBase) {
    return { markdown: currentCollaborativeMarkdown, clean: true };
  }
  if (currentCollaborativeMarkdown === compositionBase) {
    return { markdown: composedMarkdown, clean: true };
  }
  const differ = new DiffMatchPatch();
  const patches = differ.patch_make(compositionBase, composedMarkdown);
  const [markdown, applied] = differ.patch_apply(patches, currentCollaborativeMarkdown);
  return { markdown, clean: applied.every(Boolean) };
}

export function createVditorMarkdownBinding(
  editor: MarkdownEditorSurface,
  collaborator: MarkdownCollaborator,
): VditorMarkdownBinding {
  let suppress = false;
  let remoteUpdatePendingDuringComposition = false;

  const syncCollaboratorFromEditor = (markdown: string): void => {
    if (suppress) return;
    suppress = true;
    const compositionBase = editor.getCompositionBaseMarkdown?.() ?? null;
    if (remoteUpdatePendingDuringComposition && compositionBase !== null) {
      const merged = mergeComposedMarkdown(compositionBase, markdown, collaborator.getMarkdown());
      collaborator.applyLocalMarkdown(merged.markdown);
      remoteUpdatePendingDuringComposition = false;
    } else {
      collaborator.applyLocalMarkdown(markdown);
    }
    suppress = false;
  };

  const syncEditorFromCollaborator = (): void => {
    if (editor.isComposing?.()) {
      remoteUpdatePendingDuringComposition = true;
      return;
    }
    const markdown = collaborator.getMarkdown();
    if (editor.getMarkdown() === markdown) return;
    suppress = true;
    editor.setMarkdown(markdown, false);
    suppress = false;
  };

  collaborator.text.observe(syncEditorFromCollaborator);
  const stopInput = editor.onMarkdownInput(syncCollaboratorFromEditor);

  return {
    applyLocalEditorMarkdown: (markdown) => {
      if (suppress) return;
      collaborator.applyLocalMarkdown(markdown);
    },
    applyRemoteMarkdown: (markdown) => {
      if (editor.getMarkdown() === markdown) return;
      remoteUpdatePendingDuringComposition = false;
      suppress = true;
      editor.setMarkdown(markdown, false);
      suppress = false;
    },
    destroy: () => {
      collaborator.text.unobserve(syncEditorFromCollaborator);
      stopInput();
    },
  };
}
