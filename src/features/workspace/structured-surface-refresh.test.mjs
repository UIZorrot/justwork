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

test("structured hydration cannot overwrite an edit made while the item request is in flight", async () => {
  const workbench = await readFile(path.resolve("src/pages/workbench/backend-workbench.ts"), "utf8");
  const hydrationBlock = /const hydrateStructuredDocInPlace = \(doc: WorkspaceDoc, cached: WorkspaceDoc\): Promise<void> => \{([\s\S]*?)\n    \};/.exec(workbench)?.[1] ?? "";

  assert.match(hydrationBlock, /structuredHydrationInFlight\.get\(doc\.id\)/);
  assert.match(hydrationBlock, /const hydrationGeneration = localEditGenerationByDoc\.get\(doc\.id\)/);
  assert.match(hydrationBlock, /await session\.loadItem\(doc\.id\)/);
  assert.match(hydrationBlock, /hasNewerLocalEditGeneration\([\s\S]*?hydrationGeneration/);
  assert.match(hydrationBlock, /hasEditDuringHydration \|\| dirtyDocIds\.has\(doc\.id\)/);
});

test("structured bodies prefetch on intent without duplicate backend reads", async () => {
  const workbench = await readFile(path.resolve("src/pages/workbench/backend-workbench.ts"), "utf8");

  assert.match(workbench, /const structuredHydrationInFlight = new Map<string, Promise<void>>\(\)/);
  assert.match(workbench, /if \(existingHydration\) return existingHydration/);
  assert.match(workbench, /btn\.addEventListener\("pointerenter", \(\) => prefetchStructuredDoc\(doc\), \{ once: true \}\)/);
  assert.match(workbench, /btn\.addEventListener\("focus", \(\) => prefetchStructuredDoc\(doc\), \{ once: true \}\)/);
  assert.match(workbench, /const recentTable = workspace\.docs/);
  assert.match(workbench, /if \(recentTable\) prefetchStructuredDoc\(recentTable\)/);
});
