import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }

  preventDefault() {
    this.defaultPrevented = true;
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.parentNode = null;
    this.value = "";
    this.textContent = "";
    this.className = "";
    this._rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    this.classList = {
      add: (...tokens) => {
        const next = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const token of tokens) next.add(token);
        this.className = [...next].join(" ");
      },
      remove: (...tokens) => {
        const removeSet = new Set(tokens);
        this.className = this.className
          .split(/\s+/)
          .filter((token) => token && !removeSet.has(token))
          .join(" ");
      },
      contains: (token) => this.className.split(/\s+/).filter(Boolean).includes(token),
    };
  }

  append(...children) {
    for (const child of children) {
      if (child == null) continue;
      child.parentNode = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    const listeners = this.listeners.get(event.type) ?? [];
    for (const listener of listeners) {
      listener.call(this, event);
    }
    return true;
  }

  click() {
    this.dispatchEvent(new FakeEvent("click"));
  }

  closest(selector) {
    if (!selector.startsWith(".")) return null;
    const token = selector.slice(1);
    let node = this;
    while (node) {
      if (node.className.split(/\s+/).filter(Boolean).includes(token)) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  getBoundingClientRect() {
    return this._rect;
  }

  setBoundingClientRect(rect) {
    this._rect = { ...rect };
  }

  querySelectorAll(tagName) {
    const matches = [];
    const needle = tagName.toUpperCase();
    for (const child of this.children) {
      if (child.tagName === needle) {
        matches.push(child);
      }
      matches.push(...child.querySelectorAll(tagName));
    }
    return matches;
  }
}

class FakeDocument {
  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
}

test("board view opens the drawer only after selecting a card and emits changes there", async () => {
  const documents = await loadTranspiledModule("src/features/workspace/structured-document.ts");
  const mod = await loadTranspiledModule("src/features/workspace/board-view.ts");

  const document = new FakeDocument();
  const changes = [];
  const initial = documents.createDefaultBoardContent();
  const view = mod.createBoardView({
    document,
    content: initial,
    onChange: (next) => changes.push(next),
  });

  const drawerTitleBeforeSelect = view.element
    .querySelectorAll("input")
    .find((input) => input.className === "structured-board-drawer-title");
  assert.equal(drawerTitleBeforeSelect, undefined);

  const buttons = view.element.querySelectorAll("button");
  const addCardBtn = buttons.find((button) => button.textContent === "Add card");
  assert.ok(addCardBtn);
  addCardBtn.click();
  const newCardId = changes.at(-1).columns[0].cardIds.at(-1);
  assert.equal(changes.at(-1).cards.find((card) => card.id === newCardId).title, "Untitled card");

  view.update(changes.at(-1));
  const cards = view.element
    .querySelectorAll("article")
    .filter((element) => element.className.includes("structured-board-card") && !element.className.includes("--template"));
  const newCard = cards.find((element) => element.dataset.cardId === newCardId);
  assert.ok(newCard);
  newCard.click();

  const titleInput = view.element.querySelectorAll("input").find((input) => input.className === "structured-board-drawer-title");
  assert.ok(titleInput);
  titleInput.value = "Ship foundation";
  titleInput.dispatchEvent(new FakeEvent("input"));
  assert.equal(changes.at(-1).cards.find((card) => card.id === newCardId).title, "Ship foundation");

  const addFieldBtn = view.element.querySelectorAll("button").find((button) => button.textContent === "Add field");
  assert.ok(addFieldBtn);
  addFieldBtn.click();
  const updatedCard = changes.at(-1).cards.find((card) => card.id === newCardId);
  assert.equal(updatedCard.fields.length > initial.template.fields.length, true);
});

test("board view uses a single default card and exposes add-column only as the trailing round button", async () => {
  const documents = await loadTranspiledModule("src/features/workspace/structured-document.ts");
  const mod = await loadTranspiledModule("src/features/workspace/board-view.ts");

  const document = new FakeDocument();
  const initial = documents.createDefaultBoardContent();
  const view = mod.createBoardView({
    document,
    content: initial,
  });

  assert.equal(initial.cards.length, 1);
  assert.equal(initial.columns[0].cardIds.length, 1);

  const buttons = view.element.querySelectorAll("button");
  assert.equal(buttons.some((button) => button.textContent === "Add column"), false);
  assert.equal(
    buttons.some((button) => button.className.includes("structured-board-column-adder-btn")),
    true,
  );
});

test("board view keeps the drawer outside the stage shell and shows no empty placeholder", async () => {
  const documents = await loadTranspiledModule("src/features/workspace/structured-document.ts");
  const mod = await loadTranspiledModule("src/features/workspace/board-view.ts");

  const document = new FakeDocument();
  const initial = documents.createDefaultBoardContent();
  const view = mod.createBoardView({
    document,
    content: initial,
  });

  const [shell, drawerShell] = view.element.children;
  assert.ok(shell);
  assert.ok(drawerShell);
  assert.equal(shell.className, "structured-board-shell");
  assert.equal(shell.children.length, 1);
  assert.equal(drawerShell.className, "structured-board-drawer-shell");
  assert.equal(drawerShell.children.length, 0);
  assert.equal(
    view.element.querySelectorAll("p").some((element) => element.textContent === "Select a card to edit"),
    false,
  );
});

test("board view uses visual color swatches instead of hex selects", async () => {
  const documents = await loadTranspiledModule("src/features/workspace/structured-document.ts");
  const mod = await loadTranspiledModule("src/features/workspace/board-view.ts");

  const document = new FakeDocument();
  const initial = documents.createDefaultBoardContent();
  const view = mod.createBoardView({
    document,
    content: initial,
  });

  const selects = view.element.querySelectorAll("select");
  assert.equal(selects.length, 0);

  const swatches = view.element
    .querySelectorAll("button")
    .filter((button) => button.className.includes("structured-board-color-swatch"));
  assert.equal(swatches.length >= initial.columns.length, true);
  assert.equal(swatches.some((button) => /^#/.test(button.textContent ?? "")), false);
});

test("board view template can collapse as a whole block and has no title/card title inputs", async () => {
  const documents = await loadTranspiledModule("src/features/workspace/structured-document.ts");
  const mod = await loadTranspiledModule("src/features/workspace/board-view.ts");

  const document = new FakeDocument();
  const changes = [];
  const initial = documents.createDefaultBoardContent();
  const view = mod.createBoardView({
    document,
    content: initial,
    onChange: (next) => changes.push(next),
  });

  const toggle = view.element
    .querySelectorAll("button")
    .find((button) => button.className.includes("structured-board-template-toggle"));
  assert.ok(toggle);
  assert.equal(toggle.textContent, "<");

  const templateTextareasBefore = view.element
    .querySelectorAll("textarea")
    .filter((element) => element.className === "structured-board-field-value");
  assert.equal(templateTextareasBefore.length, 0);

  const initialInputs = view.element
    .querySelectorAll("input")
    .filter((input) => input.className === "structured-board-card-title");
  assert.equal(initialInputs.length, 0);
  assert.equal(
    view.element
      .querySelectorAll("input")
      .filter((input) => input.className === "structured-board-column-title")
      .length,
    initial.columns.length,
  );

  toggle.click();
  assert.equal(
    view.element
      .querySelectorAll("button")
      .find((button) => button.className.includes("structured-board-template-toggle"))
      ?.textContent,
    ">",
  );
  const collapsedLane = view.element
    .querySelectorAll("section")
    .find((element) => element.className.includes("structured-board-column--template"));
  assert.ok(collapsedLane);
  assert.equal(collapsedLane.className.includes("is-collapsed"), true);
  assert.equal(
    collapsedLane
      .querySelectorAll("div")
      .some((element) => element.className === "structured-board-template-summary"),
    false,
  );
  assert.equal(
    collapsedLane
      .querySelectorAll("input")
      .some((input) => input.className === "structured-board-field-name"),
    false,
  );

  toggle.click();
  assert.equal(
    view.element
      .querySelectorAll("button")
      .find((button) => button.className.includes("structured-board-template-toggle"))
      ?.textContent,
    "<",
  );
  const expandedField = view.element
    .querySelectorAll("input")
    .find((input) => input.className === "structured-board-field-name");
  assert.ok(expandedField);
  expandedField.value = "Checklist";
  expandedField.dispatchEvent(new FakeEvent("input"));
  assert.equal(changes.at(-1).template.fields[0].name, "Checklist");
});

test("board view keeps delete card in the drawer and renders delete column at the bottom of each column", async () => {
  const documents = await loadTranspiledModule("src/features/workspace/structured-document.ts");
  const mod = await loadTranspiledModule("src/features/workspace/board-view.ts");

  const document = new FakeDocument();
  const changes = [];
  const initial = documents.createDefaultBoardContent();
  const view = mod.createBoardView({
    document,
    content: initial,
    onChange: (next) => changes.push(next),
  });

  const buttons = view.element.querySelectorAll("button");
  assert.equal(buttons.some((button) => button.textContent === "Delete column"), true);
  assert.equal(buttons.some((button) => button.textContent === "Delete card"), false);

  const cards = view.element
    .querySelectorAll("article")
    .filter((element) => element.className.includes("structured-board-card") && !element.className.includes("--template"));
  cards[0]?.click();

  const drawerButtons = view.element.querySelectorAll("button");
  const deleteCardBtn = drawerButtons.find((button) => button.textContent === "Delete card");
  const deleteColumnBtn = view.element
    .querySelectorAll("button")
    .find((button) => button.className.includes("structured-board-column-delete"));
  const drawerDeleteColumnBtn = view.element
    .querySelectorAll("button")
    .find((button) =>
      button.textContent === "Delete column"
      && button.closest(".structured-board-drawer"),
    );

  assert.ok(deleteCardBtn);
  assert.ok(deleteColumnBtn);
  assert.equal(drawerDeleteColumnBtn, undefined);

  deleteCardBtn.click();
  assert.equal(changes.at(-1).cards.length, 0);

  deleteColumnBtn.click();
  assert.equal(changes.at(-1).columns.length, 2);
});
