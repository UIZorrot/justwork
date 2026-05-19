import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

test("optimistic trash switches away from the active doc immediately", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/trash-state.ts");

  const state = {
    activeDocId: "page-a",
    workspaceTitle: "Workspace",
    workspaceDescription: "",
    docs: [
      {
        id: "root",
        title: "Root",
        markdown: "",
        content: null,
        revision: 0,
        updatedAt: "2026-05-12T00:00:00.000Z",
        lastVisitedAt: "2026-05-12T00:00:00.000Z",
        parentId: null,
        pinned: false,
        inTrash: false,
        kind: "folder",
      },
      {
        id: "page-a",
        title: "Alpha",
        markdown: "",
        content: null,
        revision: 3,
        updatedAt: "2026-05-12T00:00:00.000Z",
        lastVisitedAt: "2026-05-12T00:00:00.000Z",
        parentId: "root",
        pinned: true,
        inTrash: false,
        kind: "page",
      },
      {
        id: "page-b",
        title: "Beta",
        markdown: "",
        content: null,
        revision: 1,
        updatedAt: "2026-05-12T00:00:00.000Z",
        lastVisitedAt: "2026-05-12T00:00:00.000Z",
        parentId: "root",
        pinned: false,
        inTrash: false,
        kind: "page",
      },
    ],
  };

  const next = mod.applyOptimisticTrashState(state, "page-a", "2026-05-12T01:00:00.000Z");

  assert.equal(next.activeDocId, "root");
  const trashed = next.docs.find((doc) => doc.id === "page-a");
  assert.equal(trashed.inTrash, true);
  assert.equal(trashed.pinned, false);
  assert.equal(trashed.revision, 3);
  assert.equal(state.docs.find((doc) => doc.id === "page-a").inTrash, false);
});

test("optimistic trash marks descendant docs when trashing a folder", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/trash-state.ts");

  const state = {
    activeDocId: "page-b",
    workspaceTitle: "Workspace",
    workspaceDescription: "",
    docs: [
      {
        id: "root",
        title: "Root",
        markdown: "",
        content: null,
        revision: 0,
        updatedAt: "2026-05-12T00:00:00.000Z",
        lastVisitedAt: "2026-05-12T00:00:00.000Z",
        parentId: null,
        pinned: false,
        inTrash: false,
        kind: "folder",
      },
      {
        id: "folder-a",
        title: "Folder A",
        markdown: "",
        content: null,
        revision: 2,
        updatedAt: "2026-05-12T00:00:00.000Z",
        lastVisitedAt: "2026-05-12T00:00:00.000Z",
        parentId: "root",
        pinned: false,
        inTrash: false,
        kind: "folder",
      },
      {
        id: "page-b",
        title: "Beta",
        markdown: "",
        content: null,
        revision: 1,
        updatedAt: "2026-05-12T00:00:00.000Z",
        lastVisitedAt: "2026-05-12T00:00:00.000Z",
        parentId: "folder-a",
        pinned: false,
        inTrash: false,
        kind: "page",
      },
    ],
  };

  const next = mod.applyOptimisticTrashState(state, "folder-a", "2026-05-12T01:00:00.000Z");

  assert.equal(next.activeDocId, "root");
  assert.equal(next.docs.find((doc) => doc.id === "folder-a").inTrash, true);
  assert.equal(next.docs.find((doc) => doc.id === "page-b").inTrash, true);
  assert.equal(next.docs.find((doc) => doc.id === "folder-a").revision, 2);
  assert.equal(next.docs.find((doc) => doc.id === "page-b").revision, 1);
});

test("optimistic restore clears descendant trash flags for a restored folder", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/trash-state.ts");

  const state = {
    activeDocId: "folder-a",
    workspaceTitle: "Workspace",
    workspaceDescription: "",
    docs: [
      {
        id: "root",
        title: "Root",
        markdown: "",
        content: null,
        revision: 0,
        updatedAt: "2026-05-12T00:00:00.000Z",
        lastVisitedAt: "2026-05-12T00:00:00.000Z",
        parentId: null,
        pinned: false,
        inTrash: false,
        kind: "folder",
      },
      {
        id: "folder-a",
        title: "Folder A",
        markdown: "",
        content: null,
        revision: 2,
        updatedAt: "2026-05-12T00:00:00.000Z",
        lastVisitedAt: "2026-05-12T00:00:00.000Z",
        parentId: "root",
        pinned: false,
        inTrash: true,
        kind: "folder",
      },
      {
        id: "page-b",
        title: "Beta",
        markdown: "",
        content: null,
        revision: 1,
        updatedAt: "2026-05-12T00:00:00.000Z",
        lastVisitedAt: "2026-05-12T00:00:00.000Z",
        parentId: "folder-a",
        pinned: false,
        inTrash: true,
        kind: "page",
      },
    ],
  };

  const next = mod.applyOptimisticRestoreState(state, "folder-a", "2026-05-12T01:00:00.000Z");

  assert.equal(next.docs.find((doc) => doc.id === "folder-a").inTrash, false);
  assert.equal(next.docs.find((doc) => doc.id === "page-b").inTrash, false);
  assert.equal(next.docs.find((doc) => doc.id === "folder-a").revision, 2);
  assert.equal(next.docs.find((doc) => doc.id === "page-b").revision, 1);
});
