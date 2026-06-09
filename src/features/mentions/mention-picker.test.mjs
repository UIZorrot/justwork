import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "../workspace/test-module-loader.mjs";

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
    this.className = "";
    this.hidden = false;
    this.textContent = "";
    this.style = {};
    this.parentNode = null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    for (const child of children) {
      this.appendChild(child);
    }
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
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

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
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
  constructor() {
    this.body = new FakeElement("body", this);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
}

test("mention picker filters workspace candidates and selects via keyboard", async () => {
  const mod = await loadTranspiledModule("src/features/mentions/mention-picker.ts");
  const document = new FakeDocument();
  const selections = [];
  const picker = mod.createMentionPicker({
    document,
    labels: { empty: "No people" },
    onSelect: (candidate) => selections.push(candidate),
  });

  picker.open(
    { query: "bo", left: 10, top: 20, lineHeight: 18 },
    [
      { userId: "user_a", displayName: "Alice" },
      { userId: "user_b", displayName: "Bob" },
    ],
  );

  const buttons = picker.element.querySelectorAll("button");
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].textContent, "Bob");
  assert.equal(picker.element.style.top, "38px");

  const handled = picker.handleKeyDown(new FakeEvent("keydown", { key: "Enter" }));
  assert.equal(handled, true);
  assert.deepEqual(selections, [{ userId: "user_b", displayName: "Bob" }]);
});

test("mention picker renders empty state and closes on escape", async () => {
  const mod = await loadTranspiledModule("src/features/mentions/mention-picker.ts");
  const document = new FakeDocument();
  const picker = mod.createMentionPicker({
    document,
    labels: { empty: "No people" },
    onSelect: () => {},
  });

  picker.open(
    { query: "zz", left: 0, top: 0, lineHeight: 24 },
    [{ userId: "user_a", displayName: "Alice" }],
  );

  assert.equal(picker.element.children[0].textContent, "No people");
  const handled = picker.handleKeyDown(new FakeEvent("keydown", { key: "Escape" }));
  assert.equal(handled, true);
  assert.equal(picker.isOpen(), false);
  assert.equal(picker.element.hidden, true);
});
