import assert from "node:assert/strict";
import test from "node:test";

import { getAgentCatalogJson } from "../dist/index.js";

test("catalog exposes third-party Agent workspace runtime ops", () => {
  const catalog = getAgentCatalogJson();
  const names = catalog.operations.map((op) => op.name);

  for (const name of [
    "identity.current",
    "workspace.create",
    "workspace.status",
    "workspace.unlock",
    "workspace.lock",
    "workspace.tree.get",
    "workspace.item.get",
    "workspace.item.set",
  ]) {
    assert.equal(names.includes(name), true, `missing op ${name}`);
  }
});
