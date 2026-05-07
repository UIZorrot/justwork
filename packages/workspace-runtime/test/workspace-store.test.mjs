import assert from "node:assert/strict";
import test from "node:test";

import {
  createEncryptedWorkspace,
  createMemoryStorage,
  lockWorkspace,
  loadOrCreateLocalIdentity,
  loadWorkspaceMeta,
  RUNTIME_STORAGE_KEYS,
  saveEncryptedWorkspaceState,
  unlockWorkspace,
} from "../dist/index.js";

const sampleWorkspace = {
  activeDocId: "doc_a",
  workspaceDescription: "private workspace",
  docs: [
    {
      id: "doc_a",
      title: "Private Roadmap",
      markdown: "# Secret",
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

test("creates encrypted workspace metadata and unlocks plaintext session", async () => {
  const storage = createMemoryStorage();
  const identity = await loadOrCreateLocalIdentity(storage);

  const created = await createEncryptedWorkspace(storage, {
    creator: identity,
    password: "workspace-password",
    plaintextState: sampleWorkspace,
  });
  const rawPayload = await storage.get(RUNTIME_STORAGE_KEYS.WORKSPACE_PAYLOAD);
  const rawMeta = await storage.get(RUNTIME_STORAGE_KEYS.WORKSPACE_META);

  assert.match(created.meta.workspaceId, /^workspace_[A-Za-z0-9_-]+$/);
  assert.equal(created.meta.creatorUserId, identity.userId);
  assert.deepEqual(created.meta.memberUserIds, [identity.userId]);
  assert.equal(rawMeta.workspaceId, created.meta.workspaceId);
  assert.equal(JSON.stringify(rawPayload).includes("Private Roadmap"), false);

  const session = await unlockWorkspace(storage, "workspace-password");
  assert.equal(session.locked, false);
  assert.deepEqual(session.state, sampleWorkspace);
});

test("rejects wrong workspace password and clears plaintext on lock", async () => {
  const storage = createMemoryStorage();
  const identity = await loadOrCreateLocalIdentity(storage);
  await createEncryptedWorkspace(storage, {
    creator: identity,
    password: "right-password",
    plaintextState: sampleWorkspace,
  });

  await assert.rejects(() => unlockWorkspace(storage, "wrong-password"), /invalid workspace password/);

  const session = await unlockWorkspace(storage, "right-password");
  lockWorkspace(session);

  assert.equal(session.locked, true);
  assert.equal(session.state, undefined);
});

test("saves updated workspace state back to encrypted storage", async () => {
  const storage = createMemoryStorage();
  const identity = await loadOrCreateLocalIdentity(storage);
  await createEncryptedWorkspace(storage, {
    creator: identity,
    password: "workspace-password",
    plaintextState: sampleWorkspace,
  });

  const nextState = {
    ...sampleWorkspace,
    docs: [{ ...sampleWorkspace.docs[0], title: "Updated Secret" }],
  };
  await saveEncryptedWorkspaceState(storage, {
    password: "workspace-password",
    state: nextState,
  });

  const meta = await loadWorkspaceMeta(storage);
  const rawPayload = await storage.get(RUNTIME_STORAGE_KEYS.WORKSPACE_PAYLOAD);
  const session = await unlockWorkspace(storage, "workspace-password");

  assert.equal(meta?.creatorUserId, identity.userId);
  assert.equal(JSON.stringify(rawPayload).includes("Updated Secret"), false);
  assert.equal(session.state.docs[0].title, "Updated Secret");
});
