import DiffMatchPatch from "diff-match-patch";

import type { MarkdownCollaborator } from "./yjs-markdown";

export type MarkdownEditorSurface = {
  getMarkdown: () => string;
  setMarkdown: (markdown: string, clearHistory?: boolean) => void;
  onMarkdownInput: (listener: (markdown: string) => void) => () => void;
  isComposing?: () => boolean;
  isFocused?: () => boolean;
  hasRecentNativeInput?: () => boolean;
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

/** Replay only a local editor delta onto the current canonical text. */
export function replayMarkdownEdit(
  editBase: string,
  locallyEditedMarkdown: string,
  currentCollaborativeMarkdown: string,
): ComposedMarkdownMerge {
  if (locallyEditedMarkdown === editBase) {
    return { markdown: currentCollaborativeMarkdown, clean: true };
  }
  if (currentCollaborativeMarkdown === editBase) {
    return { markdown: locallyEditedMarkdown, clean: true };
  }
  const differ = new DiffMatchPatch();
  const patches = differ.patch_make(editBase, locallyEditedMarkdown);
  const [markdown, applied] = differ.patch_apply(patches, currentCollaborativeMarkdown);
  return { markdown, clean: applied.every(Boolean) };
}

/** Replay only the IME edit onto current collaborative text. */
export function mergeComposedMarkdown(
  compositionBase: string,
  composedMarkdown: string,
  currentCollaborativeMarkdown: string,
): ComposedMarkdownMerge {
  return replayMarkdownEdit(compositionBase, composedMarkdown, currentCollaborativeMarkdown);
}

export function createVditorMarkdownBinding(
  editor: MarkdownEditorSurface,
  collaborator: MarkdownCollaborator,
): VditorMarkdownBinding {
  let suppress = false;
  let remoteUpdatePendingDuringComposition = false;
  let remoteUpdatePending = false;
  let lastEditorMarkdown = editor.getMarkdown();
  let remoteRenderTimer: ReturnType<typeof setTimeout> | undefined;
  const REMOTE_RENDER_IDLE_MS = 250;

  const clearRemoteRenderTimer = (): void => {
    if (remoteRenderTimer === undefined) return;
    clearTimeout(remoteRenderTimer);
    remoteRenderTimer = undefined;
  };

  const flushRemoteMarkdown = (): void => {
    clearRemoteRenderTimer();
    if (editor.isComposing?.()) {
      remoteUpdatePendingDuringComposition = true;
      return;
    }
    // Vditor may publish its normalized Markdown after the browser's native
    // input event. Never let a remote whole-editor render erase DOM input that
    // has not reached the collaborator yet; retry once the local input burst is
    // idle and then render the single converged value.
    if (editor.hasRecentNativeInput?.()) {
      scheduleRemoteMarkdownFlush();
      return;
    }
    const markdown = collaborator.getMarkdown();
    if (editor.getMarkdown() !== markdown) {
      suppress = true;
      editor.setMarkdown(markdown, false);
      suppress = false;
    }
    lastEditorMarkdown = markdown;
    remoteUpdatePending = false;
    remoteUpdatePendingDuringComposition = false;
  };

  const scheduleRemoteMarkdownFlush = (): void => {
    clearRemoteRenderTimer();
    remoteRenderTimer = setTimeout(flushRemoteMarkdown, REMOTE_RENDER_IDLE_MS);
  };

  const syncCollaboratorFromEditor = (markdown: string): void => {
    if (suppress) return;
    suppress = true;
    const compositionBase = editor.getCompositionBaseMarkdown?.() ?? null;
    const editBase = remoteUpdatePendingDuringComposition && compositionBase !== null
      ? compositionBase
      : lastEditorMarkdown;
    const canonicalMarkdown = collaborator.getMarkdown();
    // The pending-render flag is only a UI scheduling hint. ACKs, duplicate
    // updates and delayed Vditor callbacks can clear it independently of the
    // actual editor/canonical divergence. Always replay the editor-local delta
    // whenever its base differs from Yjs so a stale DOM snapshot can never
    // delete already-merged remote edits.
    if (editBase !== canonicalMarkdown) {
      const merged = replayMarkdownEdit(editBase, markdown, canonicalMarkdown);
      collaborator.applyLocalMarkdown(merged.markdown);
    } else {
      collaborator.applyLocalMarkdown(markdown);
    }
    suppress = false;
    lastEditorMarkdown = markdown;
    if (remoteUpdatePending) {
      if (editor.isFocused?.()) {
        scheduleRemoteMarkdownFlush();
      } else {
        flushRemoteMarkdown();
      }
    }
  };

  const syncEditorFromCollaborator = (): void => {
    if (suppress) return;
    if (editor.isComposing?.()) {
      remoteUpdatePending = true;
      remoteUpdatePendingDuringComposition = true;
      return;
    }
    remoteUpdatePending = true;
    if (editor.isFocused?.()) {
      scheduleRemoteMarkdownFlush();
      return;
    }
    flushRemoteMarkdown();
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
      clearRemoteRenderTimer();
      remoteUpdatePending = false;
      remoteUpdatePendingDuringComposition = false;
      suppress = true;
      editor.setMarkdown(markdown, false);
      suppress = false;
      lastEditorMarkdown = markdown;
    },
    destroy: () => {
      clearRemoteRenderTimer();
      collaborator.text.unobserve(syncEditorFromCollaborator);
      stopInput();
    },
  };
}
