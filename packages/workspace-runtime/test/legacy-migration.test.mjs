import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemoryStorage,
  loadOrCreateLocalIdentity,
  migrateLegacyWorkspace,
  RUNTIME_STORAGE_KEYS,
  unlockWorkspace,
} from "../dist/index.js";

const legacyState = {
  activeDocId: "legacy_doc",
  workspaceDescription: "legacy plain workspace",
  docs: [
    {
      id: "legacy_doc",
      title: "Legacy Plaintext",
      markdown: "# Plain",
      revision: 0,
      updatedAt: "2026-05-06T00:00:00.000Z",
      lastVisitedAt: "2026-05-06T00:00:00.000Z",
      parentId: null,
      pinned: false,
      inTrash: false,
      kind: "page",
    },
  ],
};

test("migrates legacy plaintext workspace into encrypted payload and removes legacy key", async () => {
  const storage = createMemoryStorage({
    [RUNTIME_STORAGE_KEYS.LEGACY_DOCS]: legacyState,
  });
  const identity = await loadOrCreateLocalIdentity(storage);

  const result = await migrateLegacyWorkspace(storage, {
    creator: identity,
    password: "migration-password",
  });
  const legacyAfter = await storage.get(RUNTIME_STORAGE_KEYS.LEGACY_DOCS);
  const encrypted = await storage.get(RUNTIME_STORAGE_KEYS.WORKSPACE_PAYLOAD);
  const session = await unlockWorkspace(storage, "migration-password");

  assert.equal(result.migrated, true);
  assert.equal(legacyAfter, undefined);
  assert.equal(JSON.stringify(encrypted).includes("Legacy Plaintext"), false);
  assert.deepEqual(session.state, legacyState);
});

test("reports no migration when legacy plaintext does not exist", async () => {
  const storage = createMemoryStorage();
  const identity = await loadOrCreateLocalIdentity(storage);

  const result = await migrateLegacyWorkspace(storage, {
    creator: identity,
    password: "migration-password",
  });

  assert.equal(result.migrated, false);
});
