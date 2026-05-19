import {
  addBoardCard,
  addBoardCardField,
  addBoardColumn,
  addBoardTemplateField,
  moveBoardCard,
  recolorBoardColumn,
  removeBoardCard,
  removeBoardColumn,
  removeBoardCardField,
  removeBoardTemplateField,
  renameBoardColumn,
  updateBoardCardField,
  updateBoardCardTitle,
  updateBoardTemplateField,
} from "./board-state";
import {
  BOARD_COLUMN_COLORS,
  boardCardSummary,
  normalizeStructuredDocumentContent,
  type BoardCard,
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
): HTMLInputElement {
  const input = document.createElement("input") as HTMLInputElement;
  input.type = "text";
  input.className = className;
  input.value = value;
  input.readOnly = readOnly;
  input.addEventListener("input", () => onInput(input.value));
  return input;
}

function createTextarea(
  document: DocumentLike,
  className: string,
  value: string,
  onInput: (value: string) => void,
): HTMLTextAreaElement {
  const textarea = document.createElement("textarea") as HTMLTextAreaElement;
  textarea.className = className;
  textarea.value = value;
  textarea.addEventListener("input", () => onInput(textarea.value));
  return textarea;
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

function createCardCount(document: DocumentLike, count: number): HTMLElement {
  const badge = document.createElement("span") as HTMLElement;
  badge.className = "structured-board-column-count";
  badge.textContent = String(count);
  return badge;
}

export function createBoardView(options: BoardViewOptions): BoardViewHandle {
  let current = normalizeStructuredDocumentContent("board", options.content) as BoardDocumentContent;
  let selectedCardId: string | null = null;
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

    const templateCard = options.document.createElement("div") as HTMLElement;
    templateCard.className = "structured-board-template-card";

    current.template.fields.forEach((field) => {
      const row = options.document.createElement("div") as HTMLElement;
      row.className = "structured-board-field-row";
      row.append(createInput(options.document, "structured-board-field-name", field.name, (value) => {
        emit(updateBoardTemplateField(current, field.id, { name: value }));
      }));
      if (current.template.fields.length > 1) {
        row.append(createButton(
          options.document,
          "structured-action-btn structured-action-btn--danger",
          labels.removeField,
          () => emit(removeBoardTemplateField(current, field.id)),
        ));
      }
      templateCard.append(row);
    });

    templateCard.append(createButton(
      options.document,
      "structured-action-btn structured-action-btn--subtle",
      labels.addField,
      () => emit(addBoardTemplateField(current)),
    ));

    lane.append(templateCard);
    return lane;
  };

  const renderDrawer = (): HTMLElement => {
    const shell = options.document.createElement("div") as HTMLElement;
    shell.className = selectedCard() ? "structured-board-drawer-shell is-open" : "structured-board-drawer-shell";

    const drawer = options.document.createElement("aside") as HTMLElement;
    drawer.className = "structured-board-drawer";
    const card = selectedCard();
    if (!card) {
      return shell;
    }

    const header = options.document.createElement("div") as HTMLElement;
    header.className = "structured-board-drawer-header";
    const kicker = options.document.createElement("span") as HTMLElement;
    kicker.className = "structured-board-drawer-kicker";
    kicker.textContent = "Card";
    const close = createButton(options.document, "structured-board-drawer-close", "\u00D7", () => {
      selectedCardId = null;
      render();
    });
    close.setAttribute("aria-label", "Close");
    header.append(kicker, close);
    drawer.append(header);

    drawer.append(
      createInput(options.document, "structured-board-drawer-title", card.title, (value) => {
        emit(updateBoardCardTitle(current, card.id, value));
      }),
    );

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
        ),
        createTextarea(options.document, "structured-board-field-value", field.value, (value) => {
          emit(updateBoardCardField(current, card.id, field.id, { value }));
        }),
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

  const renderCard = (card: BoardCard): HTMLElement => {
    const cardEl = options.document.createElement("article") as HTMLElement;
    cardEl.className = card.id === selectedCardId
      ? "structured-board-card structured-board-card--active"
      : "structured-board-card";
    cardEl.dataset.cardId = card.id;
    cardEl.addEventListener("click", () => {
      selectedCardId = card.id;
      render();
    });

    const head = options.document.createElement("div") as HTMLElement;
    head.className = "structured-board-card-head";
    const grip = options.document.createElement("span") as HTMLElement;
    grip.className = "structured-board-card-grip";
    grip.textContent = "\u22EE\u22EE";
    const title = options.document.createElement("h3") as HTMLElement;
    title.className = "structured-board-card-summary-title";
    title.textContent = card.title || "Untitled card";
    head.append(grip, title);
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
      createInput(options.document, "structured-board-column-title", column.title, (value) => {
        emit(renameBoardColumn(current, column.id, value));
      }),
      createCardCount(options.document, column.cardIds.length),
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

    const shell = options.document.createElement("div") as HTMLElement;
    shell.className = "structured-board-shell";
    const stage = options.document.createElement("div") as HTMLElement;
    stage.className = "structured-board-stage";

    const board = renderBoard();
    const drawer = renderDrawer();
    stage.append(board);
    shell.append(stage);

    root.replaceChildren(shell, drawer);

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
