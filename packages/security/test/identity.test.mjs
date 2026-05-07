import assert from "node:assert/strict";
import test from "node:test";

import {
  generateIdentity,
  signPayload,
  verifyPayloadSignature,
} from "../dist/index.js";

test("generates a public user id without a registration flow", async () => {
  const identity = await generateIdentity();

  assert.match(identity.userId, /^user_[A-Za-z0-9_-]{43}$/);
  assert.equal(identity.publicKeyJwk.kty, "EC");
  assert.equal(typeof identity.privateKeyJwk.d, "string");
});

test("verifies signatures and rejects tampered payloads", async () => {
  const identity = await generateIdentity();
  const signature = await signPayload(identity.privateKeyJwk, {
    op: "workspace.item.set",
    workspaceId: "workspace_a",
    targetId: "doc_a",
    bodyHash: "hash_a",
    nonce: "nonce_a",
    timestamp: "2026-05-06T00:00:00.000Z",
  });

  assert.equal(
    await verifyPayloadSignature(identity.publicKeyJwk, signature.payload, signature.signature),
    true,
  );
  assert.equal(
    await verifyPayloadSignature(
      identity.publicKeyJwk,
      { ...signature.payload, targetId: "doc_b" },
      signature.signature,
    ),
    false,
  );
});
