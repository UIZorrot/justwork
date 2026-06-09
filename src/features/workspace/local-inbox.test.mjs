import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "./test-module-loader.mjs";

function createStorage() {
  const data = new Map();
  return {
    async get(key) {
      const keys = Array.isArray(key) ? key : [key];
      const result = {};
      for (const item of keys) {
        if (data.has(item)) {
          result[item] = data.get(item);
        }
      }
      return result;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        data.set(key, value);
      }
    },
  };
}

test("local inbox notifications dedupe repeated mention hits by mention id", async () => {
  const mentions = await loadTranspiledModule("src/features/mentions/mention-token.ts");
  const mod = await loadTranspiledModule("src/features/workspace/local-inbox.ts");

  const first = mod.createMentionNotification({
    workspaceId: "ws_1",
    docId: "doc_1",
    docTitle: "Doc",
    targetUserId: "user_a",
    mentionId: "m_1",
    mentionText: "@Alice please review",
    createdAt: "2026-05-11T00:00:00.000Z",
  });
  const second = mod.createMentionNotification({
    workspaceId: "ws_1",
    docId: "doc_1",
    docTitle: "Doc",
    targetUserId: "user_a",
    mentionId: "m_1",
    mentionText: "@Alice please review",
    createdAt: "2026-05-11T00:00:01.000Z",
  });

  assert.equal(first.dedupeKey, second.dedupeKey);

  const markdown = [
    "hello",
    mentions.encodeMentionToken({ mentionId: "m_1", userId: "user_a", displayName: "Alice" }),
  ].join("\n");
  const notifications = mod.extractMentionNotifications({
    previousMarkdown: "",
    nextMarkdown: markdown,
    workspaceId: "ws_1",
    docId: "doc_1",
    docTitle: "Doc",
    recipientUserId: "user_a",
  });
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].mentionText, /@Alice/);
});

test("local inbox only reacts to structured mentions for the target user", async () => {
  const mentions = await loadTranspiledModule("src/features/mentions/mention-token.ts");
  const mod = await loadTranspiledModule("src/features/workspace/local-inbox.ts");

  const markdown = [
    mentions.encodeMentionToken({ mentionId: "m_1", userId: "user_a", displayName: "Alice" }),
    mentions.encodeMentionToken({ mentionId: "m_2", userId: "user_b", displayName: "Bob" }),
    "@Alice plain text should not count",
  ].join("\n");
  const notifications = mod.extractMentionNotifications({
    previousMarkdown: "",
    nextMarkdown: markdown,
    workspaceId: "ws_1",
    docId: "doc_1",
    docTitle: "Doc",
    recipientUserId: "user_a",
  });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].targetUserId, "user_a");
  assert.equal(notifications[0].mentionId, "m_1");
});

test("local inbox cooldown blocks repeated notifications for same doc and user within 24h", async () => {
  const mod = await loadTranspiledModule("src/features/workspace/local-inbox.ts");
  const storage = createStorage();

  const first = mod.createMentionNotification({
    workspaceId: "ws_1",
    docId: "doc_1",
    docTitle: "Doc",
    targetUserId: "user_a",
    mentionId: "m_1",
    mentionText: "@Alice",
    createdAt: "2026-05-21T10:00:00.000Z",
  });
  const second = mod.createMentionNotification({
    workspaceId: "ws_1",
    docId: "doc_1",
    docTitle: "Doc",
    targetUserId: "user_a",
    mentionId: "m_2",
    mentionText: "@Alice",
    createdAt: "2026-05-21T12:00:00.000Z",
  });

  const firstAppend = await mod.appendMentionNotificationsWithCooldown(storage, "ws_1", "user_a", [first], "2026-05-21T10:00:00.000Z");
  assert.equal(firstAppend.state.notifications.length, 1);

  const secondAppend = await mod.appendMentionNotificationsWithCooldown(storage, "ws_1", "user_a", [second], "2026-05-21T12:00:00.000Z");
  assert.equal(secondAppend.state.notifications.length, 1);
  assert.equal(secondAppend.added.length, 0);

  const dismissed = await mod.dismissLocalInboxNotification(storage, "ws_1", "user_a", first.id);
  assert.equal(dismissed.notifications.length, 0);

  const thirdAppend = await mod.appendMentionNotificationsWithCooldown(storage, "ws_1", "user_a", [second], "2026-05-21T18:00:00.000Z");
  assert.equal(thirdAppend.state.notifications.length, 0);

  const afterWindow = await mod.appendMentionNotificationsWithCooldown(storage, "ws_1", "user_a", [second], "2026-05-22T10:00:00.001Z");
  assert.equal(afterWindow.state.notifications.length, 1);
});
