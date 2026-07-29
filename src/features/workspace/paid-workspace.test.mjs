import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync("src/pages/workbench/index.html", "utf8");
const workbench = fs.readFileSync("src/pages/workbench/backend-workbench.ts", "utf8");
const client = fs.readFileSync("src/features/backend/client.ts", "utf8");

test("home workspace creation exposes free and paid plans with optional database routing", () => {
  assert.match(html, /id="workspace-plan-free"/);
  assert.match(html, /id="workspace-plan-paid"/);
  assert.match(html, /4× storage/);
  assert.match(html, /1000 history records/);
  assert.match(html, /id="paid-workspace-database-url"/);
});

test("paid workspace waits for verified Checkout status before completion", () => {
  assert.match(workbench, /createPaidWorkspaceCheckout\(identity\.userId\)/);
  assert.match(workbench, /getPaidWorkspaceCheckoutStatus\(checkout\.checkout_session_id\)/);
  assert.match(workbench, /if \(checkoutStatus\.paid\)/);
  assert.match(workbench, /completePaidWorkspace\(/);
  assert.match(workbench, /custom_database_url:/);
});

test("backend client keeps paid creation separate from free workspace creation", () => {
  assert.match(client, /\/v1\/billing\/paid-workspace\/checkout/);
  assert.match(client, /\/v1\/workspaces\/paid\/complete/);
  assert.match(client, /custom_database_url\?: string \| null/);
});
