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

test("stale collaborative saves are rejected when live text moved on", async () => {
  const mod = await importTsModule("src/features/collaboration/save-race.ts");

  const applySaveResult = ({ liveDoc, request, savedDoc, hasNewerDraft = false, snapshotMarkdown }) => {
    const stale = mod.hasStaleCollaborativeSave(liveDoc, request);
    const resolution = mod.reconcileCollaborativeSave(liveDoc, stale, hasNewerDraft);
    return {
      stale,
      dirty: resolution.shouldKeepDirty,
      snapshotMarkdown: resolution.shouldReseedSnapshot ? savedDoc.markdown : snapshotMarkdown,
      doc: {
        ...savedDoc,
        title: resolution.retainedTitle ?? savedDoc.title,
        markdown: resolution.retainedMarkdown ?? savedDoc.markdown,
      },
    };
  };

  const staleResult = applySaveResult({
    liveDoc: { title: "Draft 2", markdown: "# Draft\nmore\n" },
    request: { nextTitle: "Draft", nextMarkdown: "# Draft\n" },
    savedDoc: {
      title: "Draft",
      markdown: "# Draft\n",
      revision: 7,
      updatedAt: "2026-05-08T09:00:00.000Z",
    },
    snapshotMarkdown: "# Draft\nmore\n",
  });

  assert.equal(staleResult.stale, true);
  assert.equal(staleResult.dirty, true);
  assert.equal(staleResult.snapshotMarkdown, "# Draft\nmore\n");
  assert.deepEqual(staleResult.doc, {
    title: "Draft 2",
    markdown: "# Draft\nmore\n",
    revision: 7,
    updatedAt: "2026-05-08T09:00:00.000Z",
  });

  const freshResult = applySaveResult({
    liveDoc: { title: "Draft", markdown: "# Draft\n" },
    request: { nextTitle: "Draft", nextMarkdown: "# Draft\n" },
    savedDoc: {
      title: "Draft",
      markdown: "# Draft\n",
      revision: 8,
      updatedAt: "2026-05-08T09:01:00.000Z",
    },
    snapshotMarkdown: "# Old snapshot\n",
  });

  assert.equal(freshResult.stale, false);
  assert.equal(freshResult.dirty, false);
  assert.equal(freshResult.snapshotMarkdown, "# Draft\n");
  assert.deepEqual(freshResult.doc, {
    title: "Draft",
    markdown: "# Draft\n",
    revision: 8,
    updatedAt: "2026-05-08T09:01:00.000Z",
  });
});

test("structured collaborative saves are rejected when live content moved on", async () => {
  const mod = await importTsModule("src/features/collaboration/save-race.ts");

  const liveDoc = {
    title: "Untitled board",
    markdown: "",
    content: { kind: "board", cards: [{ id: "card_1", title: "Keep me", fields: [] }], columns: [], template: { columnId: "template", title: "Template", cardTitle: "Default", fields: [] } },
  };
  const request = {
    nextTitle: "Untitled board",
    nextMarkdown: "",
    content: { kind: "board", cards: [{ id: "card_1", title: "Keep me", fields: [] }, { id: "card_2", title: "Delete me later", fields: [] }], columns: [], template: { columnId: "template", title: "Template", cardTitle: "Default", fields: [] } },
  };

  const stale = mod.hasStaleCollaborativeSave(liveDoc, request);
  assert.equal(stale, true);
});

test("separate debounced save batches receive separate idempotency keys", async () => {
  const mod = await importTsModule("src/features/collaboration/save-race.ts");
  let sequence = 0;
  const createMutationId = () => `mutation-${++sequence}`;

  const firstBatch = mod.resolveSaveMutationId(undefined, createMutationId);
  const mergedIntoFirstBatch = mod.resolveSaveMutationId(firstBatch, createMutationId);
  const secondBatch = mod.resolveSaveMutationId(undefined, createMutationId);

  assert.equal(mergedIntoFirstBatch, firstBatch);
  assert.notEqual(secondBatch, firstBatch);
});

test("an old idempotent response cannot confirm newer editor text", async () => {
  const mod = await importTsModule("src/features/collaboration/save-race.ts");
  const request = {
    nextTitle: "Page",
    nextMarkdown: "newer typing",
  };

  assert.equal(mod.hasUnexpectedCollaborativeSaveResult({
    title: "Page",
    markdown: "older save",
  }, request), true);
  assert.equal(mod.hasUnexpectedCollaborativeSaveResult({
    title: "Page",
    markdown: "newer typing",
  }, request), false);
});

test("remote-only changes do not masquerade as a newer local save generation", async () => {
  const mod = await importTsModule("src/features/collaboration/save-race.ts");
  assert.equal(mod.hasNewerLocalEditGeneration(4, 4), false);
  assert.equal(mod.hasNewerLocalEditGeneration(4, 5), true);
});
