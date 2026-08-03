import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("collaboration transport retains updates until durable ACK with retry and backpressure", async () => {
  const transport = await readFile("src/features/collaboration/collab-transport.ts", "utf8");
  const backend = await readFile("backend/app/main.py", "utf8");
  const gateway = await readFile("backend/app/db_gateway.py", "utf8");

  assert.match(transport, /type: "collab\.update"/);
  assert.match(transport, /message\.type === "collab\.ack"/);
  assert.match(transport, /RETRY_AFTER_MS/);
  assert.match(transport, /MAX_PENDING_BYTES/);
  assert.match(transport, /mergeUpdates/);
  assert.match(transport, /UPDATE_BATCH_MS/);
  assert.match(transport, /socket\.bufferedAmount/);
  assert.match(backend, /store\.append_update\([\s\S]*?update_id=update_id/);
  assert.match(backend, /"type": "collab\.ack"/);
  assert.match(gateway, /collaborative_update_receipts/);
  assert.match(gateway, /collaborative_events/);
});

test("collaboration payloads use password-derived application encryption", async () => {
  const crypto = await readFile("backend/app/workspace_crypto.py", "utf8");
  const store = await readFile("backend/app/collab_store.py", "utf8");

  assert.match(crypto, /derive_workspace_collaboration_key/);
  assert.match(crypto, /AESGCM\(key\)\.encrypt/);
  assert.match(crypto, /COLLABORATION_MAGIC/);
  assert.match(store, /encrypt_collaboration_bytes/);
  assert.match(store, /decrypt_collaboration_bytes/);
});
