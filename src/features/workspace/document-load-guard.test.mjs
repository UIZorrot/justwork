import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workbenchPath = new URL("../../pages/workbench/backend-workbench.ts", import.meta.url);
const stylesPath = new URL("../../pages/workbench/workbench.css", import.meta.url);
const i18nPath = new URL("../../shared/i18n.ts", import.meta.url);

test("failed document hydration blocks editing behind a persistent recovery guard", async () => {
  const source = await readFile(workbenchPath, "utf8");

  assert.match(source, /documentLoadGuard\.setAttribute\("role", "alertdialog"\)/);
  assert.match(source, /documentLoadRefreshBtn\.addEventListener\("click", \(\) => window\.location\.reload\(\)\)/);
  assert.match(source, /documentLoadForceBtn\.addEventListener\("click", \(\) => forceActiveDocumentEdit\?\.\(\)\)/);
  assert.match(source, /documentLoadFailedDocIds\.add\(docId\)/);
  assert.match(source, /markdownHost\.inert = guarded/);
  assert.match(source, /titleInput\.readOnly = guarded/);
  assert.match(source, /forceEditableDocIds\.add\(active\.id\)/);
  assert.match(source, /markDocumentLoadFailed\(doc\.id\)/);
});

test("document recovery guard blurs the unsafe body and has bilingual risk copy", async () => {
  const [styles, messages] = await Promise.all([
    readFile(stylesPath, "utf8"),
    readFile(i18nPath, "utf8"),
  ]);

  assert.match(styles, /\.doc-editor-host\.has-document-load-error \.doc-editor-surface[\s\S]*?filter: blur/);
  assert.match(styles, /\.document-load-guard[\s\S]*?position: absolute/);
  assert.match(messages, /"editor\.loadGuard\.refresh": "Refresh page"/);
  assert.match(messages, /"editor\.loadGuard\.forceEdit": "Force edit"/);
  assert.match(messages, /"editor\.loadGuard\.refresh": "刷新页面"/);
  assert.match(messages, /"editor\.loadGuard\.forceEdit": "强制编辑"/);
});
