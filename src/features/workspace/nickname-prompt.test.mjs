import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("workspace nickname prompt is scoped to current user in current workspace", async () => {
  const workbench = await readFile(path.resolve("src/pages/workbench/backend-workbench.ts"), "utf8");

  for (const required of [
    "workspaceNicknameMapKey",
    "getWorkspaceNickname(workspaceId, identity.userId)",
    "setWorkspaceNickname(workspaceId, identity.userId",
    "const ensureNickname",
    "openNicknamePrompt",
    "document.activeElement",
    ".blur()",
  ]) {
    assert.equal(workbench.includes(required), true, `expected workbench to include ${required}`);
  }

  assert.equal(
    /getWorkspaceNickname\(workspaceId\)\.trim/.test(workbench),
    false,
    "nickname lookup must not be scoped only by workspace id",
  );
});
