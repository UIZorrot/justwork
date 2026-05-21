import Vditor from "vditor";
import "vditor/dist/index.css";
import "vditor/dist/js/icons/ant.js";
import "vditor/dist/js/i18n/zh_CN.js";

import { saveCollaborativeSnapshot } from "@/features/collaboration/collab-storage";
import { createVditorMarkdownBinding } from "@/features/collaboration/yjs-vditor-binding";
import { getRuntimeUrl } from "@/shared/browser-platform";
import type { CollaborativeMarkdownBinding, CreateEditorOptions, DocEditor, EditorImageUploadResult } from "../types";
import { createCompositionGate } from "./composition-gate";
import { getWysiwygToolbar } from "./wysiwyg-toolbar";

type VditorWithInsert = Vditor & {
  insertValue: (value: string, update?: boolean) => void;
};

function vditorCdnBase(): string {
  return getRuntimeUrl("vendor/vditor");
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
  const { container, initialMarkdown = "", onChange, imageSync } = options;

  let vditor: Vditor | undefined;
  let editorReady = false;
  let pendingMarkdown: { markdown: string; clearHistory: boolean } | undefined;
  const markdownInputListeners = new Set<(markdown: string) => void>();
  let lastEmittedMarkdown = initialMarkdown;
  let lastInputMarkdown = initialMarkdown;
  let lastKnownMarkdown = initialMarkdown;
  let collaboratorObserver: (() => void) | undefined;
  let collaboratorBinding: ReturnType<typeof createVditorMarkdownBinding> | undefined;
  let collaboratorState: CollaborativeMarkdownBinding | undefined;
  const compositionGate = createCompositionGate();

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
  const flushComposedMarkdown = (): void => {
    const markdown = compositionGate.onCompositionEnd(imageSync?.fromEditorMarkdown(getMarkdown()) ?? getMarkdown());
    if (markdown === null) return;
    dispatchMarkdown(markdown);
  };
  const cancelComposedMarkdown = (): void => {
    const markdown = compositionGate.onCompositionCancel(imageSync?.fromEditorMarkdown(getMarkdown()) ?? getMarkdown());
    if (markdown === null) return;
    dispatchMarkdown(markdown);
  };

  const editorSurface = {
    getMarkdown,
    setMarkdown,
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
    if (collaboratorObserver && collaboratorState) {
      collaboratorState.collaborator.text.unobserve(collaboratorObserver);
    }
    collaboratorObserver = undefined;
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
    collaboratorObserver = () => {
      saveCollaborativeSnapshot(binding.storageKey, binding.collaborator.encodeUpdate());
      onChange?.(binding.collaborator.getMarkdown());
    };
    binding.collaborator.text.observe(collaboratorObserver);
    collaboratorBinding = createVditorMarkdownBinding(editorSurface, binding.collaborator);
    if (editorReady) {
      collaboratorBinding.applyRemoteMarkdown(binding.collaborator.getMarkdown());
    }
    saveCollaborativeSnapshot(binding.storageKey, binding.collaborator.encodeUpdate());
  };

  const startingMarkdown = options.collaboratorBinding?.collaborator.getMarkdown() ?? initialMarkdown;

  ensureBundledVditorIcons();
  container.addEventListener("compositionstart", compositionGate.onCompositionStart, true);
  container.addEventListener("compositionend", flushComposedMarkdown, true);
  container.addEventListener("compositioncancel", cancelComposedMarkdown, true);
  vditor = new Vditor(container, {
    cdn: vditorCdnBase(),
    lang: "zh_CN",
    i18n: getBundledVditorI18n(),
    icon: "ant",
    theme: "classic",
    mode: "wysiwyg",
    preview: {
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
      if (gatedMarkdown === null) return;
      dispatchMarkdown(gatedMarkdown);
    },
    after: () => {
      editorReady = true;
      container.classList.add("doc-editor--ready");
      if (pendingMarkdown) {
        const { markdown, clearHistory } = pendingMarkdown;
        pendingMarkdown = undefined;
        applyMarkdown(markdown, clearHistory);
      }
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
    bindCollaborator,
    destroy: () => {
      unbindCollaborator();
      vditor?.destroy();
      vditor = undefined;
      imageSync?.dispose?.();
      container.removeEventListener("compositionstart", compositionGate.onCompositionStart, true);
      container.removeEventListener("compositionend", flushComposedMarkdown, true);
      container.removeEventListener("compositioncancel", cancelComposedMarkdown, true);
      container.classList.remove("doc-editor--ready");
    },
  };
}
