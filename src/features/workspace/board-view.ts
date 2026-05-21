import {
  addBoardCard,
  addBoardCardField,
  addBoardColumn,
  addBoardTemplateCard,
  addBoardTemplateField,
  moveBoardCard,
  recolorBoardColumn,
  removeBoardCard,
  removeBoardColumn,
  removeBoardCardField,
  removeBoardTemplateCard,
  removeBoardTemplateField,
  renameBoardColumn,
  updateBoardCardField,
  updateBoardCardStatus,
  updateBoardCardTitle,
  updateBoardTemplateField,
} from "./board-state";
import {
  BOARD_COLUMN_COLORS,
  BOARD_CARD_STATUSES,
  boardCardSummary,
  normalizeStructuredDocumentContent,
  type BoardCard,
  type BoardCardStatus,
  type BoardDocumentContent,
} from "./structured-document";

type DocumentLike = Pick<Document, "createElement">;

type Labels = {
  addColumn: string;
  addCard: string;
  deleteColumn: string;
  deleteCard: string;
  addField: string;
  removeField: string;
  template: string;
  statuses: Record<BoardCardStatus, string>;
};

export type BoardViewOptions = {
  document: DocumentLike;
  content: BoardDocumentContent;
  onChange?: (content: BoardDocumentContent) => void;
  labels?: Partial<Labels>;
};

export type BoardViewHandle = {
  element: HTMLElement;
  update: (content: BoardDocumentContent) => void;
  destroy?: () => void;
};

type SortableEndEvent = {
  item?: HTMLElement | null;
  to?: HTMLElement | null;
  newIndex?: number | null;
};

type SortableOptions = {
  animation?: number;
  group?: string;
  draggable?: string;
  handle?: string;
  ghostClass?: string;
  chosenClass?: string;
  dragClass?: string;
  fallbackOnBody?: boolean;
  swapThreshold?: number;
  onEnd?: (event: SortableEndEvent) => void;
};

type SortableInstance = { destroy: () => void };
type SortableCtor = {
  create?: (element: HTMLElement, options: SortableOptions) => SortableInstance;
  new (element: HTMLElement, options: SortableOptions): SortableInstance;
};

let sortableCtorPromise: Promise<SortableCtor | null> | null = null;

async function loadSortableCtor(): Promise<SortableCtor | null> {
  if (typeof window === "undefined") return null;
  if (sortableCtorPromise) return sortableCtorPromise;
  sortableCtorPromise = import("sortablejs")
    .then((mod) => (mod.default ?? mod) as SortableCtor)
    .catch(() => null);
  return sortableCtorPromise;
}

