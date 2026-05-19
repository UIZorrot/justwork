import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("backend package scripts run uvicorn through uv", async () => {
  const pkg = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));

  assert.match(pkg.scripts.backend, /^uv run --directory backend /);
  assert.match(pkg.scripts.backend, /--isolated/);
  assert.match(pkg.scripts.backend, /--with-requirements requirements\.txt/);
  assert.match(pkg.scripts.backend, /-m uvicorn app\.main:app/);
  assert.equal(pkg.scripts.backend.includes("--reload"), false);

  assert.match(pkg.scripts["dev:backend"], /^uv run --directory backend /);
  assert.match(pkg.scripts["dev:backend"], /--isolated/);
  assert.match(pkg.scripts["dev:backend"], /-m uvicorn app\.main:app/);
  assert.equal(pkg.scripts["dev:backend"].includes("--reload"), true);
});
