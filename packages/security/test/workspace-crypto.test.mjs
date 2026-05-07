import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptWorkspacePayload,
  encryptWorkspacePayload,
} from "../dist/index.js";

test("encrypts workspace content and verifies passwords through the justwork check block", async () => {
  const encrypted = await encryptWorkspacePayload({
    workspaceId: "workspace_a",
    plaintext: JSON.stringify({ title: "Secret Plan", markdown: "# Hidden" }),
    password: "correct horse battery staple",
  });

  assert.equal(JSON.stringify(encrypted).includes("Secret Plan"), false);
  assert.equal(JSON.stringify(encrypted).includes("correct horse"), false);
  assert.equal(typeof encrypted.check.ciphertext, "string");

  const decrypted = await decryptWorkspacePayload(encrypted, "correct horse battery staple");
  assert.deepEqual(JSON.parse(decrypted), { title: "Secret Plan", markdown: "# Hidden" });
});

test("rejects an incorrect workspace password before returning plaintext", async () => {
  const encrypted = await encryptWorkspacePayload({
    workspaceId: "workspace_a",
    plaintext: "private",
    password: "right-password",
  });

  await assert.rejects(
    () => decryptWorkspacePayload(encrypted, "wrong-password"),
    /invalid workspace password/,
  );
});
