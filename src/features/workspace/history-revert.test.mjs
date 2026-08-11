import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

test("history revert retries transient failures with one idempotent operation", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/history-revert.ts");
  let attempts = 0;
  const delays = [];

  const result = await mod.runHistoryRevertWithRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("temporary gateway failure");
    return "reverted";
  }, {
    maxAttempts: 4,
    baseDelayMs: 10,
    shouldRetry: () => true,
    sleep: async (delay) => delays.push(delay),
  });

  assert.equal(result, "reverted");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("history revert does not retry permanent failures", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/history-revert.ts");
  let attempts = 0;

  await assert.rejects(() => mod.runHistoryRevertWithRetry(async () => {
    attempts += 1;
    throw new Error("permanent conflict");
  }, {
    shouldRetry: () => false,
    sleep: async () => undefined,
  }), /permanent conflict/);

  assert.equal(attempts, 1);
});
