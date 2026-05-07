import Vditor from "vditor";
import "vditor/dist/index.css";
import "vditor/dist/js/icons/ant.js";
import "vditor/dist/js/i18n/zh_CN.js";

import type { CreateEditorOptions, DocEditor } from "../types";
import { getWysiwygToolbar } from "./wysiwyg-toolbar";

function vditorCdnBase(): string {
  return chrome.runtime.getURL("vendor/vditor");
}

export function createWysiwygEditor(options: CreateEditorOptions): DocEditor {
  const { container, initialMarkdown = "", onChange } = options;

  let vditor: Vditor | undefined;

  // cache.enable 为 false 时可直接传入挂载节点，无需为 cache.id 提供字符串 id
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
    value: initialMarkdown,
    input: (value) => {
      onChange?.(value);
    },
    after: () => {
      container.classList.add("doc-editor--ready");
    },
  });

  return {
    root: container,
    getMarkdown: () => vditor?.getValue() ?? "",
    setMarkdown: (md, clearHistory) => {
      vditor?.setValue(md, clearHistory ?? false);
    },
    destroy: () => {
      vditor?.destroy();
      vditor = undefined;
      container.classList.remove("doc-editor--ready");
    },
  };
}
