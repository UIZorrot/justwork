import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const LAZY_LOAD_TOOLBAR_ITEMS = [
  "code-theme",
  "content-theme",
  "export",
  "outline",
  "record",
];

test("WYSIWYG toolbar excludes items that lazy-load remote scripts", async () => {
  const source = await readFile(
    path.resolve("src/features/editor/vditor/wysiwyg-toolbar.ts"),
    "utf8",
  );
  for (const risky of LAZY_LOAD_TOOLBAR_ITEMS) {
    assert.doesNotMatch(source, new RegExp(`"${risky}"`), `toolbar must not include ${risky}`);
  }
});
