import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import test from "node:test";
import ts from "typescript";

async function importTsModule(filePath) {
  const source = await readFile(filePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Preserve,
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

test("markdown collaborator round-trips plain markdown text", async () => {
  const mod = await importTsModule("src/features/collaboration/yjs-markdown.ts");
  const source = mod.createMarkdownCollaborator({ initialMarkdown: "hello\n\n***\n" });
  const replica = mod.createMarkdownCollaborator({ initialMarkdown: "" });

  assert.equal(source.getMarkdown(), "hello\n\n***\n");
  assert.equal(replica.getMarkdown(), "");

  source.applyLocalMarkdown("# Updated\n");
  const update = source.encodeUpdate();

  assert.ok(update instanceof Uint8Array);
  assert.ok(update.length > 0);

  replica.applyRemoteUpdate(update);
  assert.equal(replica.getMarkdown(), "# Updated\n");

  source.destroy();
  replica.destroy();
});

test("markdown collaborator applies the authoritative bootstrap snapshot without rewriting history", async () => {
  const mod = await importTsModule("src/features/collaboration/yjs-markdown.ts");
  const remote = mod.createMarkdownCollaborator({ initialMarkdown: "hello" });
  const local = mod.createMarkdownCollaborator();

  const changed = local.applyRemoteUpdate(remote.encodeUpdate());

  assert.equal(changed, true);
  assert.equal(local.getMarkdown(), "hello");

  remote.destroy();
  local.destroy();
});

test("minimal markdown edits converge without dropping concurrent suffixes", async () => {
  const mod = await importTsModule("src/features/collaboration/yjs-markdown.ts");
  const seed = mod.createMarkdownCollaborator({ initialMarkdown: "hello" });
  const left = mod.createMarkdownCollaborator();
  const right = mod.createMarkdownCollaborator();
  left.applyRemoteUpdate(seed.encodeUpdate());
  right.applyRemoteUpdate(seed.encodeUpdate());

  left.applyLocalMarkdown("hello A");
  right.applyLocalMarkdown("hello B");
  const leftUpdate = left.encodeUpdate();
  const rightUpdate = right.encodeUpdate();
  left.applyRemoteUpdate(rightUpdate);
  right.applyRemoteUpdate(leftUpdate);

  assert.equal(left.getMarkdown(), right.getMarkdown());
  assert.match(left.getMarkdown(), /A/);
  assert.match(left.getMarkdown(), /B/);

  seed.destroy();
  left.destroy();
  right.destroy();
});
