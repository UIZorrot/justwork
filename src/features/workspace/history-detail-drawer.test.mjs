import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("history records open a separate detail drawer with before and after snapshots", async () => {
  const [html, source, css] = await Promise.all([
    readFile("src/pages/workbench/index.html", "utf8"),
    readFile("src/pages/workbench/backend-workbench.ts", "utf8"),
    readFile("src/pages/workbench/workbench.css", "utf8"),
  ]);

  assert.match(html, /id="history-detail-drawer-root"/);
  assert.match(html, /id="history-detail-before"/);
  assert.match(html, /id="history-detail-after"/);
  assert.match(html, /id="history-detail-diff"/);
  assert.match(html, /class="history-detail-technical"/);
  assert.match(source, /main\.addEventListener\("click", \(\) => openHistoryDetailDrawer\(ev, main\)\)/);
  assert.match(source, /historyDetailBefore\.textContent = formatHistorySnapshot\(event\.before\)/);
  assert.match(source, /historyDetailAfter\.textContent = formatHistorySnapshot\(event\.after\)/);
  assert.match(source, /renderHistoryDiff\(event\.before, event\.after\)/);
  assert.match(source, /mutationId: event\.mutation_id \|\| undefined/);
  assert.match(css, /\.history-detail-meta-row\[hidden\]\s*\{[^}]*display:\s*none/s);
  assert.match(source, /if \(historyDetailDrawerRoot\.classList\.contains\("is-open"\)\)/);
  assert.match(css, /\.history-detail-drawer-root\s*\{[^}]*z-index:\s*330/s);
  assert.match(css, /\.history-drawer-root\s*\{[^}]*z-index:\s*320/s);
  assert.match(css, /\.history-detail-diff-added\s*\{/);
  assert.match(css, /\.history-detail-diff-removed\s*\{/);
});

test("history detail values are assigned as text instead of HTML", async () => {
  const source = await readFile("src/pages/workbench/backend-workbench.ts", "utf8");
  const renderStart = source.indexOf("const renderHistoryDetail =");
  const renderEnd = source.indexOf("const closeHistoryDetailDrawer =", renderStart);
  const render = source.slice(renderStart, renderEnd);

  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  assert.doesNotMatch(render, /innerHTML/);
  assert.match(render, /historyDetailTitle\.textContent/);
  assert.match(render, /historyDetailActor\.textContent/);
  assert.match(render, /historyDetailTarget\.textContent/);
});
