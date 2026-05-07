import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("workbench defaults to the fixed Backend product surface", async () => {
  const main = await readFile(path.resolve("src/pages/workbench/main.ts"), "utf8");
  const html = await readFile(path.resolve("src/pages/workbench/index.html"), "utf8");
  const config = await readFile(path.resolve("src/shared/backend-config.ts"), "utf8");

  assert.match(config, /JUSTWORK_BACKEND_URL/);
  assert.match(config, /DEFAULT_BACKEND_URL/);
  assert.equal(main.includes("WORKBENCH_DATA_SOURCE"), false);
  assert.match(main, /startBackendWorkbench/);
  assert.equal(html.includes("backend-url-setup-input"), false);
  assert.equal(html.includes("backend-url-unlock-input"), false);
  assert.match(html, /backend-health-status/);
});
