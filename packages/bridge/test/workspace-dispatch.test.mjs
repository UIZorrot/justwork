import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryStorage } from "@justwork/workspace-runtime";
import { dispatchInvoke } from "../dist/dispatch.js";
import { emptyState } from "../dist/state.js";

function makeContext() {
  return {
    state: emptyState(),
    runtimeStorage: createMemoryStorage(),
    workspaceSession: undefined,
    workspacePassword: undefined,
    bump() {
      this.state.revision += 1;
      this.state.updatedAt = new Date().toISOString();
    },
  };
}

test("third-party Agent can create, unlock, read, and modify encrypted workspace through ops", async () => {
  const ctx = makeContext();

  const identity = await dispatchInvoke(ctx, { op: "identity.current", args: {} });
  assert.match(identity.userId, /^user_[A-Za-z0-9_-]{43}$/);

  const created = await dispatchInvoke(ctx, {
    op: "workspace.create",
    args: { password: "agent-password", title: "Agent Workspace" },
  });
  assert.match(created.workspaceId, /^workspace_/);
  assert.equal(created.locked, false);

  await dispatchInvoke(ctx, { op: "workspace.lock", args: { workspaceId: created.workspaceId } });
  await assert.rejects(
    () => dispatchInvoke(ctx, { op: "workspace.tree.get", args: { workspaceId: created.workspaceId } }),
    /workspace locked/,
  );

  await assert.rejects(
    () => dispatchInvoke(ctx, {
      op: "workspace.unlock",
      args: { workspaceId: created.workspaceId, password: "wrong-password" },
    }),
    /invalid workspace password/,
  );

  const unlocked = await dispatchInvoke(ctx, {
    op: "workspace.unlock",
    args: { workspaceId: created.workspaceId, password: "agent-password" },
  });
  assert.equal(unlocked.locked, false);

  const tree = await dispatchInvoke(ctx, {
    op: "workspace.tree.get",
    args: { workspaceId: created.workspaceId },
  });
  const firstPage = tree.items.find((item) => item.kind === "page");
  assert.ok(firstPage);

  const updated = await dispatchInvoke(ctx, {
    op: "workspace.item.set",
    args: {
      workspaceId: created.workspaceId,
      id: firstPage.id,
      title: "Agent Edited",
      markdown: "# Updated by external Agent",
    },
  });
  assert.equal(updated.item.title, "Agent Edited");

  const item = await dispatchInvoke(ctx, {
    op: "workspace.item.get",
    args: { workspaceId: created.workspaceId, id: firstPage.id },
  });
  assert.equal(item.item.markdown, "# Updated by external Agent");
});
