import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

function createState() {
  return {
    activeDocId: "page-a",
    workspaceTitle: "Workspace",
    workspaceDescription: "",
    docs: [
      { id: "root", title: "Root", markdown: "", content: null, revision: 0, updatedAt: "", lastVisitedAt: "", parentId: null, pinned: false, inTrash: false, kind: "folder" },
      { id: "folder-a", title: "Folder", markdown: "", content: null, revision: 5, updatedAt: "", lastVisitedAt: "", parentId: "root", pinned: false, inTrash: false, kind: "folder" },
      { id: "page-a", title: "Alpha", markdown: "", content: null, revision: 7, updatedAt: "", lastVisitedAt: "", parentId: "root", pinned: false, inTrash: false, kind: "page" },
    ],
  };
}

test("applyOptimisticMove preserves revision while updating parentId", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/optimistic-doc-state.ts");
  const next = mod.applyOptimisticMove(createState(), "page-a", "folder-a", "2026-05-13T00:00:00.000Z");
  const moved = next.docs.find((doc) => doc.id === "page-a");
  assert.equal(moved.parentId, "folder-a");
  assert.equal(moved.revision, 7);
});

test("applyOptimisticPinned preserves revision while toggling pinned state", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/optimistic-doc-state.ts");
  const next = mod.applyOptimisticPinned(createState(), "page-a", true, "2026-05-13T00:00:00.000Z");
  const pinned = next.docs.find((doc) => doc.id === "page-a");
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.revision, 7);
});
