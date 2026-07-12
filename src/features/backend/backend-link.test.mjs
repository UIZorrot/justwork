import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "../workspace/test-module-loader.mjs";

test("backend link warmup retries a transient first connection failure", async () => {
  const mod = await loadTranspiledModule("src/features/backend/link-open.ts");
  const calls = [];

  await mod.warmBackendLink("https://api.example.test/agent/SKILL.md", {
    attempts: 2,
    delayMs: 0,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) throw new TypeError("Connection error");
      return new Response("ok", { status: 200 });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.example.test/agent/SKILL.md");
  assert.equal(calls[0].init.cache, "no-store");
});

test("backend link warmup fails after all attempts are exhausted", async () => {
  const mod = await loadTranspiledModule("src/features/backend/link-open.ts");

  await assert.rejects(
    () => mod.warmBackendLink("https://api.example.test/agent/SKILL.md", {
      attempts: 2,
      delayMs: 0,
      fetcher: async () => {
        throw new TypeError("Connection error");
      },
    }),
    /Connection error/,
  );
});
