import Vditor from "vditor";
import "vditor/dist/index.css";
import "vditor/dist/js/icons/ant.js";
import "vditor/dist/js/i18n/zh_CN.js";

import { saveCollaborativeSnapshot } from "@/features/collaboration/collab-storage";
import { createVditorMarkdownBinding } from "@/features/collaboration/yjs-vditor-binding";
import { getRuntimeUrl } from "@/shared/browser-platform";
import type {
  CollaborativeMarkdownBinding,
  CreateEditorOptions,
  DocEditor,
  EditorImageUploadResult,
  EditorMentionQueryState,
} from "../types";
import { createCompositionGate } from "./composition-gate";
import { getWysiwygToolbar } from "./wysiwyg-toolbar";

type VditorWithInsert = Vditor & {
  insertValue: (value: string, update?: boolean) => void;
  insertMD: (markdown: string) => void;
  focus: () => void;
  getCursorPosition: () => { left: number; top: number };
};

type ResolvedMentionQuery = EditorMentionQueryState & {
  startContainer: Node;
  startOffset: number;
};

function resolveSelectionRect(range: Range): { left: number; top: number; height: number } | null {
  const rect = range.getBoundingClientRect?.();
  if (rect && (rect.width > 0 || rect.height > 0)) {
    return {
      left: rect.left,
      top: rect.top,
      height: rect.height || 24,
    };
  }
  const parentRect = range.startContainer.parentElement?.getBoundingClientRect?.();
  if (parentRect) {
    return {
      left: parentRect.left,
      top: parentRect.top,
      height: parentRect.height || 24,
    };
  }
  return null;
}

function vditorCdnBase(): string {
  return getRuntimeUrl("vendor/vditor");
}

function vditorAssetPaths(): {
  cdn: string;
  emojiPath: string;
  contentThemePath: string;
} {
  const cdn = vditorCdnBase();
  return {
    cdn,
    emojiPath: `${cdn}/dist/images/emoji`,
    contentThemePath: `${cdn}/dist/css/content-theme`,
  };
}

function getBundledVditorI18n(): ITips | undefined {
  if (typeof window === "undefined") return undefined;
  return window.VditorI18n;
}

function ensureBundledVditorIcons(): void {
  if (document.getElementById("vditorIconScript")) return;
  const marker = document.createElement("meta");
  marker.id = "vditorIconScript";
  marker.dataset.source = "bundled";
  document.head.appendChild(marker);
}

function insertUploadResults(vditor: Vditor | undefined, results: EditorImageUploadResult[]): void {
  if (!vditor) return;
  const editor = vditor as VditorWithInsert;
  for (const result of results) {
    editor.insertValue(result.html);
  }
}

