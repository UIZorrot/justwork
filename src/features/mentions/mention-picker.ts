export type MentionPickerCandidate = {
  userId: string;
  displayName: string;
};

export type MentionPickerQueryState = {
  query: string;
  left: number;
  top: number;
  lineHeight?: number;
};

export type MentionPickerLabels = {
  empty: string;
};

type MentionPickerOptions = {
  document: Document;
  labels: MentionPickerLabels;
  onSelect: (candidate: MentionPickerCandidate) => void;
};

export type MentionPickerHandle = {
  readonly element: HTMLElement;
  readonly isOpen: () => boolean;
  open: (queryState: MentionPickerQueryState, candidates: MentionPickerCandidate[]) => void;
  close: () => void;
  handleKeyDown: (event: KeyboardEvent) => boolean;
  destroy: () => void;
};

function filterCandidates(candidates: MentionPickerCandidate[], query: string): MentionPickerCandidate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...candidates];
  return candidates.filter((candidate) => candidate.displayName.toLowerCase().includes(needle));
}

export function createMentionPicker(options: MentionPickerOptions): MentionPickerHandle {
  const root = options.document.createElement("div");
  root.className = "mention-picker";
  root.hidden = true;
  options.document.body.appendChild(root);

  let open = false;
  let activeIndex = 0;
  let filtered: MentionPickerCandidate[] = [];

  const selectActive = (): boolean => {
    const candidate = filtered[activeIndex];
    if (!candidate) return false;
    options.onSelect(candidate);
    return true;
  };

  const render = (): void => {
    root.replaceChildren();
    if (filtered.length === 0) {
      const empty = options.document.createElement("div");
      empty.className = "mention-picker-empty";
      empty.textContent = options.labels.empty;
      root.appendChild(empty);
      return;
    }
    filtered.forEach((candidate, index) => {
      const button = options.document.createElement("button");
      button.type = "button";
      button.className = `mention-picker-item${index === activeIndex ? " is-active" : ""}`;
      button.textContent = candidate.displayName;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        activeIndex = index;
        selectActive();
      });
      root.appendChild(button);
    });
  };

  return {
    element: root,
    isOpen: () => open,
    open: (queryState, candidates) => {
      filtered = filterCandidates(candidates, queryState.query);
      activeIndex = 0;
      render();
      root.style.left = `${queryState.left}px`;
      root.style.top = `${queryState.top + (queryState.lineHeight ?? 24)}px`;
      root.hidden = false;
      open = true;
    },
    close: () => {
      open = false;
      filtered = [];
      activeIndex = 0;
      root.hidden = true;
      root.replaceChildren();
    },
    handleKeyDown: (event) => {
      if (!open) return false;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (filtered.length > 0) {
          activeIndex = (activeIndex + 1) % filtered.length;
          render();
        }
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (filtered.length > 0) {
          activeIndex = (activeIndex - 1 + filtered.length) % filtered.length;
          render();
        }
        return true;
      }
      if (event.key === "Enter") {
        if (selectActive()) {
          event.preventDefault();
          return true;
        }
        return false;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        root.hidden = true;
        open = false;
        filtered = [];
        activeIndex = 0;
        root.replaceChildren();
        return true;
      }
      return false;
    },
    destroy: () => {
      root.remove();
    },
  };
}
