import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const editorCssFiles = [
  "src/pages/workbench/workbench.css",
  "src/pages/sidepanel/sidepanel.css",
];

test("Vditor WYSIWYG floating panels are hidden in document editor hosts", async () => {
  for (const cssFile of editorCssFiles) {
    const css = await readFile(path.resolve(cssFile), "utf8");

    assert.match(css, /Hide Vditor's WYSIWYG floating panels/);
    assert.match(css, /\.doc-editor-host\s+\.vditor-wysiwyg\s*>\s*\.vditor-panel\.vditor-panel--none/);
    assert.match(css, /display:\s*none\s*!important/);
  }
});
