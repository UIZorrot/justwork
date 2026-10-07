import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { loadTranspiledModule } from "../../workspace/test-module-loader.mjs";

// Exercise the actual editor adapter with Vditor's deferred input callback.
// Browser navigation coverage lives in workbench-web-e2e.mjs.
async function createHarness(t, initialMarkdown = "") {
  const source = await readFile("src/features/editor/vditor/create-editor.ts", "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/^import[^;]*;\s*/gm, "").replace("export function createWysiwygEditor", "function createWysiwygEditor");
  const { createCompositionGate } = await loadTranspiledModule("src/features/editor/vditor/composition-gate.ts");
  const events = new Map();
  const container = {
    classList: { add() {}, remove() {} },
    contains: () => false,
    addEventListener(type, listener) { events.set(type, [...(events.get(type) ?? []), listener]); },
    removeEventListener(type, listener) { events.set(type, (events.get(type) ?? []).filter((item) => item !== listener)); },
  };
  let instance;
  class DeferredVditor {
    constructor(_container, options) {
      this.options = options;
      this.value = options.value;
      instance = this;
      queueMicrotask(options.after);
    }
    getValue() { return this.value; }
    setValue(value) { this.value = value; }
    destroy() {}
  }
  class FakeElement {
    closest() { return this; }
  }
  const createEditor = new Function("Vditor", "createCompositionGate", "getWysiwygToolbar", "getRuntimeUrl",
    "window", "document", "Element", `${compiled}\nreturn createWysiwygEditor;`)(DeferredVditor,
    createCompositionGate, () => [], (url) => url, { setTimeout, clearTimeout },
    { getElementById: () => ({}), activeElement: null }, FakeElement);
  const changes = [];
  const editor = createEditor({ container, initialMarkdown, onChange: (markdown) => changes.push(markdown) });
  t.after(() => editor.destroy());
  await Promise.resolve();
  const emit = (type, extra = {}) => {
    for (const listener of events.get(type) ?? []) listener({ isTrusted: true, ...extra });
  };
  return {
    editor, changes, instance, emit,
    toolbarTarget: new FakeElement(),
    type(markdown) {
      emit("beforeinput");
      instance.value = markdown;
      emit("input");
    },
  };
}

test("native typing persists before Vditor's undo debounce and deduplicates its callback", async (t) => {
  const { changes, instance, type } = await createHarness(t);
  type("你好\n");
  await Promise.resolve();
  assert.deepEqual(changes, ["你好\n"]);
  instance.options.input(instance.value);
  assert.deepEqual(changes, ["你好\n"]);
});

test("navigation flush records the old document before a setValue cancels deferred input", async (t) => {
  const { editor, changes, instance, type } = await createHarness(t);
  type("快速切换\n");
  editor.flushPendingInput(true);
  editor.setMarkdown("another document\n", true);
  await Promise.resolve();
  instance.options.input(instance.value);
  assert.deepEqual(changes, ["快速切换\n"]);
});

test("trusted toolbar edits persist after programmatic render without beforeinput", async (t) => {
  const { editor, changes, instance, emit, toolbarTarget } = await createHarness(t);
  editor.setMarkdown("paragraph\n", true);
  instance.options.input("paragraph\n");
  assert.deepEqual(changes, []);
  emit("click", { target: toolbarTarget });
  instance.value = "**paragraph**\n";
  await Promise.resolve();
  assert.deepEqual(changes, ["**paragraph**\n"]);
});

test("navigation finishes IME with the latest DOM and ordinary capture preserves composition", async (t) => {
  const { editor, changes, instance, emit, type } = await createHarness(t);
  emit("compositionstart");
  type("ni");
  instance.options.input("ni");
  instance.value = "你好\n";
  await Promise.resolve();
  assert.deepEqual(changes, []);
  editor.flushPendingInput();
  assert.equal(editor.isComposing(), true);
  editor.flushPendingInput(true);
  assert.deepEqual(changes, ["你好\n"]);
  assert.equal(editor.isComposing(), false);
});
