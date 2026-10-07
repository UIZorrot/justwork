export type CompositionGate = {
  isComposing: () => boolean;
  onCompositionStart: () => void;
  onCompositionEnd: (currentMarkdown: string) => string | null;
  onCompositionCancel: (currentMarkdown: string) => string | null;
  onInput: (markdown: string) => string | null;
};

export function createCompositionGate(): CompositionGate {
  let composing = false;

  return {
    isComposing: () => composing,
    onCompositionStart: () => {
      composing = true;
    },
    onCompositionEnd: (currentMarkdown) => {
      composing = false;
      return currentMarkdown;
    },
    onCompositionCancel: (currentMarkdown) => {
      composing = false;
      return currentMarkdown;
    },
    onInput: (markdown) => {
      if (!composing) return markdown;
      return null;
    },
  };
}
