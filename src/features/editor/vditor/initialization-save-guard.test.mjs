import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("programmatic and bootstrap editor writes advance save dedupe baselines", async () => {
  const source = await readFile("src/features/editor/vditor/create-editor.ts", "utf8");

  assert.match(
    source,
    /const applyMarkdown[\s\S]*lastInputMarkdown = markdown;[\s\S]*lastEmittedMarkdown = markdown;[\s\S]*setValue/,
  );
  assert.match(
    source,
    /if \(!editorReady\) \{[\s\S]*lastInputMarkdown = markdown;[\s\S]*lastEmittedMarkdown = markdown;[\s\S]*return;/,
  );
  assert.match(
    source,
    /origin === "local"[\s\S]*emitMarkdown\(binding\.collaborator\.getMarkdown\(\)\)/,
  );
  assert.doesNotMatch(
    source,
    /origin === "local"[\s\S]{0,120}onChange\?\.\(binding\.collaborator\.getMarkdown\(\)\)/,
  );
});
