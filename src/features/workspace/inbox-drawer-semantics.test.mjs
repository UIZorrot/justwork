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

test("inbox entry is scoped to the workspace shell, not the global gate topbar", async () => {
  const html = await readFile(path.resolve("src/pages/workbench/index.html"), "utf8");

  const topbarBlock = /<header class="topbar">([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";
  const shellBlock = /<main class="workspace-shell" hidden>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "";

  assert.equal(topbarBlock.includes("workspace-message-drawer-open-btn"), false);
  assert.equal(shellBlock.includes("workspace-message-drawer-open-btn"), true);
});
