import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

function transpileModule(source, filename) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      esModuleInterop: true,
      verbatimModuleSyntax: false,
    },
    fileName: filename,
  });
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(output.outputText)}`;
}

test("local inbox notifications dedupe repeated mention hits", async () => {
  const source = await readFile(path.resolve("src/features/workspace/local-inbox.ts"), "utf8");
  const moduleUrl = transpileModule(source, "local-inbox.ts");
  const mod = await import(moduleUrl);

  const first = mod.createMentionNotification({
    workspaceId: "ws_1",
    docId: "doc_1",
    docTitle: "Doc",
    mentionText: "@Alice please review",
    recipientDisplayName: "Alice",
    createdAt: "2026-05-11T00:00:00.000Z",
  });
  const second = mod.createMentionNotification({
    workspaceId: "ws_1",
    docId: "doc_1",
    docTitle: "Doc",
    mentionText: "@Alice please review",
    recipientDisplayName: "Alice",
    createdAt: "2026-05-11T00:00:01.000Z",
  });

  assert.equal(first.dedupeKey, second.dedupeKey);
  assert.equal(mod.hasMention("hello @Alice", "Alice"), true);
  assert.equal(mod.hasMention("hello", "Alice"), false);
  assert.equal(mod.extractMentionSnippet("one\n@Alice please review this\nthree", "Alice"), "@Alice please review this");
});

test("local inbox mention detection respects name boundaries", async () => {
  const source = await readFile(path.resolve("src/features/workspace/local-inbox.ts"), "utf8");
  const moduleUrl = transpileModule(source, "local-inbox.ts");
  const mod = await import(moduleUrl);

  assert.equal(mod.hasMention("hello @Anna", "Ann"), false);
  assert.equal(mod.hasMention("hello @Ann", "Ann"), true);
  assert.equal(mod.hasMention("mail me at ann@example.com", "ann"), false);
});

test("local inbox emits a new notification when a later mention is genuinely added", async () => {
  const source = await readFile(path.resolve("src/features/workspace/local-inbox.ts"), "utf8");
  const moduleUrl = transpileModule(source, "local-inbox.ts");
  const mod = await import(moduleUrl);

  const firstWave = mod.extractMentionNotifications({
    previousMarkdown: "",
    nextMarkdown: "hello @Alice\nanother line",
    workspaceId: "ws_1",
    docId: "doc_1",
    docTitle: "Doc",
    recipientDisplayName: "Alice",
  });
  assert.equal(firstWave.length, 1);

  const secondWave = mod.extractMentionNotifications({
    previousMarkdown: "hello @Alice\nanother line",
    nextMarkdown: "hello @Alice\nanother line\nplease check this too, @Alice",
    workspaceId: "ws_1",
    docId: "doc_1",
    docTitle: "Doc",
    recipientDisplayName: "Alice",
  });
  assert.equal(secondWave.length, 1);
  assert.notEqual(firstWave[0].dedupeKey, secondWave[0].dedupeKey);
  assert.match(secondWave[0].mentionText, /@Alice/);
});
