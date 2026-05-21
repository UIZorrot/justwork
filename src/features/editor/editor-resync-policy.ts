export function shouldResyncEditorMarkdown(currentMarkdown: string, nextMarkdown: string): boolean {
  return currentMarkdown !== nextMarkdown;
}
