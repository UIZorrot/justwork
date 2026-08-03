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
  const tempDir = await mkdtemp(resolve(".tmp-binding-test-"));
  const tempFile = join(tempDir, "module.mjs");
  await writeFile(tempFile, transpiled.outputText, "utf8");
  try {
    return await import(pathToFileURL(tempFile).href);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function createFakeEditorSurface(initialMarkdown = "", isComposing = () => false, isFocused = () => false) {
  let markdown = initialMarkdown;
  const listeners = new Set();
  const setMarkdownCalls = [];
  return {
    getMarkdown() {
      return markdown;
    },
    setMarkdown(nextMarkdown) {
      markdown = nextMarkdown;
      setMarkdownCalls.push(nextMarkdown);
    },
    onMarkdownInput(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isComposing,
    isFocused,
    emitInput(nextMarkdown) {
      markdown = nextMarkdown;
      for (const listener of listeners) {
        listener(nextMarkdown);
      }
    },
    getSetMarkdownCalls() {
      return [...setMarkdownCalls];
    },
  };
}

test("vditor binding syncs markdown both ways without dropping the local snapshot", async () => {
  const bindingMod = await importTsModule("src/features/collaboration/yjs-vditor-binding.ts");
  const collabMod = await importTsModule("src/features/collaboration/yjs-markdown.ts");

  const editor = createFakeEditorSurface("# Local\n");
  const collaborator = collabMod.createMarkdownCollaborator({ initialMarkdown: "# Local\n" });

  const binding = bindingMod.createVditorMarkdownBinding(editor, collaborator);

  assert.deepEqual(editor.getSetMarkdownCalls(), []);

  editor.emitInput("## Edited\n");
  assert.equal(collaborator.getMarkdown(), "## Edited\n");
  assert.deepEqual(editor.getSetMarkdownCalls(), []);

  collaborator.applyLocalMarkdown("### Remote\n");
  assert.equal(editor.getMarkdown(), "### Remote\n");
  assert.deepEqual(editor.getSetMarkdownCalls(), ["### Remote\n"]);

  binding.destroy();
  collaborator.destroy();
});

test("vditor binding rebases active typing over remote updates before repainting", async () => {
  const bindingMod = await importTsModule("src/features/collaboration/yjs-vditor-binding.ts");
  const collabMod = await importTsModule("src/features/collaboration/yjs-markdown.ts");
  const editor = createFakeEditorSurface("draft", () => false, () => true);
  const collaborator = collabMod.createMarkdownCollaborator({ initialMarkdown: "draft" });
  const binding = bindingMod.createVditorMarkdownBinding(editor, collaborator);

  collaborator.applyLocalMarkdown("remote draft");
  assert.equal(editor.getMarkdown(), "draft", "remote repaint must wait while the editor is active");

  editor.emitInput("draft local");
  assert.equal(collaborator.getMarkdown(), "remote draft local");
  assert.equal(editor.getMarkdown(), "draft local", "local DOM must remain stable during the keystroke burst");

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(editor.getMarkdown(), "remote draft local");
  assert.deepEqual(editor.getSetMarkdownCalls(), ["remote draft local"]);

  binding.destroy();
  collaborator.destroy();
});

test("vditor binding does not repaint over native input awaiting Vditor serialization", async () => {
  const bindingMod = await importTsModule("src/features/collaboration/yjs-vditor-binding.ts");
  const collabMod = await importTsModule("src/features/collaboration/yjs-markdown.ts");
  let nativeInputActive = true;
  const editor = createFakeEditorSurface("draft");
  editor.hasRecentNativeInput = () => nativeInputActive;
  const collaborator = collabMod.createMarkdownCollaborator({ initialMarkdown: "draft" });
  const binding = bindingMod.createVditorMarkdownBinding(editor, collaborator);

  collaborator.applyLocalMarkdown("remote draft");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(editor.getMarkdown(), "draft", "pending native input must not be overwritten by a remote render");

  editor.emitInput("draft local");
  assert.equal(collaborator.getMarkdown(), "remote draft local");
  nativeInputActive = false;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(editor.getMarkdown(), "remote draft local");

  binding.destroy();
  collaborator.destroy();
});

test("vditor binding merges remote text received during IME composition", async () => {
  const bindingMod = await importTsModule("src/features/collaboration/yjs-vditor-binding.ts");
  const collabMod = await importTsModule("src/features/collaboration/yjs-markdown.ts");
  let composing = true;
  const editor = createFakeEditorSurface("draft", () => composing);
  editor.getCompositionBaseMarkdown = () => "draft";
  const collaborator = collabMod.createMarkdownCollaborator({ initialMarkdown: "draft" });
  const binding = bindingMod.createVditorMarkdownBinding(editor, collaborator);

  collaborator.applyLocalMarkdown("remote draft");
  assert.equal(editor.getMarkdown(), "draft");
  assert.deepEqual(editor.getSetMarkdownCalls(), []);

  composing = false;
  editor.emitInput("draft local");
  assert.equal(collaborator.getMarkdown(), "remote draft local");
  assert.equal(editor.getMarkdown(), "remote draft local");

  binding.destroy();
  collaborator.destroy();
});

test("vditor binding initializes the editor from the collaborator snapshot", async () => {
  const bindingMod = await importTsModule("src/features/collaboration/yjs-vditor-binding.ts");
  const collabMod = await importTsModule("src/features/collaboration/yjs-markdown.ts");

  const editor = createFakeEditorSurface("# Local\n");
  const collaborator = collabMod.createMarkdownCollaborator({ initialMarkdown: "## Remote\n" });

  const binding = bindingMod.createVditorMarkdownBinding(editor, collaborator);
  binding.applyRemoteMarkdown(collaborator.getMarkdown());

  assert.equal(editor.getMarkdown(), "## Remote\n");
  assert.deepEqual(editor.getSetMarkdownCalls(), ["## Remote\n"]);

  binding.destroy();
  collaborator.destroy();
});

test("bootstrap replay keeps typing made before the canonical room becomes ready", async () => {
  const bindingMod = await importTsModule("src/features/collaboration/yjs-vditor-binding.ts");

  const base = "Roadmap\n";
  const typedWhileJoining = "Roadmap\nLocal idea\n";
  const canonicalWhenJoinCompletes = "Remote heading\nRoadmap\n";
  const replayed = bindingMod.replayMarkdownEdit(base, typedWhileJoining, canonicalWhenJoinCompletes);

  assert.equal(replayed.clean, true);
  assert.equal(replayed.markdown, "Remote heading\nRoadmap\nLocal idea\n");
});
