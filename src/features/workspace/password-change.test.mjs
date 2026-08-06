import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("workspace password change is owner-only in the UI and uses a signed API write", async () => {
  const [client, signing, runtime, workbench, html] = await Promise.all([
    read("../backend/client.ts"),
    read("../backend/sign-write.ts"),
    read("./backend-runtime.ts"),
    read("../../pages/workbench/backend-workbench.ts"),
    read("../../pages/workbench/index.html"),
  ]);

  assert.match(client, /changeWorkspacePassword[\s\S]*method|changeWorkspacePassword/);
  assert.match(client, /\/password`, body/);
  assert.match(signing, /\/password\$\/\.test\(path\)\) return "password"/);
  assert.match(runtime, /let currentPassword = opts\.password/);
  assert.match(runtime, /currentPassword = newPassword/);
  assert.match(html, /id="workspace-info-password-section"[^>]*hidden/);
  assert.match(html, /drawer\.profile\.passwordWarning/);
  assert.match(workbench, /workspaceInfoPasswordSection\.hidden = currentMember\?\.is_owner !== true/);
  assert.match(workbench, /window\.confirm\(t\("drawer\.profile\.passwordConfirm"/);
  assert.match(workbench, /waitForAllDocSaveQueuesToSettle\(\)/);
  assert.match(workbench, /session\.changePassword\(nextPassword, workspaceRevision\)/);
});
