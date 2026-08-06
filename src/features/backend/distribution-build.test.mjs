import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("web and extension distributions have independent build outputs", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const webConfig = await readFile("vite.web.config.ts", "utf8");
  const extensionConfig = await readFile("vite.config.ts", "utf8");
  const releaseEnv = await readFile(".env.release", "utf8");

  assert.match(pkg.scripts["build:extension"], /sanitize-chrome-store-dist/);
  assert.match(pkg.scripts["build:extension"], /--mode release/);
  assert.match(pkg.scripts["build:web"], /vite\.web\.config\.ts/);
  assert.match(pkg.scripts["build:web"], /--mode release/);
  assert.match(pkg.scripts["build:local:extension"], /vite\.js build/);
  assert.doesNotMatch(pkg.scripts["build:local:extension"], /--mode release/);
  assert.match(pkg.scripts.build, /build:extension.*build:web/);
  assert.match(releaseEnv, /VITE_JUSTWORK_BACKEND_URL=https:\/\/api\.tool\.justwork\.txzy\.net/);
  assert.match(webConfig, /dist-web/);
  assert.match(webConfig, /envDir: rootDir/);
  assert.doesNotMatch(webConfig, /crx\(/);
  assert.match(extensionConfig, /crx\(\{ manifest \}\)/);
});
