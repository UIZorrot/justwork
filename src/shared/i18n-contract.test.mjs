import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const storageKeysPath = path.resolve("src/shared/storage-keys.ts");
const i18nPath = path.resolve("src/shared/i18n.ts");
const workbenchPath = path.resolve("src/pages/workbench/backend-workbench.ts");
const workbenchHtmlPath = path.resolve("src/pages/workbench/index.html");
const sidepanelPath = path.resolve("src/pages/sidepanel/main.ts");
const INTENTIONALLY_SHARED_MESSAGES = new Set([
  "app.title",
  "app.workbench.brand",
  "app.workbench.language.en",
  "app.workbench.language.zh",
  "gate.setup.kicker",
]);
const ENGLISH_MESSAGES_ALLOWED_TO_CONTAIN_HAN = new Set(["app.workbench.language.zh"]);

function unwrapExpression(node) {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function readStringObject(node) {
  const object = unwrapExpression(node);
  assert.ok(ts.isObjectLiteralExpression(object), "i18n catalog must be an object literal");

  const entries = new Map();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = property.name;
    const value = unwrapExpression(property.initializer);
    if (
      !(ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) ||
      !(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
    ) {
      continue;
    }
    assert.ok(!entries.has(key.text), `duplicate i18n key: ${key.text}`);
    assert.ok(value.text.trim().length > 0, `empty i18n message: ${key.text}`);
    entries.set(key.text, value.text);
  }
  return entries;
}

function extractCatalogs(source) {
  const sourceFile = ts.createSourceFile(i18nPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let catalogs = null;

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "MESSAGES" && node.initializer) {
      const root = unwrapExpression(node.initializer);
      assert.ok(ts.isObjectLiteralExpression(root), "MESSAGES must be an object literal");
      catalogs = new Map();
      for (const property of root.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const locale = property.name;
        if (!(ts.isIdentifier(locale) || ts.isStringLiteral(locale))) continue;
        catalogs.set(locale.text, readStringObject(property.initializer));
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(catalogs, "MESSAGES catalog was not found");
  return catalogs;
}

function placeholders(message) {
  return [...message.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
}

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(fullPath)));
    } else if (/\.(?:html|ts)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectLiteralReferences(source, extension) {
  const keys = new Set();
  if (extension === ".html") {
    for (const match of source.matchAll(/data-i18n(?:-html|-placeholder|-title|-aria-label)?=["']([^"']+)["']/g)) {
      keys.add(match[1]);
    }
  } else {
    for (const match of source.matchAll(/\b(?:i18n\.)?t\(\s*["']([^"']+)["']/g)) {
      keys.add(match[1]);
    }
  }
  return keys;
}

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

test("Chinese workbench labels use current product wording", async () => {
  const i18n = await readFile(i18nPath, "utf8");

  assert.match(i18n, /"drawer\.profile\.title": "项目设置"/);
  assert.match(i18n, /"status\.locked": "退出当前项目"/);
  assert.match(i18n, /"sidebar\.newTable": "新建表格"/);
  assert.match(i18n, /"sidebar\.newBoard": "新建看板"/);
  assert.match(i18n, /"drawer\.message\.markAllRead": "全部标为已读"/);
});

test("all locales have identical keys and interpolation parameters", async () => {
  const source = await readFile(i18nPath, "utf8");
  const catalogs = extractCatalogs(source);
  const english = catalogs.get("en");
  const chinese = catalogs.get("zh-CN");
  assert.ok(english);
  assert.ok(chinese);

  assert.deepEqual([...chinese.keys()].sort(), [...english.keys()].sort());
  for (const [key, englishMessage] of english) {
    assert.deepEqual(
      placeholders(chinese.get(key)),
      placeholders(englishMessage),
      `interpolation parameters differ for ${key}`,
    );
  }
  const unexpectedlyUntranslated = [...english]
    .filter(([key, message]) => chinese.get(key) === message && !INTENTIONALLY_SHARED_MESSAGES.has(key))
    .map(([key]) => key);
  assert.deepEqual(unexpectedlyUntranslated, []);
  const unexpectedHanInEnglish = [...english]
    .filter(([key, message]) => /\p{Script=Han}/u.test(message) && !ENGLISH_MESSAGES_ALLOWED_TO_CONTAIN_HAN.has(key))
    .map(([key]) => key);
  assert.deepEqual(unexpectedHanInEnglish, []);
});

test("literal i18n references in frontend sources exist in the catalog", async () => {
  const source = await readFile(i18nPath, "utf8");
  const english = extractCatalogs(source).get("en");
  assert.ok(english);

  const missing = [];
  for (const file of await listSourceFiles(path.resolve("src"))) {
    const fileSource = await readFile(file, "utf8");
    for (const key of collectLiteralReferences(fileSource, path.extname(file))) {
      if (!english.has(key)) missing.push(`${path.relative(process.cwd(), file)}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});
