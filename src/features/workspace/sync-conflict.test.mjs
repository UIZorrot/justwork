import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

test("sync conflict retry compares local and remote update times", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/sync-conflict.ts");

  assert.equal(
    mod.shouldRetryLocalPatchAfterConflict("2026-06-21T10:00:01.000Z", "2026-06-21T10:00:00.000Z"),
    true,
  );
  assert.equal(
    mod.shouldRetryLocalPatchAfterConflict("2026-06-21T10:00:00.000Z", "2026-06-21T10:00:00.000Z"),
    true,
  );
  assert.equal(
    mod.shouldRetryLocalPatchAfterConflict("2026-06-21T09:59:59.000Z", "2026-06-21T10:00:00.000Z"),
    false,
  );
});

test("sync conflict retry rebases the local patch onto the latest remote revision", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/sync-conflict.ts");

  assert.deepEqual(
    mod.buildLocalFirstConflictRetryPatch({ title: "Local title", markdown: "Local body" }, 8),
    { title: "Local title", markdown: "Local body", expectedRevision: 8 },
  );
});
