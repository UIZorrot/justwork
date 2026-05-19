import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("opening the inbox drawer does not auto-mark notifications read", async () => {
  const workbench = await readFile(path.resolve("src/pages/workbench/backend-workbench.ts"), "utf8");

  const openDrawerBlock = /const openMessageDrawer = \(\): void => \{([\s\S]*?)\n    \};/.exec(workbench)?.[1] ?? "";
  assert.equal(openDrawerBlock.includes("markAllLocalInboxNotificationsRead"), false);
  assert.equal(workbench.includes("workspace-message-mark-read-btn"), true);
});
