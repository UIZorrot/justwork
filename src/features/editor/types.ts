/** 编辑器对外只暴露文档状态与生命周期，避免页面直接依赖 Vditor 类型 */
export type DocEditor = {
  readonly root: HTMLElement;
  getMarkdown: () => string;
  setMarkdown: (md: string, clearHistory?: boolean) => void;
  destroy: () => void;
};

export type CreateEditorOptions = {
  container: HTMLElement;
  /** 初始 Markdown（底层存储格式；用户通过工具栏操作，不强制源码编辑） */
  initialMarkdown?: string;
  onChange?: (markdown: string) => void;
};
