export type CompositionGate = {
  isComposing: () => boolean;
  onCompositionStart: () => void;
  onCompositionEnd: (currentMarkdown: string) => string | null;
  onCompositionCancel: (currentMarkdown: string) => string | null;
  onInput: (markdown: string) => string | null;
};

export function createCompositionGate(): CompositionGate {
  let composing = false;
  let pendingMarkdown: string | null = null;

  const flush = (currentMarkdown: string): string | null => {
    const nextMarkdown = pendingMarkdown ?? currentMarkdown;
    pendingMarkdown = null;
    return nextMarkdown;
  };

  return {
    isComposing: () => composing,
    onCompositionStart: () => {
      composing = true;
      pendingMarkdown = null;
    },
    onCompositionEnd: (currentMarkdown) => {
      composing = false;
      return flush(currentMarkdown);
    },
    onCompositionCancel: (currentMarkdown) => {
      composing = false;
      return flush(currentMarkdown);
    },
    onInput: (markdown) => {
      if (!composing) return markdown;
      pendingMarkdown = markdown;
      return null;
    },
  };
}
