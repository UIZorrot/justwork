import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the web app starts at existing-workspace login while creation remains available", async () => {
  const workbench = await readFile("src/pages/workbench/backend-workbench.ts", "utf8");
  const html = await readFile("src/pages/workbench/index.html", "utf8");
  const webConfig = await readFile("vite.web.config.ts", "utf8");
  const extensionConfig = await readFile("vite.config.ts", "utf8");
  const i18n = await readFile("src/shared/i18n.ts", "utf8");

  assert.match(webConfig, /__JUSTWORK_WEB_APP__.*true/s);
  assert.match(extensionConfig, /__JUSTWORK_WEB_APP__.*false/s);
  assert.match(workbench, /savedWsId \|\| __JUSTWORK_WEB_APP__ \? "unlock" : "setup"/);
  assert.match(html, /id="login-workspace-btn"/);
  assert.match(workbench, /loginWorkspaceBtn\.addEventListener\("click"/);
  assert.match(i18n, /"gate\.setup\.loginWorkspace": "Log in to an existing workspace"/);
  assert.match(i18n, /"gate\.setup\.loginWorkspace": "登录已有工作区"/);
  assert.match(i18n, /"gate\.unlock\.title": "登录已有工作区"/);
  assert.match(html, /<title data-i18n="app\.workbench\.title">JustWork<\/title>/);
  assert.match(html, /href="%BASE_URL%justwork_logo\.png\?v=0\.1\.0"/);
  assert.doesNotMatch(html, /icons\/icon-(?:16|32)\.png/);
});
