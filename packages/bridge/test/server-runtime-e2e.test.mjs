import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startBridgeServer } from "../dist/index.js";

async function requestJson(baseUrl, pathname, init = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  return { status: res.status, ok: res.ok, body };
}

test("bridge schema endpoint includes workspace runtime ops", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "justwork-bridge-schema-"));
  const server = await startBridgeServer({ port: 0, dataDir });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const schemaRes = await requestJson(baseUrl, "/v1/schema");
    assert.equal(schemaRes.status, 200);
    const opNames = schemaRes.body.operations.map((op) => op.name);
    for (const required of [
      "identity.current",
      "workspace.create",
      "workspace.status",
      "workspace.unlock",
      "workspace.lock",
      "workspace.tree.get",
      "workspace.item.get",
      "workspace.item.set",
    ]) {
      assert.equal(opNames.includes(required), true, `missing op ${required}`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("bridge persists legacy state files and runtime storage in one data dir", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "justwork-bridge-runtime-"));
  const server = await startBridgeServer({ port: 0, dataDir });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const putRes = await requestJson(baseUrl, "/v1/document", {
      method: "PUT",
      body: JSON.stringify({ markdown: "# bridge doc" }),
    });
    assert.equal(putRes.status, 200);

    const createRes = await requestJson(baseUrl, "/v1/agent/invoke", {
      method: "POST",
      body: JSON.stringify({
        op: "workspace.create",
        args: { password: "runtime-password", title: "Runtime Doc" },
      }),
    });
    assert.equal(createRes.status, 200);
    assert.equal(createRes.body.ok, true);
    assert.match(createRes.body.result.workspaceId, /^workspace_/);

    const markdown = await readFile(path.join(dataDir, "document.md"), "utf8");
    const state = JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8"));
    const runtime = JSON.parse(await readFile(path.join(dataDir, "runtime-storage.json"), "utf8"));

    assert.equal(markdown, "# bridge doc");
    assert.equal(typeof state.revision, "number");
    assert.equal(typeof runtime["justwork.workspace.meta.v1"].workspaceId, "string");
    assert.equal(typeof runtime["justwork.workspace.payload.v1"].payload?.ciphertext, "string");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
