import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import ts from "typescript";

async function loadRepoModule() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "justwork-repo-test-"));
  const repoTsPath = path.resolve("src/features/docs/repo.ts");
  const storageTsPath = path.resolve("src/shared/storage-keys.ts");
  const storageJsPath = path.join(tempDir, "storage-keys.js");
  const repoJsPath = path.join(tempDir, "repo.js");

  const storageSource = await readFile(storageTsPath, "utf8");
  const repoSourceRaw = await readFile(repoTsPath, "utf8");
  const repoSource = repoSourceRaw.replace(
    /from\s+"@\/shared\/storage-keys"/g,
    'from "./storage-keys.js"',
  );

  const compilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  };

  const storageOut = ts.transpileModule(storageSource, { compilerOptions }).outputText;
  const repoOut = ts.transpileModule(repoSource, { compilerOptions }).outputText;
  await writeFile(storageJsPath, storageOut, "utf8");
  await writeFile(repoJsPath, repoOut, "utf8");

  const mod = await import(pathToFileURL(repoJsPath).href);
  return {
    mod,
    dispose: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function makeState() {
  return {
    activeDocId: "page_1",
    workspaceDescription: "test workspace",
    docs: [
      {
        id: "root",
        title: "根目录",
        markdown: "",
        revision: 0,
        updatedAt: "2026-05-06T00:00:00.000Z",
        lastVisitedAt: "2026-05-06T00:00:00.000Z",
        parentId: null,
        pinned: false,
        inTrash: false,
        kind: "folder",
      },
      {
        id: "folder_a",
        title: "A",
        markdown: "",
        revision: 0,
        updatedAt: "2026-05-06T00:00:00.000Z",
        lastVisitedAt: "2026-05-06T00:00:00.000Z",
        parentId: "root",
        pinned: false,
        inTrash: false,
        kind: "folder",
      },
      {
        id: "folder_b",
        title: "B",
        markdown: "",
        revision: 0,
        updatedAt: "2026-05-06T00:00:00.000Z",
        lastVisitedAt: "2026-05-06T00:00:00.000Z",
        parentId: "folder_a",
        pinned: false,
        inTrash: false,
        kind: "folder",
      },
      {
        id: "page_1",
        title: "Page",
        markdown: "hello",
        revision: 0,
        updatedAt: "2026-05-06T00:00:00.000Z",
        lastVisitedAt: "2026-05-06T00:00:00.000Z",
        parentId: "folder_a",
        pinned: false,
        inTrash: false,
        kind: "page",
      },
    ],
  };
}

test("createDoc falls back to root when parent is not a folder", async () => {
  const { mod, dispose } = await loadRepoModule();
  try {
    const state = makeState();
    const next = mod.createDoc(state, "page_1");
    const created = next.docs[0];
    assert.equal(created.kind, "page");
    assert.equal(created.parentId, mod.ROOT_FOLDER_ID);
  } finally {
    await dispose();
  }
});

test("reparentDoc blocks moving a folder into its own descendant", async () => {
  const { mod, dispose } = await loadRepoModule();
  try {
    const state = makeState();
    const next = mod.reparentDoc(state, "folder_a", "folder_b");
    const folderA = next.docs.find((doc) => doc.id === "folder_a");
    assert.equal(folderA.parentId, "root");
  } finally {
    await dispose();
  }
});

test("reparentDoc ignores protected root docs", async () => {
  const { mod, dispose } = await loadRepoModule();
  try {
    const state = makeState();
    const moveRoot = mod.reparentDoc(state, "root", "folder_a");
    const rootDoc = moveRoot.docs.find((doc) => doc.id === "root");
    assert.equal(rootDoc.parentId, null);
  } finally {
    await dispose();
  }
});

test("softDeleteDoc does nothing for protected root", async () => {
  const { mod, dispose } = await loadRepoModule();
  try {
    const state = makeState();
    const next = mod.softDeleteDoc(state, "root");
    const rootDoc = next.docs.find((doc) => doc.id === "root");
    assert.equal(rootDoc.inTrash, false);
  } finally {
    await dispose();
  }
});

test("migrateLegacyWelcomeDocs normalizes legacy welcome pages into regular pages", async () => {
  const { mod, dispose } = await loadRepoModule();
  try {
    const state = {
      activeDocId: "welcome_doc",
      workspaceDescription: "test workspace",
      docs: [
        {
          id: "root",
          title: "根目录",
          markdown: "",
          revision: 0,
          updatedAt: "2026-05-06T00:00:00.000Z",
          lastVisitedAt: "2026-05-06T00:00:00.000Z",
          parentId: null,
          pinned: false,
          inTrash: false,
          kind: "folder",
        },
        {
          id: "welcome_doc",
          title: "Welcome",
          markdown: "# Welcome to JustWork\n\nThis is your document hub.",
          revision: 0,
          updatedAt: "2026-05-06T00:00:00.000Z",
          lastVisitedAt: "2026-05-06T00:00:00.000Z",
          parentId: "root",
          pinned: false,
          inTrash: false,
          kind: "welcome",
        },
      ],
    };

    const next = mod.migrateLegacyWelcomeDocs(state);
    const doc = next.docs.find((item) => item.id === "welcome_doc");
    assert.equal(doc.kind, "page");
    assert.equal(doc.markdown, state.docs.find((item) => item.id === "welcome_doc").markdown);
    assert.equal(next.activeDocId, "welcome_doc");
  } finally {
    await dispose();
  }
});


test("ordinary documents containing welcome phrases are never rewritten", async () => {
  const { mod, dispose } = await loadRepoModule();
  try {
    for (const phrase of ["Welcome to JustWork", "欢迎来到 JustWork", "This is your document hub"]) {
      const doc = { ...makeState().docs.find((doc) => doc.kind === "page"), markdown: `# Notes\n${phrase}\nMy real work`, kind: "page" };
      assert.deepEqual(mod.normalizeLegacyWelcomeDoc(doc), doc);
    }
  } finally { await dispose(); }
});
