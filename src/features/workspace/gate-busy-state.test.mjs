import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workspace gate busy state keeps a visible loading label", async () => {
  const workbench = await readFile("src/pages/workbench/backend-workbench.ts", "utf8");
  const css = await readFile("src/pages/workbench/workbench.css", "utf8");
  const i18n = await readFile("src/shared/i18n.ts", "utf8");

  assert.match(workbench, /gate\.setup\.buttonBusy/);
  assert.match(workbench, /gate\.unlock\.buttonBusy/);
  assert.match(i18n, /"gate\.setup\.buttonBusy":/);
  assert.match(i18n, /"gate\.unlock\.buttonBusy":/);
  assert.doesNotMatch(
    css,
    /\.gate-primary-btn\.is-busy\s+\.gate-btn-label\s*\{[^}]*opacity:\s*0/m,
    "busy gate buttons must show loading text instead of hiding the label",
  );
});
