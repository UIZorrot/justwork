/**
 * 所见即所得排版工具栏：不包含切换到分屏 / IR / 源码模式的按钮，
 * 避免把用户带进「纯 Markdown 编辑」心智。
 *
 * 名称与 Vditor 默认集合对齐，便于日后对照官方文档调整。
 */
export function getWysiwygToolbar(): Array<string | { name: string }> {
  return [
    "emoji",
    "headings",
    "bold",
    "italic",
    "strike",
    "|",
    "line",
    "quote",
    "list",
    "ordered-list",
    "check",
    "outdent",
    "indent",
    "|",
    "code",
    "inline-code",
    "insert-after",
    "insert-before",
    "undo",
    "redo",
    "|",
    "upload",
    "link",
    "table",
    "record",
    "|",
    "fullscreen",
    "outline",
    "code-theme",
    "content-theme",
    "export",
  ];
}
