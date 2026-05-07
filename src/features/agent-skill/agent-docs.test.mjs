import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const docsPath = path.resolve("docs/agent.md");
const skillPath = path.resolve("public/agent/SKILL.md");

test("Agent docs describe Backend-only workspace control without Bridge product flows", async () => {
  const docs = await readFile(docsPath, "utf8");
  const skill = await readFile(skillPath, "utf8");

  for (const required of [
    "JustWork",
    "fixed JustWork Backend",
    "workspace_id",
    "workspace password",
    "/openapi.json",
    "/agent/SKILL.md",
    "expected_revision",
    "conflict",
    "offline",
    "identity.sign",
  ]) {
    assert.equal(
      docs.includes(required),
      true,
      `expected docs/agent.md to include ${required}`,
    );
  }

  assert.equal(docs.includes("Bridge"), false);
  assert.equal(skill.includes("Bridge"), false);
});
