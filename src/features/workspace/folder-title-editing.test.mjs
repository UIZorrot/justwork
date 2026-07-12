import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("folder title uses the editable title input path", async () => {
  const source = await readFile("src/pages/workbench/backend-workbench.ts", "utf8");

  assert.doesNotMatch(
    source,
    /active\.kind === "welcome" \|\| active\.id === ROOT_FOLDER_ID \|\| active\.kind === "folder"/,
    "folder documents must not be grouped with protected readonly titles",
  );
  assert.doesNotMatch(
    source,
    /active\.kind === "welcome" \|\| active\.id === ROOT_FOLDER_ID \|\| active\.kind === "folder"\) return/,
    "folder title input events must be allowed to schedule title saves",
  );
});
