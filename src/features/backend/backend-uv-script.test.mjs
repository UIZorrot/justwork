import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("backend package scripts run uvicorn through uv", async () => {
  const pkg = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));

  assert.match(pkg.scripts.backend, /^uv run --directory backend /);
  assert.equal(pkg.scripts.backend.includes("--isolated"), false);
  assert.equal(pkg.scripts.backend.includes("--with-requirements"), false);
  assert.match(pkg.scripts.backend, /-m uvicorn app\.main:app/);
  assert.equal(pkg.scripts.backend.includes("--reload"), false);

  assert.match(pkg.scripts["dev:backend"], /^uv run --directory backend /);
  assert.equal(pkg.scripts["dev:backend"].includes("--isolated"), false);
  assert.equal(pkg.scripts["dev:backend"].includes("--with-requirements"), false);
  assert.match(pkg.scripts["dev:backend"], /-m uvicorn app\.main:app/);
  assert.equal(pkg.scripts["dev:backend"].includes("--reload"), true);
});

test("backend is a uv project with runtime dependencies", async () => {
  const pyproject = await readFile(path.resolve("backend/pyproject.toml"), "utf8");

  for (const dependency of [
    "fastapi",
    "uvicorn[standard]",
    "pydantic",
    "python-dotenv",
    "typing-extensions",
    "psycopg[binary]",
    "psycopg-pool",
    "cryptography",
  ]) {
    assert.match(pyproject, new RegExp(`"${escapeRegExp(dependency)}`));
  }

  assert.match(pyproject, /\[tool\.uv\]/);
  assert.match(pyproject, /package = false/);
});
