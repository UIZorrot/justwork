import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("backend runtime forwards sync metadata to backend write requests", async () => {
  const source = await readFile("src/features/workspace/backend-runtime.ts", "utf8");

  assert.match(source, /client_mutation_id:\s*patch\.mutationId\s*\?\?\s*null/);
  assert.match(source, /client_mutation_id:\s*clientMutationId\s*\?\?\s*null/);
  assert.match(source, /expected_revision:\s*expectedRevision/);
  assert.doesNotMatch(source, /expected_revision:\s*(?:patch\.)?expectedRevision\s*\?\?\s*null/);
  assert.match(source, /collaborative_update:\s*patch\.collaborativeUpdate\s*\?\?\s*null/);
});
