import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

test("cooldown blocks repeated notifications in same doc for same user within 24h", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/inbox-cooldown.ts");
  const ledger = {};
  const first = mod.canCreateInboxNotification(ledger, {
    workspaceId: "ws_1",
    docId: "doc_1",
    userId: "user_a",
    now: "2026-05-21T10:00:00.000Z",
  });
  assert.equal(first, true);
  const nextLedger = mod.recordInboxNotification(ledger, {
    workspaceId: "ws_1",
    docId: "doc_1",
    userId: "user_a",
    notificationId: "notif_1",
    now: "2026-05-21T10:00:00.000Z",
  });
  const second = mod.canCreateInboxNotification(nextLedger, {
    workspaceId: "ws_1",
    docId: "doc_1",
    userId: "user_a",
    now: "2026-05-21T15:00:00.000Z",
  });
  assert.equal(second, false);
});

test("cooldown stays active for 24h even after visible notification is cleared", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/inbox-cooldown.ts");
  const recorded = mod.recordInboxNotification({}, {
    workspaceId: "ws_1",
    docId: "doc_1",
    userId: "user_a",
    notificationId: "notif_1",
    now: "2026-05-21T10:00:00.000Z",
  });
  const cleared = mod.clearActiveInboxNotification(recorded, {
    workspaceId: "ws_1",
    docId: "doc_1",
    userId: "user_a",
  });
  assert.equal(mod.canCreateInboxNotification(cleared, {
    workspaceId: "ws_1",
    docId: "doc_1",
    userId: "user_a",
    now: "2026-05-21T20:00:00.000Z",
  }), false);
  assert.equal(mod.canCreateInboxNotification(cleared, {
    workspaceId: "ws_1",
    docId: "doc_1",
    userId: "user_a",
    now: "2026-05-22T10:00:00.001Z",
  }), true);
});
