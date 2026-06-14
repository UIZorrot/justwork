import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("workbench reuses structured views for active board and table refreshes", async () => {
  const workbench = await readFile(path.resolve("src/pages/workbench/backend-workbench.ts"), "utf8");

  for (const required of [
    "let structuredSurfaceDocId: string | null = null;",
    "let structuredSurfaceKind: WorkspaceDoc[\"kind\"] | null = null;",
    "if (tableView && structuredSurfaceDocId === doc.id && structuredSurfaceKind === doc.kind) {",
    "tableView.update(content);",
    "if (boardView && structuredSurfaceDocId === doc.id && structuredSurfaceKind === doc.kind) {",
    "boardView.update(content);",
  ]) {
    assert.equal(workbench.includes(required), true, `expected workbench to include ${required}`);
  }
});
