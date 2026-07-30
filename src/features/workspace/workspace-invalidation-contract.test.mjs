import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

test("workspace relay accepts durable mutation invalidations", async () => {
  const protocol = await loadTranspiledModule("src/features/workspace/assets/relay-protocol.ts");
  assert.deepEqual(protocol.parseRelayMessage({
    type: "workspace.invalidated",
    workspaceId: "workspace_1",
    updatedAt: "2026-07-30T00:00:00Z",
  }), {
    type: "workspace.invalidated",
    workspaceId: "workspace_1",
    updatedAt: "2026-07-30T00:00:00Z",
  });
  assert.equal(protocol.parseRelayMessage({
    type: "workspace.invalidated",
    workspaceId: "workspace_1",
  }), null);
});

test("workbench refreshes promptly when another client commits workspace state", async () => {
  const source = await readFile("src/pages/workbench/backend-workbench.ts", "utf8");
  assert.match(source, /onWorkspaceInvalidated:\s*\(\) => \{[\s\S]*?scheduleTreeRefresh\(40\)/);
});
