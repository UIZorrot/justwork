import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const storageKeysPath = path.resolve("src/shared/storage-keys.ts");
const i18nPath = path.resolve("src/shared/i18n.ts");
const workbenchPath = path.resolve("src/pages/workbench/backend-workbench.ts");
const workbenchHtmlPath = path.resolve("src/pages/workbench/index.html");
const sidepanelPath = path.resolve("src/pages/sidepanel/main.ts");

test("shared i18n contract exists for locale detection, persistence, and page wiring", async () => {
  const storageKeys = await readFile(storageKeysPath, "utf8");
  const i18n = await readFile(i18nPath, "utf8");
  const workbench = await readFile(workbenchPath, "utf8");
  const workbenchHtml = await readFile(workbenchHtmlPath, "utf8");
  const sidepanel = await readFile(sidepanelPath, "utf8");

  assert.match(storageKeys, /UI_LOCALE/);
  assert.match(i18n, /SUPPORTED_LOCALES/);
  assert.match(i18n, /DEFAULT_LOCALE/);
  assert.match(i18n, /doc\.welcome/);
  assert.match(i18n, /doc\.root/);
  assert.match(i18n, /editor\.untitledFolder/);
  assert.match(i18n, /resolvePreferredLocale/);
  assert.match(i18n, /loadPreferredLocale/);
  assert.match(i18n, /savePreferredLocale/);
  assert.match(i18n, /createTranslator/);
  assert.match(i18n, /detectBrowserLocale/);
  assert.match(workbench, /createTranslator/);
  assert.match(workbenchHtml, /language-switcher/);
  assert.match(workbenchHtml, /language-switcher-menu/);
  assert.match(sidepanel, /createTranslator/);
});
