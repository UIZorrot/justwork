import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "../../workspace/test-module-loader.mjs";

test("composition gate suppresses intermediate IME input until composition ends", async () => {
  const mod = await loadTranspiledModule("src/features/editor/vditor/composition-gate.ts");
  const gate = mod.createCompositionGate();

  assert.equal(gate.isComposing(), false);
  gate.onCompositionStart();
  assert.equal(gate.isComposing(), true);
  assert.equal(gate.onInput("n"), null);
  assert.equal(gate.onInput("ni"), null);
  assert.equal(gate.onInput("你"), null);
  assert.equal(gate.onCompositionEnd("你"), "你");
  assert.equal(gate.isComposing(), false);
});

test("composition gate passes through normal input when not composing", async () => {
  const mod = await loadTranspiledModule("src/features/editor/vditor/composition-gate.ts");
  const gate = mod.createCompositionGate();

  assert.equal(gate.onInput("hello"), "hello");
});

test("composition ends with the current DOM rather than an earlier debounced input", async () => {
  const { createCompositionGate } = await loadTranspiledModule("src/features/editor/vditor/composition-gate.ts");
  const gate = createCompositionGate();
  gate.onCompositionStart();
  gate.onInput("ni");
  assert.equal(gate.onCompositionEnd("你好"), "你好");
  gate.onCompositionStart();
  gate.onInput("old partial");
  assert.equal(gate.onCompositionCancel("current text"), "current text");
});
