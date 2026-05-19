import {
  BOARD_COLUMN_COLORS,
  createStructuredId,
  createBoardCardFromTemplate,
  cloneBoardCardPrototype,
  reconcileBoardCardWithTemplate,
  type BoardCard,
  type BoardCardField,
  type BoardDocumentContent,
} from "./structured-document";

function cloneField(field: BoardCardField): BoardCardField {
  return { ...field };
}

function cloneCard(card: BoardCard): BoardCard {
  return {
    ...card,
    fields: card.fields.map(cloneField),
  };
}

function cloneBoard(content: BoardDocumentContent): BoardDocumentContent {
  return {
    kind: "board",
    template: {
      ...content.template,
      cardIds: [...content.template.cardIds],
      fields: content.template.fields.map((field) => ({ ...field })),
    },
    columns: content.columns.map((column) => ({
      ...column,
      cardIds: [...column.cardIds],
    })),
    cards: content.cards.map(cloneCard),
  };
}

function ensureCard(content: BoardDocumentContent, cardId: string): BoardCard | undefined {
  return content.cards.find((card) => card.id === cardId);
}

function templateCards(content: BoardDocumentContent): BoardCard[] {
  return content.template.cardIds
    .map((cardId) => ensureCard(content, cardId))
    .filter((card): card is BoardCard => Boolean(card));
}

function createCardFromTemplateLane(content: BoardDocumentContent, index = 0): BoardCard {
  const source = templateCards(content)[index] ?? templateCards(content)[0];
  if (source) {
    return cloneBoardCardPrototype(source);
  }
  return createBoardCardFromTemplate(content.template, content.template.cardTitle || "Untitled card");
}

export function addBoardCard(content: BoardDocumentContent, columnId: string, title = "Untitled card"): BoardDocumentContent {
  const next = cloneBoard(content);
  const seededCard = createCardFromTemplateLane(next);
  const newCard = {
    ...seededCard,
    title: title.trim() || seededCard.title,
  };
  next.cards.push(newCard);
  next.columns = next.columns.map((column) => (
    column.id === columnId ? { ...column, cardIds: [...column.cardIds, newCard.id] } : column
  ));
  return next;
}

export function updateBoardCardTitle(content: BoardDocumentContent, cardId: string, title: string): BoardDocumentContent {
  const next = cloneBoard(content);
  next.cards = next.cards.map((card) => (
    card.id === cardId ? { ...card, title } : card
  ));
  return next;
}

export function addBoardCardField(
  content: BoardDocumentContent,
  cardId: string,
  fieldName = "New field",
): BoardDocumentContent {
  const next = cloneBoard(content);
  next.cards = next.cards.map((card) => {
    if (card.id !== cardId) return card;
    return {
      ...card,
      fields: [
        ...card.fields,
        {
          id: createStructuredId("field"),
          templateFieldId: null,
          name: fieldName,
          value: "",
        },
      ],
    };
  });
  return next;
}

export function updateBoardCardField(
  content: BoardDocumentContent,
  cardId: string,
  fieldId: string,
  patch: { name?: string; value?: string },
): BoardDocumentContent {
  const next = cloneBoard(content);
  next.cards = next.cards.map((card) => {
    if (card.id !== cardId) return card;
    return {
      ...card,
      fields: card.fields.map((field) => (
        field.id === fieldId
          ? {
              ...field,
              name: patch.name ?? field.name,
              value: patch.value ?? field.value,
            }
          : field
      )),
    };
  });
  return next;
}

export function removeBoardCardField(
  content: BoardDocumentContent,
  cardId: string,
  fieldId: string,
): BoardDocumentContent {
  const next = cloneBoard(content);
  next.cards = next.cards.map((card) => {
    if (card.id !== cardId) return card;
    return {
      ...card,
      fields: card.fields.filter((field) => field.id !== fieldId),
    };
  });
  return next;
}

export function addBoardColumn(content: BoardDocumentContent, title = "New column"): BoardDocumentContent {
  const next = cloneBoard(content);
  const starterCards = templateCards(next).map((card) => cloneBoardCardPrototype(card));
  next.cards.push(...starterCards);
  next.columns.push({
    id: createStructuredId("column"),
    title: title.trim() || "New column",
    color: BOARD_COLUMN_COLORS[next.columns.length % BOARD_COLUMN_COLORS.length],
    cardIds: starterCards.map((card) => card.id),
  });
  return next;
}

export function renameBoardColumn(content: BoardDocumentContent, columnId: string, title: string): BoardDocumentContent {
  const next = cloneBoard(content);
  next.columns = next.columns.map((column) => (
    column.id === columnId ? { ...column, title: title.trim() || column.title } : column
  ));
  return next;
}