function createButton(
  document: DocumentLike,
  className: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button") as HTMLButtonElement;
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function createInput(
  document: DocumentLike,
  className: string,
  value: string,
  onInput: (value: string) => void,
  readOnly = false,
  focusKey?: string,
): HTMLInputElement {
  const input = document.createElement("input") as HTMLInputElement;
  input.type = "text";
  input.className = className;
  input.value = value;
  input.readOnly = readOnly;
  if (focusKey) input.dataset.focusKey = focusKey;
  input.addEventListener("input", () => onInput(input.value));
  return input;
}

function createTextarea(
  document: DocumentLike,
  className: string,
  value: string,
  onInput: (value: string) => void,
  focusKey?: string,
): HTMLTextAreaElement {
  const textarea = document.createElement("textarea") as HTMLTextAreaElement;
  textarea.className = className;
  textarea.value = value;
  if (focusKey) textarea.dataset.focusKey = focusKey;
  textarea.addEventListener("input", () => onInput(textarea.value));
  return textarea;
}

type FocusState = {
  key: string;
  selectionStart: number | null;
  selectionEnd: number | null;
};

function isDescendant(root: HTMLElement, node: HTMLElement | null): boolean {
  let current: HTMLElement | null = node;
  while (current) {
    if (current === root) return true;
    current = (current.parentNode as HTMLElement | null) ?? null;
  }
  return false;
}

function captureFocusState(root: HTMLElement): FocusState | null {
  const ownerDocument = root.ownerDocument as (Document & { activeElement?: Element | null }) | undefined;
  const activeElement = ownerDocument?.activeElement as (HTMLElement & {
    dataset?: DOMStringMap;
    selectionStart?: number | null;
    selectionEnd?: number | null;
  }) | null;
  if (!activeElement || !isDescendant(root, activeElement)) return null;
  const key = activeElement.dataset?.focusKey?.trim();
  if (!key) return null;
  return {
    key,
    selectionStart: typeof activeElement.selectionStart === "number" ? activeElement.selectionStart : null,
    selectionEnd: typeof activeElement.selectionEnd === "number" ? activeElement.selectionEnd : null,
  };
}

function findElementByFocusKey(root: HTMLElement, focusKey: string): (HTMLElement & {
  focus?: () => void;
  setSelectionRange?: (start: number, end: number) => void;
}) | null {
  const children = [...root.children] as HTMLElement[];
  for (const child of children) {
    if ((child.dataset?.focusKey ?? "") === focusKey) return child as HTMLElement & {
      focus?: () => void;
      setSelectionRange?: (start: number, end: number) => void;
    };
    const nested = findElementByFocusKey(child, focusKey);
    if (nested) return nested;
  }
  return null;
}

function restoreFocusState(root: HTMLElement, state: FocusState | null): void {
  if (!state) return;
  const nextActive = findElementByFocusKey(root, state.key);
  if (!nextActive) return;
  nextActive.focus?.();
  if (state.selectionStart != null && state.selectionEnd != null) {
    nextActive.setSelectionRange?.(state.selectionStart, state.selectionEnd);
  }
}

function appendColorSwatches(
  document: DocumentLike,
  selectedColor: string,
  onPick: (color: string) => void,
): HTMLElement {
  const palette = document.createElement("div") as HTMLElement;
  palette.className = "structured-board-color-picker";
  for (const color of BOARD_COLUMN_COLORS) {
    const button = document.createElement("button") as HTMLButtonElement;
    button.type = "button";
    button.className = color === selectedColor
      ? "structured-board-color-swatch is-selected"
      : "structured-board-color-swatch";
    button.setAttribute("aria-label", color);
    button.dataset.color = color;
    button.setAttribute("style", `--board-column-color:${color};`);
    button.addEventListener("click", () => onPick(color));
    palette.append(button);
  }
  return palette;
}

export function createBoardView(options: BoardViewOptions): BoardViewHandle {
  let current = normalizeStructuredDocumentContent("board", options.content) as BoardDocumentContent;
  let selectedCardId: string | null = null;
  let templateEditorOpen = false;
  let templateCollapsed = false;
  let sortables: SortableInstance[] = [];
  let sortableBindToken = 0;

  const labels: Labels = {
    addColumn: options.labels?.addColumn ?? "Add column",
    addCard: options.labels?.addCard ?? "Add card",
    deleteColumn: options.labels?.deleteColumn ?? "Delete column",
    deleteCard: options.labels?.deleteCard ?? "Delete card",
    addField: options.labels?.addField ?? "Add field",
    removeField: options.labels?.removeField ?? "Remove field",
    template: options.labels?.template ?? "Template",
    statuses: options.labels?.statuses ?? {
      todo: "To do",
      doing: "Doing",
      done: "Done",
      paused: "Paused",
    },
  };

  const createStatusSelect = (card: BoardCard, focusKey: string): HTMLSelectElement => {
    const select = options.document.createElement("select") as HTMLSelectElement;
    select.className = "structured-board-card-status";
    select.dataset.focusKey = focusKey;
    select.addEventListener("click", (event) => event.stopPropagation());
    select.addEventListener("pointerdown", (event) => event.stopPropagation());
    for (const status of BOARD_CARD_STATUSES) {
      const option = options.document.createElement("option") as HTMLOptionElement;
      option.value = status;
      option.textContent = labels.statuses[status];
      select.append(option);
    }
    select.value = card.status;
    select.addEventListener("change", () => {
      emit(updateBoardCardStatus(current, card.id, select.value as BoardCardStatus));
    });
    return select;
  };

  const root = options.document.createElement("div") as HTMLElement;
  root.className = "structured-surface structured-board-layout";

  const destroySortables = (): void => {
    for (const sortable of sortables) sortable.destroy();
    sortables = [];
  };

  const selectedCard = (): BoardCard | undefined => (
    selectedCardId ? current.cards.find((card) => card.id === selectedCardId) : undefined
  );

  const isTemplateCard = (cardId: string | null): boolean => (
    Boolean(cardId && current.template.cardIds.includes(cardId))
  );

  const emit = (next: BoardDocumentContent): void => {
    current = normalizeStructuredDocumentContent("board", next) as BoardDocumentContent;
    if (selectedCardId && !current.cards.some((card) => card.id === selectedCardId)) {
      selectedCardId = null;
    }
    render();
    options.onChange?.(current);
  };

  const bindSortables = async (lists: HTMLElement[]): Promise<void> => {
    destroySortables();
    sortableBindToken += 1;
    const bindToken = sortableBindToken;
    const SortableCtor = await loadSortableCtor();
    if (!SortableCtor || bindToken !== sortableBindToken) return;

    for (const list of lists) {
      const sortableOptions: SortableOptions = {
        group: "justwork-board-cards",
        animation: 160,
        draggable: ".structured-board-card",
        handle: ".structured-board-card-grip",
        ghostClass: "is-drag-ghost",
        chosenClass: "is-drag-chosen",
        dragClass: "is-dragging",
        fallbackOnBody: true,
        swapThreshold: 0.65,
        onEnd: (event) => {
          const cardId = event.item?.dataset.cardId?.trim();
          const columnId = event.to?.dataset.columnId?.trim();
          if (!cardId || !columnId) return;
          const newIndex = typeof event.newIndex === "number" ? event.newIndex : 0;
          selectedCardId = cardId;
          emit(moveBoardCard(current, cardId, columnId, newIndex));
        },
      };
      const instance = typeof SortableCtor.create === "function"
        ? SortableCtor.create(list, sortableOptions)
        : new SortableCtor(list, sortableOptions);
      sortables.push(instance);
    }
  };

  const renderTemplateLane = (): HTMLElement => {
    const lane = options.document.createElement("section") as HTMLElement;
    lane.className = templateCollapsed
      ? "structured-board-column structured-board-column--template is-collapsed"
      : "structured-board-column structured-board-column--template";

    const accent = options.document.createElement("div") as HTMLElement;
    accent.className = "structured-board-column-accent structured-board-column-accent--template";
    lane.append(accent);

    const header = options.document.createElement("div") as HTMLElement;
    header.className = "structured-board-column-toprow";
    const badge = options.document.createElement("span") as HTMLElement;
    badge.className = "structured-board-template-badge";
    badge.textContent = labels.template;
    const toggle = createButton(
      options.document,
      "structured-board-template-toggle",
      templateCollapsed ? ">" : "<",
      () => {
        templateCollapsed = !templateCollapsed;
        render();
      },
    );
    toggle.setAttribute("aria-label", templateCollapsed ? "Expand" : "Collapse");
    const spacer = options.document.createElement("div") as HTMLElement;
    spacer.className = "structured-board-template-spacer";
    header.append(badge, spacer, toggle);
    lane.append(header);

    if (templateCollapsed) {
      return lane;
    }

    lane.append(createButton(
      options.document,
      "structured-action-btn structured-action-btn--subtle",
      labels.addCard,
      () => {
        const next = addBoardTemplateCard(current);
        selectedCardId = next.template.cardIds.at(-1) ?? null;
        templateEditorOpen = true;
        emit(next);
      },
    ));

    const list = options.document.createElement("div") as HTMLElement;
    list.className = "structured-board-card-list structured-board-card-list--template";
    current.template.cardIds.forEach((cardId) => {
      const card = current.cards.find((entry) => entry.id === cardId);
      if (card) list.append(renderCard(card, { template: true }));
    });
    lane.append(list);
    return lane;
  };

  const renderDrawer = (): HTMLElement => {
    const shell = options.document.createElement("div") as HTMLElement;
    shell.className = templateEditorOpen || selectedCard() ? "structured-board-drawer-shell is-open" : "structured-board-drawer-shell";

    const drawer = options.document.createElement("aside") as HTMLElement;
    drawer.className = "structured-board-drawer";
    const card = selectedCard();
    if (!templateEditorOpen && !card) {
      return shell;
    }

    const header = options.document.createElement("div") as HTMLElement;
    header.className = "structured-board-drawer-header";
    const kicker = options.document.createElement("span") as HTMLElement;
    kicker.className = "structured-board-drawer-kicker";
    kicker.textContent = templateEditorOpen ? "Column template" : "Card";
    const close = createButton(options.document, "structured-board-drawer-close", "\u00D7", () => {
      templateEditorOpen = false;
      selectedCardId = null;
      render();
    });
    close.setAttribute("aria-label", "Close");
    header.append(kicker, close);
    drawer.append(header);

    if (templateEditorOpen && card) {
      drawer.append(
        createInput(
          options.document,
          "structured-board-drawer-title",
          card.title,
          (value) => {
            emit(updateBoardCardTitle(current, card.id, value));
          },
          false,
          `card-title:${card.id}`,
        ),
      );
      drawer.append(createStatusSelect(card, `card-status:${card.id}`));

      card.fields.forEach((field) => {
        const row = options.document.createElement("div") as HTMLElement;
        row.className = "structured-board-field-row";
        row.append(createInput(
          options.document,
          "structured-board-field-name",
          field.name,
          (value) => {
            emit(updateBoardTemplateField(current, field.templateFieldId ?? field.id, { name: value }));
          },
          false,
          `template-field-name:${field.templateFieldId ?? field.id}`,
        ));
        row.append(createTextarea(
          options.document,
          "structured-board-field-value",
          field.value,
          (value) => {
            emit(updateBoardCardField(current, card.id, field.id, { value }));
          },
          `template-field-value:${card.id}:${field.id}`,
        ));
        if (current.template.fields.length > 1 && field.templateFieldId) {
          row.append(createButton(
            options.document,
            "structured-action-btn structured-action-btn--danger",
            labels.removeField,
            () => emit(removeBoardTemplateField(current, field.templateFieldId!)),
          ));
        }
        drawer.append(row);
      });
      drawer.append(createButton(
        options.document,
        "structured-action-btn structured-action-btn--subtle",
        labels.addField,
        () => emit(addBoardTemplateField(current)),
      ));
      if (current.template.cardIds.length > 1) {
        drawer.append(createButton(
          options.document,
          "structured-action-btn structured-action-btn--danger structured-action-btn--full",
          labels.deleteCard,
          () => {
            const next = removeBoardTemplateCard(current, card.id);
            selectedCardId = next.template.cardIds.at(-1) ?? null;
            templateEditorOpen = next.template.cardIds.length > 0;
            emit(next);
          },
        ));
      }
      shell.append(drawer);
      return shell;
    }

    if (!card) {
      return shell;
    }

    drawer.append(
      createInput(
        options.document,
        "structured-board-drawer-title",
        card.title,
        (value) => {
          emit(updateBoardCardTitle(current, card.id, value));
        },
        false,
        `card-title:${card.id}`,
      ),
    );
    drawer.append(createStatusSelect(card, `card-status:${card.id}`));

    card.fields.forEach((field) => {
      const row = options.document.createElement("div") as HTMLElement;
      row.className = "structured-board-field-row";
      row.append(
        createInput(
          options.document,
          "structured-board-field-name",
          field.name,
          (value) => {
            if (field.templateFieldId) return;
            emit(updateBoardCardField(current, card.id, field.id, { name: value }));
          },
          Boolean(field.templateFieldId),
          `card-field-name:${card.id}:${field.id}`,
        ),
        createTextarea(
          options.document,
          "structured-board-field-value",
          field.value,
          (value) => {
            emit(updateBoardCardField(current, card.id, field.id, { value }));
          },
          `card-field-value:${card.id}:${field.id}`,
        ),
      );
      if (!field.templateFieldId) {
        row.append(createButton(
          options.document,
          "structured-action-btn structured-action-btn--danger",
          labels.removeField,
          () => emit(removeBoardCardField(current, card.id, field.id)),
        ));
      }
      drawer.append(row);
    });

    drawer.append(createButton(
      options.document,
      "structured-action-btn structured-action-btn--subtle",
      labels.addField,
      () => emit(addBoardCardField(current, card.id)),
    ));
    drawer.append(createButton(
      options.document,
      "structured-action-btn structured-action-btn--danger structured-action-btn--full",
      labels.deleteCard,
      () => emit(removeBoardCard(current, card.id)),
    ));

    shell.append(drawer);
    return shell;
  };

  const renderCard = (card: BoardCard, opts?: { template?: boolean }): HTMLElement => {
    const cardEl = options.document.createElement("article") as HTMLElement;
    cardEl.className = card.id === selectedCardId
      ? "structured-board-card structured-board-card--active"
      : "structured-board-card";
    if (opts?.template) {
      cardEl.classList.add("structured-board-card--template");
    }
    cardEl.dataset.cardId = card.id;
    cardEl.addEventListener("click", () => {
      templateEditorOpen = Boolean(opts?.template);
      selectedCardId = card.id;
      render();
    });

    const head = options.document.createElement("div") as HTMLElement;
    head.className = "structured-board-card-head";
    const title = options.document.createElement("h3") as HTMLElement;
    title.className = "structured-board-card-summary-title";
    title.textContent = card.title || "Untitled card";
    if (!opts?.template) {
      const grip = options.document.createElement("span") as HTMLElement;
      grip.className = "structured-board-card-grip";
      grip.textContent = "\u22EE\u22EE";
      head.append(grip);
    }
    head.append(title, createStatusSelect(card, `card-status-inline:${card.id}`));
    cardEl.append(head);

    const summaryLines = boardCardSummary(card, 4);
    if (summaryLines.length === 0) {
      const empty = options.document.createElement("p") as HTMLElement;
      empty.className = "structured-board-card-summary-line structured-board-card-summary-line--muted";
      empty.textContent = "No details yet";
      cardEl.append(empty);
      return cardEl;
    }

    summaryLines.forEach((line) => {
      const summary = options.document.createElement("p") as HTMLElement;
      summary.className = "structured-board-card-summary-line";
      summary.textContent = line;
      cardEl.append(summary);
    });
    return cardEl;
  };

  const renderColumn = (columnId: string): HTMLElement => {
    const column = current.columns.find((entry) => entry.id === columnId);
    if (!column) {
      return options.document.createElement("section") as HTMLElement;
    }

    const section = options.document.createElement("section") as HTMLElement;
    section.className = "structured-board-column";
    section.dataset.columnId = column.id;

    const accent = options.document.createElement("div") as HTMLElement;
    accent.className = "structured-board-column-accent";
    accent.setAttribute("style", `--board-column-color:${column.color};`);
    section.append(accent);

    const topRow = options.document.createElement("div") as HTMLElement;
    topRow.className = "structured-board-column-toprow";
    const meta = options.document.createElement("div") as HTMLElement;
    meta.className = "structured-board-column-meta";
    meta.append(
      createInput(
        options.document,
        "structured-board-column-title",
        column.title,
        (value) => {
          emit(renameBoardColumn(current, column.id, value));
        },
        false,
        `column-title:${column.id}`,
      ),
    );
    topRow.append(meta);
    section.append(topRow);

    section.append(appendColorSwatches(options.document, column.color, (color) => {
      emit(recolorBoardColumn(current, column.id, color));
    }));

    section.append(createButton(
      options.document,
      "structured-action-btn structured-action-btn--subtle",
      labels.addCard,
      () => {
        const next = addBoardCard(current, column.id);
        selectedCardId = next.cards.at(-1)?.id ?? null;
        emit(next);
      },
    ));

    const list = options.document.createElement("div") as HTMLElement;
    list.className = "structured-board-card-list";
    list.dataset.columnId = column.id;
    column.cardIds.forEach((cardId) => {
      const card = current.cards.find((entry) => entry.id === cardId);
      if (card) list.append(renderCard(card));
    });
    section.append(list);
    section.append(createButton(
      options.document,
      "structured-action-btn structured-action-btn--danger structured-action-btn--full structured-board-column-delete",
      labels.deleteColumn,
      () => emit(removeBoardColumn(current, column.id)),
    ));

    return section;
  };

  const renderBoard = (): HTMLElement => {
    const board = options.document.createElement("div") as HTMLElement;
    board.className = "structured-board-columns";
    board.append(renderTemplateLane());
    current.columns.forEach((column) => {
      board.append(renderColumn(column.id));
    });
    const addColumnLane = options.document.createElement("div") as HTMLElement;
    addColumnLane.className = "structured-board-column-adder";
    addColumnLane.append(createButton(
      options.document,
      "structured-board-column-adder-btn",
      "+",
      () => emit(addBoardColumn(current, `Column ${current.columns.length + 1}`)),
    ));
    board.append(addColumnLane);
    return board;
  };

  const render = (): void => {
    destroySortables();
    const focusState = captureFocusState(root);

    const shell = options.document.createElement("div") as HTMLElement;
    shell.className = "structured-board-shell";
    const stage = options.document.createElement("div") as HTMLElement;
    stage.className = "structured-board-stage";

    const board = renderBoard();
    const drawer = renderDrawer();
    stage.append(board);
    shell.append(stage);

    root.replaceChildren(shell, drawer);
    restoreFocusState(root, focusState);

    const lists = board.querySelectorAll?.(".structured-board-card-list");
    if (lists && typeof lists.length === "number") {
      bindSortables(Array.from(lists) as HTMLElement[]).catch(() => undefined);
    }
  };

  render();

  return {
    element: root,
    update(content: BoardDocumentContent) {
      current = normalizeStructuredDocumentContent("board", content) as BoardDocumentContent;
      if (selectedCardId && !current.cards.some((card) => card.id === selectedCardId)) {
        selectedCardId = null;
      }
      render();
    },
    destroy() {
      sortableBindToken += 1;
      destroySortables();
    },
  };
}
