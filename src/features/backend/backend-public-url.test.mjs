import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const PUBLIC_BACKEND_URL = "https://api.tool.justwork.txzy.net";

test("extension defaults and host permissions target the public backend", async () => {
  const config = await readFile(path.resolve("src/shared/backend-config.ts"), "utf8");
  const manifest = await readFile(path.resolve("src/manifest.ts"), "utf8");

  assert.match(config, new RegExp(`DEFAULT_BACKEND_URL = "${PUBLIC_BACKEND_URL}"`));
  assert.match(manifest, new RegExp(`"${PUBLIC_BACKEND_URL}/\\*"`));
});
