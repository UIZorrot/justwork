import Vditor from "vditor";
import "vditor/dist/index.css";
import "vditor/dist/js/icons/ant.js";
import "vditor/dist/js/i18n/zh_CN.js";

import type { CreateEditorOptions, DocEditor, EditorImageUploadResult } from "../types";
import { getWysiwygToolbar } from "./wysiwyg-toolbar";

type VditorWithInsert = Vditor & {
  insertValue: (value: string, update?: boolean) => void;
};

function vditorCdnBase(): string {
  return chrome.runtime.getURL("vendor/vditor");
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

  vditor = new Vditor(container, {
    cdn: vditorCdnBase(),
    lang: "zh_CN",
    icon: "ant",
    theme: "classic",
    mode: "wysiwyg",
    toolbar: getWysiwygToolbar(),
    cache: {
      enable: false,
    },
    minHeight: 240,
    height: "100%",
    value: imageSync?.toEditorMarkdown(initialMarkdown) ?? initialMarkdown,
    input: (value) => {
      onChange?.(imageSync?.fromEditorMarkdown(value) ?? value);
    },
    after: () => {
      container.classList.add("doc-editor--ready");
    },
    upload: imageSync
      ? {
          handler: async (files: FileList | File[]) => {
            const results = await imageSync.uploadFiles(Array.from(files));
            insertUploadResults(vditor, results);
            return null;
          },
        }
      : undefined,
  });

  return {
    root: container,
    getMarkdown: () => vditor?.getValue() ?? "",
    setMarkdown: (md, clearHistory) => {
      vditor?.setValue(imageSync?.toEditorMarkdown(md) ?? md, clearHistory ?? false);
    },
    destroy: () => {
      vditor?.destroy();
      vditor = undefined;
      imageSync?.dispose?.();
      container.classList.remove("doc-editor--ready");
    },
  };
}
