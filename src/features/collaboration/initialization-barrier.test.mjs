import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("page collaboration waits for a canonical CRDT lineage before binding the editor", async () => {
  const source = await readFile("src/pages/workbench/backend-workbench.ts", "utf8");

  assert.match(source, /::crdt-v3::/);
  const bindBlock = /const bindEditorToActiveDoc = \(\): void => \{([\s\S]*?)\n    \};/.exec(source)?.[1] ?? "";
  assert.match(
    bindBlock,
    /if \(!collaborationReadyDocIds\.has\(active\.id\)\) \{[\s\S]*?editor\.bindCollaborator\(undefined\);[\s\S]*?setCollaborationSurfacePending\(active, true\);[\s\S]*?return;/,
  );
  assert.doesNotMatch(
    bindBlock,
    /startCollaborativeTransport\(active\)[\s\S]{0,120}setCollaborationSurfacePending\(active, false\)/,
  );
  assert.doesNotMatch(source, /applyLocalMarkdown\(hydrated(?:Markdown|\.markdown)\)/);
  assert.match(source, /shouldResetCollaborativeLineage\([\s\S]*join\.room_epoch/);
  assert.match(source, /resetMarkdownCollaborator\(doc\)/);
  assert.doesNotMatch(source, /Promise\.all\(\[[\s\S]*joinCollaborativeMarkdown/);
  assert.match(source, /transport\.sendUpdate\(update\)/);
  const transportBlock = /const startCollaborativeTransport = async \(doc: WorkspaceDoc\): Promise<void> => \{([\s\S]*?)\n    \};/.exec(source)?.[1] ?? "";
  assert.match(
    transportBlock,
    /join\.bootstrap_owner[\s\S]*?hasUnboundBootstrapEdit \? bootstrapLocalMarkdown : bootstrapBaseMarkdown/,
  );
  assert.match(
    transportBlock,
    /replayedBootstrapEdit = hasUnboundBootstrapEdit && seedMarkdown !== bootstrapBaseMarkdown/,
  );
  assert.doesNotMatch(source, /markdownHost\.inert\s*=\s*pending/);
  assert.doesNotMatch(source, /structuredHost\.inert\s*=\s*pending/);
  assert.match(source, /markdownHost\.inert\s*=\s*documentLoadBlocked/);
  assert.match(source, /structuredHost\.inert\s*=\s*documentLoadBlocked/);
  assert.match(
    bindBlock,
    /if \(!hydratedDocIds\.has\(active\.id\)\) \{[\s\S]*?editor\.bindCollaborator\(undefined\);[\s\S]*?setMarkdownBodyLoading\(true\);[\s\S]*?return;/,
  );
  const readyBlock = /const markCollaborationReady = \(doc: WorkspaceDoc\): void => \{([\s\S]*?)\n    \};/.exec(source)?.[1] ?? "";
  assert.match(readyBlock, /!hydratedDocIds\.has\(doc\.id\)/);
});

test("first-time Markdown navigation hides stale editor content until the full body is hydrated", async () => {
  const source = await readFile("src/pages/workbench/backend-workbench.ts", "utf8");
  const styles = await readFile("src/pages/workbench/workbench.css", "utf8");
  const switchBlock = /const switchActiveDoc = \(doc: WorkspaceDoc\): void => \{([\s\S]*?)\n    \};/.exec(source)?.[1] ?? "";

  assert.match(switchBlock, /const needsMarkdownHydration = !hydratedDocIds\.has\(doc\.id\)/);
  assert.match(switchBlock, /setMarkdownBodyLoading\(needsMarkdownHydration\);[\s\S]*?syncEditorWithActive\(\)/);
  assert.doesNotMatch(
    switchBlock,
    /setMarkdownBodyLoading\(needsMarkdownHydration\);[\s\S]{0,240}?editor\.setMarkdown\(initialMarkdown/,
  );
  assert.doesNotMatch(switchBlock, /editorMarkdownDuringHydration|hasUntrackedHydrationEdit/);
  assert.doesNotMatch(switchBlock, /commitLocalEdit\(doc\.id, \{ markdown:/);
  assert.match(switchBlock, /editor\.setMarkdown\(nextMarkdown, true\);[\s\S]*?setMarkdownBodyLoading\(false\)/);
  assert.match(switchBlock, /const hydrated = await hydrateMarkdownDocInPlace\(doc, cached\)/);
  assert.match(switchBlock, /\.catch\(\(error\) => \{[\s\S]*?markDocumentLoadFailed\(doc\.id\)/);
  assert.match(source, /const markdownHydrationInFlight = new Map<string, Promise<WorkspaceDoc>>\(\)/);
  assert.match(source, /pointerenter[\s\S]{0,100}?prefetchMarkdownDoc\(doc\)/);
  assert.match(styles, /\.doc-editor-surface--markdown\.is-body-loading > \*[\s\S]*?visibility: hidden/);
  assert.match(styles, /content: attr\(data-loading-label\)/);
});

test("structured documents share the canonical realtime lineage without whole-array replacement", async () => {
  const source = await readFile("src/pages/workbench/backend-workbench.ts", "utf8");
  const transportBlock = /const startCollaborativeTransport = async \(doc: WorkspaceDoc\): Promise<void> => \{([\s\S]*?)\n    \};/.exec(source)?.[1] ?? "";
  const bindBlock = /const bindEditorToActiveDoc = \(\): void => \{([\s\S]*?)\n    \};/.exec(source)?.[1] ?? "";

  assert.match(transportBlock, /\["page", "table", "board"\]/);
  assert.match(transportBlock, /setCollaborationSurfacePending\(doc, true\);[\s\S]*?await session\.joinCollaborativeMarkdown/);
  assert.match(transportBlock, /getStructuredCollaboratorForDoc\(doc\)/);
  assert.match(transportBlock, /structuredCollaborator\.applyRemoteUpdate\(update\)/);
  assert.equal(
    source.match(/collaborator\.applyLocalContent\(nextContent, viewBaseContent\)/g)?.length,
    2,
    "table and board edits must both be applied as deltas from the rendered view",
  );
  assert.match(
    bindBlock,
    /active\.kind === "table" \|\| active\.kind === "board"[\s\S]*?getStructuredCollaboratorForDoc\(active\)[\s\S]*?startCollaborativeTransport\(active\)/,
  );
  assert.doesNotMatch(
    bindBlock,
    /active\.kind === "table" \|\| active\.kind === "board"[\s\S]{0,100}?setCollaborationSurfacePending\(active, false\);[\s\S]{0,80}?stopActiveCollaborativeTransport\(\);[\s\S]{0,40}?return;/,
  );
});

test("pending structured collaboration never renders or edits from an empty collaborator", async () => {
  const source = await readFile("src/pages/workbench/backend-workbench.ts", "utf8");
  const normalizedContentBlock = /const normalizedContentForDoc = \(doc: WorkspaceDoc\): WorkspaceDocContent \| null => \{([\s\S]*?)\n    \};/.exec(source)?.[1] ?? "";
  const loadingBlock = /const shouldRenderStructuredLoading = \(doc: WorkspaceDoc\): boolean => \{([\s\S]*?)\n    \};/.exec(source)?.[1] ?? "";

  assert.equal(
    normalizedContentBlock.match(/collaborator && collaborationReadyDocIds\.has\(doc\.id\)/g)?.length,
    2,
    "table and board may use CRDT content only after the canonical lineage is ready",
  );
  assert.doesNotMatch(normalizedContentBlock, /collaborator\?\.getContent\(\)/);
  assert.doesNotMatch(loadingBlock, /collaborativeStructuredDocs\.has\(doc\.id\)/);
  assert.match(loadingBlock, /collaborationReadyDocIds\.has\(doc\.id\)/);
  assert.equal(
    source.match(/if \(!collaborationReadyDocIds\.has\(doc\.id\)\) \{[\s\S]{0,700}?commitLocalEdit\(doc\.id, \{ content: nextContent \}\);[\s\S]{0,700}?return nextContent;/g)?.length,
    2,
    "table and board edits must stay based on the hydrated body while realtime joins",
  );
  assert.match(source, /if \(structuredCollaborator && active\.id === doc\.id\) \{[\s\S]*?renderAll\(\);/);
});

test("authoritative structured refreshes detach stale Yjs state before the next edit", async () => {
  const source = await readFile("src/pages/workbench/backend-workbench.ts", "utf8");
  const invalidateBlock = /const invalidateStaleStructuredCollaborator = \([\s\S]*?\n    \};/.exec(source)?.[0] ?? "";

  assert.match(invalidateBlock, /syncValuesEqual\(collaborator\.getContent\(\), normalizedAuthoritative\)/);
  assert.match(invalidateBlock, /stopActiveCollaborativeTransport\(\)/);
  assert.match(invalidateBlock, /removeCollaborativeSnapshot/);
  assert.match(invalidateBlock, /resetStructuredCollaborator\(doc\)/);
  assert.match(source, /shouldReloadStructured[\s\S]{0,900}?invalidateStaleStructuredCollaborator\(summary, full\.content\)/);
  assert.match(source, /const previousTreeRevisionByItem = new Map/);
  assert.match(source, /treeRevisionAdvanced \|\| !hydratedDocIds\.has\(summary\.id\)/);
  assert.match(source, /needsRemoteLoad[\s\S]{0,600}?invalidateStaleStructuredCollaborator\(doc, full\.content\)/);
  assert.equal(
    source.match(/if \(!syncValuesEqual\(collaborator\.getContent\(\), viewBaseContent\)\) \{/g)?.length,
    2,
    "table and board must reject a rendered body backed by a stale collaborator",
  );
});
