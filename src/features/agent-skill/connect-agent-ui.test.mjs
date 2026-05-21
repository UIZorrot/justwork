import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const workbenchHtmlPath = path.resolve("src/pages/workbench/index.html");
const workbenchTsPath = path.resolve("src/pages/workbench/backend-workbench.ts");

test("workspace sidebar includes a Connect Agent modal with copy and download controls", async () => {
  const html = await readFile(workbenchHtmlPath, "utf8");

  for (const required of [
    'id="setup-remember-password-input"',
    'id="unlock-remember-password-input"',
    'id="connect-agent-btn"',
    'id="connect-agent-dialog-root"',
    'id="connect-agent-dialog"',
    'id="connect-agent-prompt-text"',
    'id="connect-agent-copy-btn"',
    'id="connect-agent-download-skill-link"',
  ]) {
    assert.match(html, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("Connect Agent appears before New document in the sidebar create section", async () => {
  const html = await readFile(workbenchHtmlPath, "utf8");
  const connectIndex = html.indexOf('id="connect-agent-btn"');
  const newFileIndex = html.indexOf('id="new-file-btn"');
  assert.notEqual(connectIndex, -1);
  assert.notEqual(newFileIndex, -1);
  assert.ok(connectIndex < newFileIndex);
});

test("Connect Agent prompt only includes the real password when the user remembered it locally", async () => {
  const workbench = await readFile(workbenchTsPath, "utf8");

  assert.match(workbench, /function buildConnectAgentPrompt\(/);
  assert.match(workbench, /rememberPassword \? password : "<replace with workspace password>"/);
  assert.match(workbench, /Workspace ID: \$\{workspaceId\}/);
  assert.match(workbench, /Workspace password: \$\{passwordValue\}/);
  assert.match(workbench, /Replace the placeholder before sending this setup text/);
  assert.match(workbench, /new URL\("\/agent\/SKILL\.md", JUSTWORK_BACKEND_URL\)/);
  assert.match(workbench, /chrome\.runtime\.getURL\("agent\/SKILL\.md"\)/);
  assert.match(workbench, /connectAgentCopyBtn\.addEventListener\("click",/);
});

test("remembered workspace passwords are stored locally and wired into unlock", async () => {
  const storageKeys = await readFile(path.resolve("src/shared/storage-keys.ts"), "utf8");
  const workbench = await readFile(workbenchTsPath, "utf8");

  assert.match(storageKeys, /BACKEND_WORKSPACE_PASSWORDS/);
  assert.match(workbench, /getRememberedWorkspacePassword/);
  assert.match(workbench, /setRememberedWorkspacePassword/);
  assert.match(workbench, /removeRememberedWorkspacePassword/);
  assert.match(workbench, /unlockRememberPasswordInput\.checked/);
  assert.match(workbench, /mountWithPassword\(wsId, password, undefined, undefined, unlockRememberPasswordInput\.checked\)/);
  assert.match(workbench, /buildConnectAgentPrompt\(workspaceId, password, rememberWorkspacePassword\)/);
});
