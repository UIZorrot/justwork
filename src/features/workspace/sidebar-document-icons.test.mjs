import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("workbench sidebar shows an icon for document pages", async () => {
  const workbench = await readFile(path.resolve("src/pages/workbench/backend-workbench.ts"), "utf8");
  const iconFunction = /function displayDocIcon\(doc: WorkspaceDoc\): string \{([\s\S]*?)\n\}/.exec(workbench)?.[1] ?? "";

  assert.notEqual(iconFunction, "", "expected displayDocIcon to exist");
  assert.equal(iconFunction.includes('return "";'), false, "page documents should render a non-empty icon");
  assert.match(iconFunction, /return "\\uD83D\\uDCC4";/, "page documents should use the document icon");
});
