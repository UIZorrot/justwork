import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const skillPath = path.resolve("public/agent/SKILL.md");
const backendSkillPath = path.resolve("backend/agent/SKILL.md");
const manifestPath = path.resolve("src/manifest.ts");

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

test("Agent Skill is available from both extension assets and backend", async () => {
  const browserSkill = await readFile(skillPath, "utf8");
  const backendSkill = await readFile(backendSkillPath, "utf8");
  const manifest = await readFile(manifestPath, "utf8");

  assert.equal(backendSkill, browserSkill, "backend and browser Skill files should not drift");
  assert.match(manifest, /agent\/SKILL\.md/, "extension should expose the Skill file as a web-accessible resource");
});
