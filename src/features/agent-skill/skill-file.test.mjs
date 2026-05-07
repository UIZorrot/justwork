import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const skillPath = path.resolve("public/agent/SKILL.md");

test("Agent Skill file documents required JustWork flows", async () => {
  const body = await readFile(skillPath, "utf8");

  for (const required of [
    "Backend API",
    "GET /openapi.json",
    "fixed JustWork Backend",
    "workspace.unlock",
    "identity.sign",
    "dry-run",
    "conflict",
  ]) {
    assert.equal(
      body.includes(required),
      true,
      `expected SKILL.md to include ${required}`,
    );
  }

  assert.equal(body.includes("Bridge fallback"), false);
});
