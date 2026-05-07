import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemoryStorage,
  loadOrCreateLocalIdentity,
  RUNTIME_STORAGE_KEYS,
} from "../dist/index.js";

test("creates and persists a local identity without registration", async () => {
  const storage = createMemoryStorage();

  const first = await loadOrCreateLocalIdentity(storage);
  const second = await loadOrCreateLocalIdentity(storage);
  const raw = await storage.get(RUNTIME_STORAGE_KEYS.IDENTITY);

  assert.match(first.userId, /^user_[A-Za-z0-9_-]{43}$/);
  assert.equal(first.userId, second.userId);
  assert.equal(raw?.userId, first.userId);
  assert.equal(typeof first.privateKeyJwk.d, "string");
  assert.equal(typeof first.createdAt, "string");
});
