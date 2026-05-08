import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("markdown collaborator module exports the collaboration contract", async () => {
  const source = await readFile("src/features/collaboration/yjs-markdown.ts", "utf8");
  assert.match(source, /createMarkdownCollaborator/);
  assert.match(source, /applyLocalMarkdown/);
  assert.match(source, /applyRemoteUpdate/);
  assert.match(source, /encodeUpdate/);
  assert.match(source, /Y\.Text/);
});
