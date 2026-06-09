import assert from "node:assert/strict";
import test from "node:test";
import { loadTranspiledModule } from "../workspace/test-module-loader.mjs";

test("mention token round-trips user identity and label", async () => {
  const mod = await loadTranspiledModule("src/features/mentions/mention-token.ts");
  const token = mod.encodeMentionToken({
    mentionId: "m_123",
    userId: "user_abc",
    displayName: "Alice",
  });
  const parsed = mod.decodeMentionToken(token);
  assert.deepEqual(parsed, {
    mentionId: "m_123",
    displayName: "Alice",
    userRef: mod.createMentionUserRef("user_abc"),
  });
});

test("mention token extraction finds only structured workspace mentions", async () => {
  const mod = await loadTranspiledModule("src/features/mentions/mention-token.ts");
  const markdown = [
    "hello",
    mod.encodeMentionToken({ mentionId: "m_1", userId: "user_a", displayName: "Alice" }),
    "@plainText should not count",
  ].join("\n");
  const mentions = mod.extractMentionTokens(markdown);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].userRef, mod.createMentionUserRef("user_a"));
});

test("mention token match extraction retains raw markdown and index", async () => {
  const mod = await loadTranspiledModule("src/features/mentions/mention-token.ts");
  const token = mod.encodeMentionToken({
    mentionId: "m_2",
    userId: "user_b",
    displayName: "Bob",
  });
  const markdown = `before ${token} after`;
  const [match] = mod.extractMentionTokenMatches(markdown);
  assert.equal(match.mentionId, "m_2");
  assert.equal(match.raw, token);
  assert.equal(match.index, 7);
  assert.equal(mod.replaceMentionTokensWithLabels(markdown), "before @Bob after");
  assert.equal(mod.extractMentionSnippet(markdown, "m_2"), "before @Bob after");
});

test("legacy json mention token still decodes for backward compatibility", async () => {
  const mod = await loadTranspiledModule("src/features/mentions/mention-token.ts");
  const legacyPayload = encodeURIComponent(JSON.stringify({
    mentionId: "m_legacy",
    userId: "user_legacy",
    displayName: "Legacy",
  }));
  const parsed = mod.decodeMentionToken(`[@Legacy](justwork-mention:${legacyPayload})`);
  assert.deepEqual(parsed, {
    mentionId: "m_legacy",
    userId: "user_legacy",
    displayName: "Legacy",
    userRef: mod.createMentionUserRef("user_legacy"),
  });
});
