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

test("inbox mark-all-read action lives under mentions and the log is not boxed", async () => {
  const html = await readFile(path.resolve("src/pages/workbench/index.html"), "utf8");
  const css = await readFile(path.resolve("src/pages/workbench/workbench.css"), "utf8");

  const headerBlock = /<div class="workspace-message-drawer-header">([\s\S]*?)<\/div>\s*<div class="workspace-message-drawer-body">/.exec(html)?.[1] ?? "";
  const logSection = /<section class="workspace-message-section workspace-message-section--log">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";
  const logRule = /\.workspace-message-log\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";

  assert.equal(headerBlock.includes("workspace-message-mark-read-btn"), false);
  assert.equal(logSection.includes("workspace-message-mark-read-btn"), true);
  assert.equal(logSection.indexOf("drawer.message.logHeading") < logSection.indexOf("workspace-message-mark-read-btn"), true);
  assert.equal(logSection.indexOf("workspace-message-mark-read-btn") < logSection.indexOf("workspace-message-log"), true);
  assert.equal(logRule.includes("border:"), false);
  assert.equal(logRule.includes("background:"), false);
});

test("read inbox mentions expose a separate delete action instead of deleting on open", async () => {
  const workbench = await readFile(path.resolve("src/pages/workbench/backend-workbench.ts"), "utf8");

  const renderBlock = /const renderInboxPanel = \(\): void => \{([\s\S]*?)\n    \};/.exec(workbench)?.[1] ?? "";

  assert.equal(renderBlock.includes("workspace-message-delete-read-btn"), true);
  assert.equal(renderBlock.includes("if (notification.isRead)"), true);
  assert.equal(renderBlock.includes("markLocalInboxNotificationRead"), true);
  assert.equal(renderBlock.includes("dismissLocalInboxNotification"), true);
  assert.equal(renderBlock.includes("const row = document.createElement(\"button\")"), false);
});
