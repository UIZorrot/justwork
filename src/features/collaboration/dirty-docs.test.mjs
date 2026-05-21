import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

async function importTsModule(filePath) {
  const source = await readFile(filePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  const tempDir = await mkdtemp(resolve(".tmp-collab-test-"));
  const tempFile = join(tempDir, "module.mjs");
  await writeFile(tempFile, transpiled.outputText, "utf8");
  try {
    return await import(pathToFileURL(tempFile).href);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("dirty collaborative docs keep their cached local title after a tree refresh", async () => {
  const mod = await importTsModule("src/features/collaboration/dirty-docs.ts");

  const serverDocs = [
    { id: "a", title: "Server A", markdown: "a" },
    { id: "b", title: "Server B", markdown: "b" },
  ];
  const dirtyDocIds = new Set(["b"]);
  const localCache = new Map([
    ["b", { id: "b", title: "Local B", markdown: "local b" }],
  ]);

  const nextDocs = mod.overlayDirtyCollaborativeDocs(serverDocs, dirtyDocIds, localCache);

  assert.deepEqual(nextDocs, [
    { id: "a", title: "Server A", markdown: "a" },
    { id: "b", title: "Local B", markdown: "local b" },
  ]);
});

test("clean collaborative docs prefer server data unless local revision is newer", async () => {
  const mod = await importTsModule("src/features/collaboration/dirty-docs.ts");

  const serverDocs = [
    { id: "a", title: "Server A", markdown: "server a", revision: 3 },
    { id: "b", title: "Server B", markdown: "server b", revision: 4 },
  ];
  const dirtyDocIds = new Set();
  const localCache = new Map([
    ["a", { id: "a", title: "Local Older", markdown: "local a", revision: 2 }],
    ["b", { id: "b", title: "Local Newer", markdown: "local b", revision: 5 }],
  ]);

  const nextDocs = mod.overlayDirtyCollaborativeDocs(serverDocs, dirtyDocIds, localCache);

  assert.deepEqual(nextDocs, [
    { id: "a", title: "Server A", markdown: "server a", revision: 3 },
    { id: "b", title: "Local Newer", markdown: "local b", revision: 5 },
  ]);
});
