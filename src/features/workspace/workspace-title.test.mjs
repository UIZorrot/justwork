import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("workspace title is stored separately from document titles", async () => {
  const models = await readFile(path.resolve("backend/app/models.py"), "utf8");
  const runtime = await readFile(path.resolve("backend/app/workspace_runtime.py"), "utf8");
  const client = await readFile(path.resolve("src/features/backend/client.ts"), "utf8");
  const workbench = await readFile(path.resolve("src/pages/workbench/backend-workbench.ts"), "utf8");

  assert.match(models, /workspace_title: str/);
  assert.match(runtime, /"workspaceTitle"/);
  assert.match(runtime, /initial_doc_title: str = "Untitled"/);
  assert.match(client, /updateWorkspaceSettings/);
  assert.match(workbench, /updateWorkspaceTitle/);
  assert.equal(workbench.includes("findWorkspaceNameDoc"), false);
});
