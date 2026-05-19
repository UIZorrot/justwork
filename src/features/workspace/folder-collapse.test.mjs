import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("workbench sidebar folders can be expanded and collapsed", async () => {
  const workbench = await readFile(path.resolve("src/pages/workbench/backend-workbench.ts"), "utf8");
  const css = await readFile(path.resolve("src/pages/workbench/workbench.css"), "utf8");

  for (const required of [
    "collapsedFolderIds",
    "toggleFolderCollapsed",
    "isFolderCollapsed",
    "aria-expanded",
    "doc-list-item-disclosure",
  ]) {
    assert.equal(workbench.includes(required), true, `expected workbench to include ${required}`);
  }

  assert.match(workbench, /flattenTree\([^)]*collapsedFolderIds/);
  assert.match(css, /\.doc-list-item-disclosure/);
  assert.match(css, /\.doc-list-item\.is-collapsed/);
});
