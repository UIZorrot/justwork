import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

test("stale backend drafts do not overwrite newer server revisions", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/backend-doc-drafts.ts");

  const doc = {
    id: "page-1",
    title: "Server title",
    markdown: "Server body",
    content: null,
    revision: 4,
    updatedAt: "2026-05-19T10:00:00.000Z",
    lastVisitedAt: "2026-05-19T10:00:00.000Z",
    parentId: "root",
    pinned: false,
    inTrash: false,
    kind: "page",
  };
  const staleDraft = {
    workspaceId: "ws-1",
    itemId: "page-1",
    markdown: "",
    title: "Local stale title",
    seq: 2,
    updatedAt: "2026-05-19T09:00:00.000Z",
    baseRevision: 3,
  };

  assert.equal(mod.shouldApplyBackendDocDraft(doc, staleDraft), false);
  assert.deepEqual(mod.applyBackendDocDraft(doc, staleDraft), doc);
});

test("drafts based on the current server revision still overlay local unsaved edits", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/backend-doc-drafts.ts");

  const doc = {
    id: "page-1",
    title: "Server title",
    markdown: "Server body",
    content: null,
    revision: 4,
    updatedAt: "2026-05-19T10:00:00.000Z",
    lastVisitedAt: "2026-05-19T10:00:00.000Z",
    parentId: "root",
    pinned: false,
    inTrash: false,
    kind: "page",
  };
  const draft = {
    workspaceId: "ws-1",
    itemId: "page-1",
    markdown: "Local unsaved body",
    title: "Local title",
    seq: 3,
    updatedAt: "2026-05-19T10:01:00.000Z",
    baseRevision: 4,
  };

  assert.equal(mod.shouldApplyBackendDocDraft(doc, draft), true);
  assert.equal(mod.applyBackendDocDraft(doc, draft).markdown, "Local unsaved body");
});

test("draftIndicatesNewerLocalEdit only compares fields from the in-flight patch", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/backend-doc-drafts.ts");
  const equals = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const draft = {
    workspaceId: "ws-1",
    itemId: "page-1",
    title: "Saved title",
    markdown: "Stale leftover markdown",
    seq: 3,
    updatedAt: "2026-05-19T10:01:00.000Z",
  };

  assert.equal(
    mod.draftIndicatesNewerLocalEdit(
      draft,
      3,
      { title: "Saved title" },
      { title: "Saved title", markdown: "Server body", content: null },
      equals,
    ),
    false,
  );

  assert.equal(
    mod.draftIndicatesNewerLocalEdit(
      { ...draft, title: "Typed after save started" },
      3,
      { title: "Saved title" },
      { title: "Saved title", markdown: "Server body", content: null },
      equals,
    ),
    true,
  );

  assert.equal(
    mod.draftIndicatesNewerLocalEdit(
      draft,
      3,
      { markdown: "Server body" },
      { title: "Saved title", markdown: "Server body", content: null },
      equals,
    ),
    true,
  );

  assert.equal(
    mod.draftIndicatesNewerLocalEdit(
      { ...draft, seq: 4 },
      3,
      { title: "Saved title" },
      { title: "Saved title", markdown: "Server body", content: null },
      equals,
    ),
    true,
  );
});
