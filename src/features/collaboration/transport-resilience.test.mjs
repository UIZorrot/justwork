import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "../workspace/test-module-loader.mjs";

test("safe collaborative send triggers reconnect instead of throwing when transport is closed", async () => {
  const mod = await loadTranspiledModule("src/features/collaboration/transport-resilience.ts");
  let rejoinCount = 0;
  let sendCount = 0;
  mod.safeSendCollaborativeUpdate(
    mod.TRANSPORT_CLOSED,
    () => {
      sendCount += 1;
    },
    () => {
      rejoinCount += 1;
    },
  );
  assert.equal(sendCount, 0);
  assert.equal(rejoinCount, 1);
});

test("safe collaborative send passes through when transport is open", async () => {
  const mod = await loadTranspiledModule("src/features/collaboration/transport-resilience.ts");
  let rejoinCount = 0;
  let sendCount = 0;
  mod.safeSendCollaborativeUpdate(
    mod.TRANSPORT_OPEN,
    () => {
      sendCount += 1;
    },
    () => {
      rejoinCount += 1;
    },
  );
  assert.equal(sendCount, 1);
  assert.equal(rejoinCount, 0);
});
