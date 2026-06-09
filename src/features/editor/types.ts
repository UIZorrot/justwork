/** Editor-facing document wrapper. */
export type DocEditor = {
  readonly root: HTMLElement;
  getMarkdown: () => string;
  setMarkdown: (md: string, clearHistory?: boolean) => void;
  isComposing: () => boolean;
  isFocused: () => boolean;
  focus: () => void;
  replaceActiveMention: (mentionMarkdown: string) => boolean;
  bindCollaborator: (binding: CollaborativeMarkdownBinding | undefined) => void;
  destroy: () => void;
};

export type EditorMentionQueryState = {
  query: string;
  left: number;
  top: number;
  lineHeight: number;
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
  onMentionQueryChange?: (state: EditorMentionQueryState | null) => void;
  imageSync?: EditorImageSync;
  collaboratorBinding?: CollaborativeMarkdownBinding;
};

export type CollaborativeMarkdownBinding = {
  collaborator: import("../collaboration/yjs-markdown").MarkdownCollaborator;
  storageKey: string;
};
