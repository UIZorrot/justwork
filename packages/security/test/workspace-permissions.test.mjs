import assert from "node:assert/strict";
import test from "node:test";

import {
  canDeleteWorkspace,
  canModifyWorkspacePassword,
  canWriteWorkspace,
} from "../dist/index.js";

const workspace = {
  workspaceId: "workspace_a",
  creatorUserId: "user_creator",
  memberUserIds: ["user_creator", "user_member"],
};

test("allows every member to write workspace content", () => {
  assert.equal(canWriteWorkspace(workspace, "user_creator"), true);
  assert.equal(canWriteWorkspace(workspace, "user_member"), true);
  assert.equal(canWriteWorkspace(workspace, "user_outside"), false);
});

test("limits password changes and deletion to the creator", () => {
  assert.equal(canModifyWorkspacePassword(workspace, "user_creator"), true);
  assert.equal(canModifyWorkspacePassword(workspace, "user_member"), false);
  assert.equal(canDeleteWorkspace(workspace, "user_creator"), true);
  assert.equal(canDeleteWorkspace(workspace, "user_member"), false);
});