export function recolorBoardColumn(content: BoardDocumentContent, columnId: string, color: string): BoardDocumentContent {
  const next = cloneBoard(content);
  next.columns = next.columns.map((column) => (
    column.id === columnId ? { ...column, color } : column
  ));
  return next;
}

export function moveBoardCard(
  content: BoardDocumentContent,
  cardId: string,
  targetColumnId: string,
  targetIndex: number,
): BoardDocumentContent {
  const existing = ensureCard(content, cardId);
  if (!existing) return cloneBoard(content);
  const next = cloneBoard(content);
  next.columns = next.columns.map((column) => ({
    ...column,
    cardIds: column.cardIds.filter((id) => id !== cardId),
  }));
  next.columns = next.columns.map((column) => {
    if (column.id !== targetColumnId) return column;
    const boundedIndex = Math.max(0, Math.min(targetIndex, column.cardIds.length));
    const cardIds = [...column.cardIds];
    cardIds.splice(boundedIndex, 0, cardId);
    return { ...column, cardIds };
  });
  return next;
}

export function removeBoardCard(content: BoardDocumentContent, cardId: string): BoardDocumentContent {
  const next = cloneBoard(content);
  next.cards = next.cards.filter((card) => card.id !== cardId);
  next.columns = next.columns.map((column) => ({
    ...column,
    cardIds: column.cardIds.filter((id) => id !== cardId),
  }));
  return next;
}

export function removeBoardColumn(content: BoardDocumentContent, columnId: string): BoardDocumentContent {
  const next = cloneBoard(content);
  const removedColumn = next.columns.find((column) => column.id === columnId);
  next.columns = next.columns.filter((column) => column.id !== columnId);
  const removedCardIds = new Set(removedColumn?.cardIds ?? []);
  if (removedCardIds.size > 0) {
    next.cards = next.cards.filter((card) => !removedCardIds.has(card.id));
    next.columns = next.columns.map((column) => ({
      ...column,
      cardIds: column.cardIds.filter((id) => !removedCardIds.has(id)),
    }));
  }
  return next;
}

export function renameBoardTemplate(content: BoardDocumentContent, title: string, cardTitle: string): BoardDocumentContent {
  const next = cloneBoard(content);
  next.template.title = title.trim() || next.template.title;
  next.template.cardTitle = cardTitle.trim() || next.template.cardTitle;
  return next;
}

export function addBoardTemplateCard(content: BoardDocumentContent): BoardDocumentContent {
  const next = cloneBoard(content);
  const templateCard = createCardFromTemplateLane(next, next.template.cardIds.length - 1);
  next.cards.push(templateCard);
  next.template.cardIds.push(templateCard.id);
  return next;
}

export function removeBoardTemplateCard(content: BoardDocumentContent, cardId: string): BoardDocumentContent {
  if (content.template.cardIds.length <= 1) return cloneBoard(content);
  const next = cloneBoard(content);
  next.template.cardIds = next.template.cardIds.filter((id) => id !== cardId);
  next.cards = next.cards.filter((card) => card.id !== cardId);
  next.columns = next.columns.map((column) => ({
    ...column,
    cardIds: column.cardIds.filter((id) => id !== cardId),
  }));
  return next;
}

export function addBoardTemplateField(content: BoardDocumentContent, name = "New field"): BoardDocumentContent {
  const next = cloneBoard(content);
  next.template.fields.push({
    id: createStructuredId("template"),
    name: name.trim() || "New field",
    defaultValue: "",
  });
  next.cards = next.cards.map((card) => reconcileBoardCardWithTemplate(card, next.template));
  return next;
}

export function updateBoardTemplateField(
  content: BoardDocumentContent,
  templateFieldId: string,
  patch: { name?: string; defaultValue?: string },
): BoardDocumentContent {
  const next = cloneBoard(content);
  next.template.fields = next.template.fields.map((field) => (
    field.id === templateFieldId
      ? {
          ...field,
          name: patch.name ?? field.name,
          defaultValue: patch.defaultValue ?? field.defaultValue,
        }
      : field
  ));
  next.cards = next.cards.map((card) => reconcileBoardCardWithTemplate(card, next.template));
  return next;
}

export function removeBoardTemplateField(content: BoardDocumentContent, templateFieldId: string): BoardDocumentContent {
  const next = cloneBoard(content);
  next.template.fields = next.template.fields.filter((field) => field.id !== templateFieldId);
  next.cards = next.cards.map((card) => ({
    ...card,
    fields: card.fields.filter((field) => field.templateFieldId !== templateFieldId),
  }));
  return next;
}
