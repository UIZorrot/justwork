/** Editor-facing document wrapper. */
export type DocEditor = {
  readonly root: HTMLElement;
  getMarkdown: () => string;
  setMarkdown: (md: string, clearHistory?: boolean) => void;
  destroy: () => void;
};

export type EditorImageUploadResult = {
  assetId: string;
  localUrl: string;
  html: string;
};

export type EditorImageSync = {
  toEditorMarkdown: (markdown: string) => string;
  fromEditorMarkdown: (markdown: string) => string;
  uploadFiles: (files: File[]) => Promise<EditorImageUploadResult[]>;
  dispose?: () => void;
};

export type CreateEditorOptions = {
  container: HTMLElement;
  /** Initial markdown stored in the workspace. */
  initialMarkdown?: string;
  onChange?: (markdown: string) => void;
  imageSync?: EditorImageSync;
};