export function createWysiwygEditor(options: CreateEditorOptions): DocEditor {
  const { container, initialMarkdown = "", onChange, onMentionQueryChange, imageSync } = options;

  let vditor: Vditor | undefined;
  let editorReady = false;
  let pendingMarkdown: { markdown: string; clearHistory: boolean } | undefined;
  const markdownInputListeners = new Set<(markdown: string) => void>();
  let lastEmittedMarkdown = initialMarkdown;
  let lastInputMarkdown = initialMarkdown;
  let lastKnownMarkdown = initialMarkdown;
  let stopCollaboratorObserver: (() => void) | undefined;
  let collaboratorBinding: ReturnType<typeof createVditorMarkdownBinding> | undefined;
  let collaboratorState: CollaborativeMarkdownBinding | undefined;
  let compositionBaseMarkdown: string | null = null;
  const compositionGate = createCompositionGate();
  const clearMentionQuery = (): void => onMentionQueryChange?.(null);

  const resolveMentionQuery = (): ResolvedMentionQuery | null => {
    if (!editorReady || !vditor || compositionGate.isComposing()) return null;
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!container.contains(range.startContainer) || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
    const rawText = range.startContainer.textContent?.slice(0, range.startOffset) ?? "";
    const match = rawText.match(/(?:^|[\s([{>])@([\p{L}\p{N}_-]*)$/u);
    if (!match) return null;
    const startOffset = rawText.lastIndexOf("@");
    if (startOffset === -1) return null;
    const selectionRect = resolveSelectionRect(range)
      ?? (() => {
        const cursor = (vditor as VditorWithInsert).getCursorPosition?.() ?? { left: 0, top: 0 };
        return { left: cursor.left, top: cursor.top, height: 24 };
      })();
    const lineHeightRaw = Number.parseInt(window.getComputedStyle(container).lineHeight, 10);
    return {
      query: match[1] ?? "",
      left: selectionRect.left,
      top: selectionRect.top,
      lineHeight: Number.isFinite(lineHeightRaw) ? lineHeightRaw : selectionRect.height,
      startContainer: range.startContainer,
      startOffset,
    };
  };

  const notifyMentionQueryChange = (): void => {
    if (!onMentionQueryChange) return;
    const query = resolveMentionQuery();
    if (!query) {
      onMentionQueryChange(null);
      return;
    }
    onMentionQueryChange({
      query: query.query,
      left: query.left,
      top: query.top,
      lineHeight: query.lineHeight,
    });
  };

  const getMarkdown = (): string => {
    if (!editorReady || !vditor) {
      return pendingMarkdown?.markdown ?? lastKnownMarkdown;
    }
    try {
      const next = imageSync?.fromEditorMarkdown(vditor.getValue()) ?? vditor.getValue();
      lastKnownMarkdown = next;
      return next;
    } catch {
      return pendingMarkdown?.markdown ?? lastKnownMarkdown;
    }
  };
  const applyMarkdown = (markdown: string, clearHistory: boolean): void => {
    lastKnownMarkdown = markdown;
    vditor?.setValue(imageSync?.toEditorMarkdown(markdown) ?? markdown, clearHistory);
  };
  const setMarkdown = (markdown: string, clearHistory?: boolean): void => {
    const nextClearHistory = clearHistory ?? false;
    if (!editorReady || !vditor) {
      lastKnownMarkdown = markdown;
      pendingMarkdown = { markdown, clearHistory: nextClearHistory };
      return;
    }
    applyMarkdown(markdown, nextClearHistory);
  };
  const emitMarkdown = (markdown: string): void => {
    if (markdown === lastEmittedMarkdown) return;
    lastEmittedMarkdown = markdown;
    onChange?.(markdown);
  };
  const notifyMarkdownInput = (markdown: string): void => {
    if (markdown === lastInputMarkdown) return;
    lastInputMarkdown = markdown;
    for (const listener of markdownInputListeners) {
      listener(markdown);
    }
  };
  const dispatchMarkdown = (markdown: string): void => {
    if (markdownInputListeners.size > 0) {
      notifyMarkdownInput(markdown);
      return;
    }
    emitMarkdown(markdown);
  };
  const startComposingMarkdown = (): void => {
    compositionBaseMarkdown = imageSync?.fromEditorMarkdown(getMarkdown()) ?? getMarkdown();
    compositionGate.onCompositionStart();
  };
  const flushComposedMarkdown = (): void => {
    const markdown = compositionGate.onCompositionEnd(imageSync?.fromEditorMarkdown(getMarkdown()) ?? getMarkdown());
    if (markdown === null) return;
    dispatchMarkdown(markdown);
    compositionBaseMarkdown = null;
    queueMicrotask(notifyMentionQueryChange);
  };
  const cancelComposedMarkdown = (): void => {
    const markdown = compositionGate.onCompositionCancel(imageSync?.fromEditorMarkdown(getMarkdown()) ?? getMarkdown());
    if (markdown === null) return;
    dispatchMarkdown(markdown);
    compositionBaseMarkdown = null;
    queueMicrotask(notifyMentionQueryChange);
  };

  const editorSurface = {
    getMarkdown,
    setMarkdown,
    isComposing: compositionGate.isComposing,
    getCompositionBaseMarkdown: () => compositionBaseMarkdown,
    onMarkdownInput: (listener: (markdown: string) => void): (() => void) => {
      markdownInputListeners.add(listener);
      return () => {
        markdownInputListeners.delete(listener);
      };
    },
  };

  const unbindCollaborator = (): void => {
    if (collaboratorBinding) {
      collaboratorBinding.destroy();
      collaboratorBinding = undefined;
    }
    stopCollaboratorObserver?.();
    stopCollaboratorObserver = undefined;
    collaboratorState = undefined;
  };

  const bindCollaborator = (binding: CollaborativeMarkdownBinding | undefined): void => {
    if (
      binding &&
      collaboratorState &&
      collaboratorState.collaborator === binding.collaborator &&
      collaboratorState.storageKey === binding.storageKey
    ) {
      return;
    }
    if (!binding && !collaboratorState) {
      return;
    }
    unbindCollaborator();
    if (!binding) return;
    collaboratorState = binding;
    stopCollaboratorObserver = binding.collaborator.onUpdate((_update, origin) => {
      saveCollaborativeSnapshot(binding.storageKey, binding.collaborator.encodeUpdate());
      if (origin === "local") {
        onChange?.(binding.collaborator.getMarkdown());
      }
    });
    collaboratorBinding = createVditorMarkdownBinding(editorSurface, binding.collaborator);
    if (editorReady) {
      collaboratorBinding.applyRemoteMarkdown(binding.collaborator.getMarkdown());
    }
    saveCollaborativeSnapshot(binding.storageKey, binding.collaborator.encodeUpdate());
  };

  const startingMarkdown = options.collaboratorBinding?.collaborator.getMarkdown() ?? initialMarkdown;

  ensureBundledVditorIcons();
  const vditorAssets = vditorAssetPaths();
  container.addEventListener("compositionstart", startComposingMarkdown, true);
  container.addEventListener("compositionend", flushComposedMarkdown, true);
  container.addEventListener("compositioncancel", cancelComposedMarkdown, true);
  container.addEventListener("keyup", notifyMentionQueryChange, true);
  container.addEventListener("mouseup", notifyMentionQueryChange, true);
  container.addEventListener("blur", clearMentionQuery, true);
  vditor = new Vditor(container, {
    cdn: vditorAssets.cdn,
    lang: "zh_CN",
    i18n: getBundledVditorI18n(),
    icon: "ant",
    theme: "classic",
    mode: "wysiwyg",
    hint: {
      emojiPath: vditorAssets.emojiPath,
    },
    preview: {
      theme: {
        current: "light",
        path: vditorAssets.contentThemePath,
      },
      markdown: {
        codeBlockPreview: false,
        mathBlockPreview: false,
      },
      math: {
        engine: "KaTeX",
      },
    },
    toolbar: getWysiwygToolbar(),
    // Newer Vditor internals call this hook unconditionally.
    // Provide a no-op to avoid runtime TypeError on some builds.
    customWysiwygToolbar: () => {},
    cache: {
      enable: false,
    },
    minHeight: 240,
    height: "100%",
    value: imageSync?.toEditorMarkdown(startingMarkdown) ?? startingMarkdown,
    input: (value) => {
      const markdown = imageSync?.fromEditorMarkdown(value) ?? value;
      lastKnownMarkdown = markdown;
      const gatedMarkdown = compositionGate.onInput(markdown);
      if (gatedMarkdown === null) {
        queueMicrotask(notifyMentionQueryChange);
        return;
      }
      dispatchMarkdown(gatedMarkdown);
      queueMicrotask(notifyMentionQueryChange);
    },
    after: () => {
      editorReady = true;
      container.classList.add("doc-editor--ready");
      if (pendingMarkdown) {
        const { markdown, clearHistory } = pendingMarkdown;
        pendingMarkdown = undefined;
        applyMarkdown(markdown, clearHistory);
      }
      notifyMentionQueryChange();
    },
    upload: imageSync
      ? {
          handler: async (files: FileList | File[]) => {
            const results = await imageSync.uploadFiles(Array.from(files));
            insertUploadResults(vditor, results);
            const currentMarkdown = imageSync.fromEditorMarkdown(vditor?.getValue() ?? "");
            if (markdownInputListeners.size > 0) {
              notifyMarkdownInput(currentMarkdown);
            } else {
              emitMarkdown(currentMarkdown);
            }
            return null;
          },
        }
      : undefined,
  });
  if (options.collaboratorBinding) {
    bindCollaborator(options.collaboratorBinding);
  }

  return {
    root: container,
    getMarkdown,
    setMarkdown,
    isComposing: compositionGate.isComposing,
    isFocused: () => container.contains(document.activeElement),
    focus: () => {
      (vditor as VditorWithInsert | undefined)?.focus?.();
    },
    replaceActiveMention: (mentionMarkdown: string) => {
      if (!vditor || compositionGate.isComposing()) return false;
      const resolved = resolveMentionQuery();
      const selection = window.getSelection?.();
      if (!resolved || !selection || selection.rangeCount === 0) return false;
      const range = selection.getRangeAt(0);
      range.setStart(resolved.startContainer, resolved.startOffset);
      range.deleteContents();
      selection.removeAllRanges();
      selection.addRange(range);
      (vditor as VditorWithInsert).insertMD(`${mentionMarkdown} `);
      dispatchMarkdown(getMarkdown());
      queueMicrotask(notifyMentionQueryChange);
      return true;
    },
    bindCollaborator,
    destroy: () => {
      unbindCollaborator();
      vditor?.destroy();
      vditor = undefined;
      imageSync?.dispose?.();
      container.removeEventListener("compositionstart", startComposingMarkdown, true);
      container.removeEventListener("compositionend", flushComposedMarkdown, true);
      container.removeEventListener("compositioncancel", cancelComposedMarkdown, true);
      container.removeEventListener("keyup", notifyMentionQueryChange, true);
      container.removeEventListener("mouseup", notifyMentionQueryChange, true);
      container.removeEventListener("blur", clearMentionQuery, true);
      container.classList.remove("doc-editor--ready");
    },
  };
}
