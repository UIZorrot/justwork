import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, createReadStream, openSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import * as Y from "yjs";

const distribution = process.env.JUSTWORK_E2E_DISTRIBUTION === "extension" ? "extension" : "web";
const distDir = path.resolve(distribution === "extension" ? "dist" : "dist-web");
const entryPath = distribution === "extension" ? "/src/pages/workbench/index.html" : "/";
const markerPrefix = distribution === "extension" ? "EXT" : "WEB";
const password = `${distribution}-e2e-password`;
const extendedSoak = process.env.JUSTWORK_E2E_EXTENDED === "1";
const soakMs = Math.max(15_000, Number.parseInt(process.env.JUSTWORK_E2E_SOAK_MS ?? "90000", 10) || 90_000);

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "application/octet-stream";
}

function startStaticServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const requested = path.normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
    const filePath = path.join(distDir, requested || "index.html");
    if (!filePath.startsWith(distDir)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error("not a file");
      res.writeHead(200, { "Content-Type": contentType(filePath) });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function waitForBackend(baseUrl) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/v1/health`);
      if (response.ok) return;
    } catch {
      // Keep polling while the child process starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`backend did not start at ${baseUrl}`);
}

function stopBackendProcess(backend, backendPort) {
  if (process.platform !== "win32") {
    backend.kill();
    return;
  }
  if (backend.pid) {
    spawnSync("taskkill", ["/PID", String(backend.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
  const portToken = `--port ${backendPort}`;
  const cleanup = [
    `$portToken = '${portToken}'`,
    "$processes = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -like '*uvicorn app.main:app*' -and $_.CommandLine -like \"*$portToken*\" }",
    "$processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join("; ");
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cleanup], {
    stdio: "ignore",
    windowsHide: true,
  });
}

async function continueNicknamePrompt(page, nickname) {
  const prompt = page.locator("#workspace-nickname-prompt-root.is-open");
  try {
    await prompt.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    return;
  }
  await page.fill("#workspace-nickname-prompt-input", nickname);
  await page.click("#workspace-nickname-prompt-save-btn");
}

async function editorFor(page) {
  const editor = page.locator('#editor-root .doc-editor-surface--markdown [contenteditable="true"]').first();
  await editor.waitFor({ state: "visible", timeout: 15_000 });
  return editor;
}

async function placeCaret(editor, atStart) {
  await editor.evaluate((element, start) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(start);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.focus();
  }, atStart);
}

async function typeAtEnd(page, editor, text) {
  await placeCaret(editor, false);
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
}

async function typeAtStart(page, editor, text) {
  await placeCaret(editor, true);
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

async function installDistributionRuntime(context, baseUrl, savedWorkspaceId) {
  if (distribution === "web") {
    if (savedWorkspaceId) {
      await context.addInitScript((workspaceId) => {
        localStorage.setItem("justwork.backend.lastWorkspaceId", JSON.stringify(workspaceId));
      }, savedWorkspaceId);
    }
    return;
  }
  await context.addInitScript(({ base, workspaceId }) => {
    if (workspaceId) {
      localStorage.setItem("justwork.backend.lastWorkspaceId", JSON.stringify(workspaceId));
    }
    const namesFor = (keys) => Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys ?? {});
    globalThis.chrome = {
      runtime: { getURL: (resource) => `${base}/${resource.replace(/^\/+/, "")}` },
      storage: {
        local: {
          async get(keys) {
            return Object.fromEntries(namesFor(keys).map((key) => {
              const raw = localStorage.getItem(key);
              return [key, raw === null ? (typeof keys === "object" && !Array.isArray(keys) ? keys[key] : undefined) : JSON.parse(raw)];
            }));
          },
          async set(values) {
            for (const [key, value] of Object.entries(values)) localStorage.setItem(key, JSON.stringify(value));
          },
          async remove(keys) {
            for (const key of namesFor(keys)) localStorage.removeItem(key);
          },
        },
      },
    };
  }, { base: baseUrl, workspaceId: savedWorkspaceId ?? null });
}

function count(text, marker) {
  return text.split(marker).length - 1;
}

const sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

async function main() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "justwork-web-e2e-"));
  const backendLogPath = path.join(dataDir, "backend.log");
  const backendLog = openSync(backendLogPath, "a");
  const backendPort = 17_000 + Math.floor(Math.random() * 800);
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const backend = spawn(
    "uv",
    ["run", "--project", ".", "python", "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(backendPort)],
    {
      cwd: path.resolve("backend"),
      env: {
        ...process.env,
        JUSTWORK_DATABASE_URL: "",
        JUSTWORK_BACKEND_DATA_FILE: path.join(dataDir, "workspaces.json"),
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["ignore", backendLog, backendLog],
      windowsHide: true,
    },
  );
  closeSync(backendLog);

  let staticServer;
  let browser;
  let browserB;
  try {
    await waitForBackend(backendUrl);
    staticServer = await startStaticServer();
    browser = await chromium.launch({ headless: true });
    const contextA = await browser.newContext();
    await installDistributionRuntime(contextA, staticServer.baseUrl);
    const pageA = await contextA.newPage();
    const itemSavesA = [];
    const itemSavesB = [];
    const observeItemSaves = (page, sink) => {
      page.on("request", (request) => {
        if (request.method() !== "PUT" || !/\/items\/[^/]+$/.test(new URL(request.url()).pathname)) return;
        try {
          sink.push({ ...request.postDataJSON(), __itemId: new URL(request.url()).pathname.split("/").at(-1) });
        } catch {
          // Diagnostics only.
        }
      });
    };
    observeItemSaves(pageA, itemSavesA);
    let delayFirstJoin = true;
    await pageA.route("**/collab/join", async (route) => {
      if (delayFirstJoin) {
        delayFirstJoin = false;
        await new Promise((resolve) => setTimeout(resolve, 2_500));
      }
      await route.continue();
    });
    await pageA.goto(`${staticServer.baseUrl}${entryPath}?backendUrl=${encodeURIComponent(backendUrl)}`);
    await pageA.waitForFunction(() => document.querySelector("#backend-health-status")?.getAttribute("data-status") === "online");
    if (!(await pageA.locator("#backend-title-setup-input").isVisible())) {
      await pageA.click("#create-workspace-btn");
      await pageA.locator("#backend-title-setup-input").waitFor({ state: "visible" });
    }
    await pageA.fill("#backend-title-setup-input", `${distribution} distribution E2E`);
    await pageA.fill("#setup-password-input", password);
    await pageA.click("#setup-workspace-btn");
    await continueNicknamePrompt(pageA, `${distribution} A`);
    await pageA.waitForSelector(".workspace-shell:not([hidden])");

    const workspaceId = await pageA.evaluate(() => {
      const raw = localStorage.getItem("justwork.backend.lastWorkspaceId");
      return raw ? JSON.parse(raw) : null;
    });
    assert.match(workspaceId, /^workspace_/);
    const apiJson = async (method, endpoint, body) => {
      const response = await fetch(`${backendUrl}${endpoint}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = await response.json();
      if (!response.ok) {
        const error = new Error(`${method} ${endpoint} failed: ${response.status} ${JSON.stringify(payload)}`);
        error.status = response.status;
        throw error;
      }
      return payload;
    };
    const loadTree = () => apiJson("POST", `/v1/workspaces/${workspaceId}/tree`, { password });
    const loadItem = (itemId) => apiJson("POST", `/v1/workspaces/${workspaceId}/items/${itemId}`, { password });
    const loadCollaborativeMarkdown = async (itemId) => {
      const state = await apiJson("POST", `/v1/workspaces/${workspaceId}/items/${itemId}/collab/state?protocol_version=2`, { password });
      const document = new Y.Doc();
      Y.applyUpdate(document, Buffer.from(state.snapshot_base64, "base64"));
      return document.getText("markdown").toString();
    };
    const loadRevisions = () => apiJson("POST", `/v1/workspaces/${workspaceId}/revisions`, { password });
    const loadQuota = () => apiJson("GET", `/v1/workspaces/${workspaceId}/quota`);
    const createRemoteItem = async (kind, title, parentId = "root") => {
      const mutationId = `${markerPrefix.toLowerCase()}-soak-${kind}-${title}`;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          return (await apiJson("POST", `/v1/workspaces/${workspaceId}/items`, {
            password,
            kind,
            title,
            parent_id: parentId,
            client_mutation_id: mutationId,
          })).item;
        } catch (error) {
          if (error.status !== 409 || attempt === 7) throw error;
          await sleep(60 * (attempt + 1));
        }
      }
      throw new Error("remote create retry exhausted");
    };
    const editorA = await editorFor(pageA);
    const bootstrapMarker = `${markerPrefix}_BOOTSTRAP_INPUT`;
    await typeAtEnd(pageA, editorA, bootstrapMarker);
    await pageA.waitForFunction(
      (marker) => document.querySelector("#editor-root .doc-editor-surface--markdown")?.textContent?.includes(marker),
      bootstrapMarker,
      { timeout: 2_000 },
    );
    for (let attempt = 0; attempt < 80; attempt += 1) {
      assert.equal(count((await editorA.textContent()) ?? "", bootstrapMarker), 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Independent browser processes model two real collaborators and avoid
    // browser-level focus stealing between simultaneous keyboard operations.
    browserB = await chromium.launch({ headless: true });
    const contextB = await browserB.newContext();
    await installDistributionRuntime(contextB, staticServer.baseUrl, workspaceId);
    const pageB = await contextB.newPage();
    observeItemSaves(pageB, itemSavesB);
    await pageB.goto(`${staticServer.baseUrl}${entryPath}?backendUrl=${encodeURIComponent(backendUrl)}`);
    await pageB.waitForFunction(() => document.querySelector("#backend-health-status")?.getAttribute("data-status") === "online");
    await pageB.waitForSelector("#workspace-unlock-panel:not([hidden])");
    await pageB.fill("#backend-workspace-id-input", workspaceId);
    await pageB.fill("#unlock-password-input", password);
    await pageB.click("#unlock-workspace-btn");
    await continueNicknamePrompt(pageB, `${distribution} B`);
    await pageB.waitForSelector(".workspace-shell:not([hidden])");
    const editorB = await editorFor(pageB);
    await pageB.waitForFunction(
      (marker) => document.querySelector("#editor-root .doc-editor-surface--markdown")?.textContent?.includes(marker),
      bootstrapMarker,
      { timeout: 15_000 },
    );

    const streamMarkers = Array.from({ length: 16 }, (_, index) => `${markerPrefix}_STREAM_${String(index).padStart(2, "0")}`);
    for (const marker of streamMarkers) {
      await typeAtEnd(pageA, editorA, marker);
      assert.equal(count((await editorA.textContent()) ?? "", marker), 1);
    }
    try {
      await pageB.waitForFunction(
        (markers) => markers.every((marker) => document.querySelector("#editor-root .doc-editor-surface--markdown")?.textContent?.includes(marker)),
        streamMarkers,
        { timeout: 20_000 },
      );
    } catch (error) {
      const [textA, textB, stored] = await Promise.all([
        editorA.textContent(),
        editorB.textContent(),
        loadItem("doc_a138cd666f9749088c4d1258e7c443df").catch(() => null),
      ]);
      const present = (text) => streamMarkers.map((marker) => count(text ?? "", marker));
      throw new Error(`stream convergence failed: A=${JSON.stringify(present(textA))} B=${JSON.stringify(present(textB))} stored=${JSON.stringify(present(stored?.item?.content?.markdown ?? stored?.item?.content ?? ""))}`, { cause: error });
    }

    await contextA.setOffline(true);
    const offlineMarker = `${markerPrefix}_OFFLINE_RECONNECT`;
    await typeAtEnd(pageA, editorA, offlineMarker);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      assert.equal(count((await editorA.textContent()) ?? "", offlineMarker), 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await contextA.setOffline(false);
    await pageB.waitForFunction(
      (marker) => document.querySelector("#editor-root .doc-editor-surface--markdown")?.textContent?.includes(marker),
      offlineMarker,
      { timeout: 25_000 },
    );

    await pageB.bringToFront();
    await pageA.bringToFront();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const visibleA = (await editorA.textContent()) ?? "";
    const visibleB = (await editorB.textContent()) ?? "";
    for (const marker of [bootstrapMarker, offlineMarker, ...streamMarkers]) {
      assert.equal(count(visibleA, marker), 1, `A must contain one ${marker}`);
      assert.equal(count(visibleB, marker), 1, `B must contain one ${marker}`);
    }

    const tree = await fetch(`${backendUrl}/v1/workspaces/${workspaceId}/tree`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).then((response) => response.json());
    const itemId = tree.items.find((item) => item.kind === "page").id;
    const persisted = await fetch(`${backendUrl}/v1/workspaces/${workspaceId}/items/${itemId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).then((response) => response.json());
    for (const marker of [bootstrapMarker, offlineMarker, ...streamMarkers]) {
      assert.equal(count(persisted.item.markdown, marker), 1, `backend must contain one ${marker}`);
    }

    if (extendedSoak) {
      console.error(`[sync-soak] ${distribution}: concurrent editing`);
      const startControlMarker = `${markerPrefix}-start-control`;
      await typeAtStart(pageB, editorB, startControlMarker);
      assert.equal(count((await editorB.textContent()) ?? "", startControlMarker), 1, "B start-position control input was not rendered locally");
      await pageA.waitForFunction(
        (marker) => (document.querySelector("#editor-root .doc-editor-surface--markdown")?.textContent ?? "").includes(marker),
        startControlMarker,
        { timeout: 15_000 },
      );
      const concurrentMarkers = Array.from({ length: 12 }, (_, index) => ({
        a: `${markerPrefix}-concurrent-A-${String(index).padStart(2, "0")}`,
        b: `${markerPrefix}-concurrent-B-${String(index).padStart(2, "0")}`,
      }));
      for (const pair of concurrentMarkers) {
        await Promise.all([
          typeAtEnd(pageA, editorA, pair.a),
          typeAtStart(pageB, editorB, pair.b),
        ]);
        const [localA, localB] = await Promise.all([editorA.textContent(), editorB.textContent()]);
        if (count(localA ?? "", pair.a) !== 1 || count(localB ?? "", pair.b) !== 1) {
          throw new Error(`concurrent local input disappeared before the keyboard operation settled: ${pair.a}=${count(localA ?? "", pair.a)} ${pair.b}=${count(localB ?? "", pair.b)}`);
        }
      }
      const concurrentFlat = concurrentMarkers.flatMap((pair) => [pair.a, pair.b]);
      try {
        await Promise.all([pageA, pageB].map((targetPage) => targetPage.waitForFunction(
          (markers) => markers.every((marker) => {
            const text = document.querySelector("#editor-root .doc-editor-surface--markdown")?.textContent ?? "";
            return text.split(marker).length - 1 === 1;
          }),
          concurrentFlat,
          { timeout: 30_000 },
        )));
      } catch (error) {
        const [textA, textB, backendItem, roomMarkdown] = await Promise.all([
          editorA.textContent({ timeout: 3_000 }).catch(() => "<unresponsive>"),
          editorB.textContent({ timeout: 3_000 }).catch(() => "<unresponsive>"),
          loadItem(itemId).then((payload) => payload.item.markdown).catch(() => "<unavailable>"),
          loadCollaborativeMarkdown(itemId).catch(() => "<unavailable>"),
        ]);
        const countsFor = (text) => Object.fromEntries(concurrentFlat.map((marker) => [marker, count(text ?? "", marker)]));
        const diagnostic = {
          uiA: countsFor(textA),
          uiB: countsFor(textB),
          backend: countsFor(backendItem),
          room: countsFor(roomMarkdown),
          savesA: itemSavesA.slice(-20).map((save) => ({ collaborative: Boolean(save.collaborative_update), counts: countsFor(save.markdown ?? "") })),
          savesB: itemSavesB.slice(-20).map((save) => ({ collaborative: Boolean(save.collaborative_update), counts: countsFor(save.markdown ?? "") })),
          lengths: { uiA: textA?.length, uiB: textB?.length, backend: backendItem?.length, room: roomMarkdown?.length },
        };
        console.error("[sync-soak] concurrent diagnostic", JSON.stringify(diagnostic));
        throw new Error(`concurrent convergence failed: ${JSON.stringify(diagnostic)}`, { cause: error });
      }

      console.error(`[sync-soak] ${distribution}: same-position character preservation`);
      const samePositionA = "甲";
      const samePositionB = "乙";
      const samePositionCount = 24;
      await Promise.all([
        placeCaret(editorA, false),
        placeCaret(editorB, false),
      ]);
      for (let index = 0; index < samePositionCount; index += 1) {
        await Promise.all([
          pageA.keyboard.insertText(samePositionA),
          pageB.keyboard.insertText(samePositionB),
        ]);
      }
      try {
        await Promise.all([pageA, pageB].map((targetPage) => targetPage.waitForFunction(
          ({ markerA, markerB, expected }) => {
            const text = document.querySelector("#editor-root .doc-editor-surface--markdown")?.textContent ?? "";
            return text.split(markerA).length - 1 === expected && text.split(markerB).length - 1 === expected;
          },
          { markerA: samePositionA, markerB: samePositionB, expected: samePositionCount },
          { timeout: 30_000 },
        )));
      } catch (error) {
        const [textA, textB, backendItem] = await Promise.all([
          editorA.textContent(),
          editorB.textContent(),
          loadItem(itemId).then((payload) => payload.item.markdown),
        ]);
        const diagnostic = {
          uiA: [count(textA ?? "", samePositionA), count(textA ?? "", samePositionB)],
          uiB: [count(textB ?? "", samePositionA), count(textB ?? "", samePositionB)],
          backend: [count(backendItem, samePositionA), count(backendItem, samePositionB)],
        };
        throw new Error(`same-position character preservation failed: ${JSON.stringify(diagnostic)}`, { cause: error });
      }
      const [samePositionTextA, samePositionTextB] = await Promise.all([editorA.textContent(), editorB.textContent()]);
      assert.equal(samePositionTextA, samePositionTextB, "same-position edits must converge in both clients");
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const backendMarkdown = (await loadItem(itemId)).item.markdown;
        if (count(backendMarkdown, samePositionA) === samePositionCount && count(backendMarkdown, samePositionB) === samePositionCount) break;
        if (attempt === 59) {
          assert.equal(count(backendMarkdown, samePositionA), samePositionCount, "backend must preserve all same-position A characters");
          assert.equal(count(backendMarkdown, samePositionB), samePositionCount, "backend must preserve all same-position B characters");
        }
        await sleep(100);
      }

      console.error(`[sync-soak] ${distribution}: active document stability under remote structure bursts`);
      const targetTitle = `${markerPrefix} Soak Active Target`;
      const targetItem = await createRemoteItem("page", targetTitle);
      const targetRowA = pageA.locator("#doc-tree .doc-list-item", { hasText: targetTitle }).first();
      await targetRowA.waitFor({ state: "visible", timeout: 20_000 });
      await targetRowA.click();
      await pageA.waitForFunction(
        (title) => document.querySelector("#doc-title-input")?.value === title,
        targetTitle,
        { timeout: 15_000 },
      );
      const targetEditorA = await editorFor(pageA);
      const targetMarker = `${markerPrefix}_ACTIVE_TARGET_CONTENT`;
      await typeAtEnd(pageA, targetEditorA, targetMarker);

      const waitForTargetPersistence = async () => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const item = (await loadItem(targetItem.id)).item;
          if (count(item.markdown, targetMarker) === 1) return item;
          await sleep(150);
        }
        const [roomMarkdown, editorText, busy] = await Promise.all([
          loadCollaborativeMarkdown(targetItem.id).catch(() => "<unavailable>"),
          targetEditorA.textContent(),
          pageA.locator("#editor-root").getAttribute("aria-busy").catch(() => null),
        ]);
        throw new Error(`target marker did not persist: ${JSON.stringify({
          ui: count(editorText ?? "", targetMarker),
          room: count(roomMarkdown, targetMarker),
          busy,
          saves: itemSavesA.filter((save) => save.__itemId === targetItem.id).map((save) => ({ collaborative: Boolean(save.collaborative_update), marker: count(save.markdown ?? "", targetMarker) })),
        })}`);
      };
      await waitForTargetPersistence();
      for (let index = 0; index < 16; index += 1) {
        const folder = await createRemoteItem("folder", `${markerPrefix} Remote Folder ${String(index).padStart(2, "0")}`);
        await createRemoteItem("page", `${markerPrefix} Remote Child ${String(index).padStart(2, "0")}`, folder.id);
        assert.equal(await pageA.locator("#doc-title-input").inputValue(), targetTitle, `active doc jumped at structure burst ${index}`);
        const markerCount = count((await targetEditorA.textContent()) ?? "", targetMarker);
        if (markerCount !== 1) {
          const [stored, room] = await Promise.all([
            loadItem(targetItem.id).then((payload) => payload.item.markdown),
            loadCollaborativeMarkdown(targetItem.id),
          ]);
          throw new Error(`target marker count became ${markerCount} at structure burst ${index}: ${JSON.stringify({ stored: count(stored, targetMarker), room: count(room, targetMarker) })}`);
        }
      }
      for (let attempt = 0; attempt < 120; attempt += 1) {
        assert.equal(await pageA.locator("#doc-title-input").inputValue(), targetTitle, `active doc jumped after ${attempt * 100}ms`);
        const markerCount = count((await targetEditorA.textContent()) ?? "", targetMarker);
        assert.equal(markerCount, 1, `target marker count became ${markerCount} after ${attempt * 100}ms`);
        await sleep(100);
      }
      assert.equal(await pageA.evaluate(() => {
        const activeElement = document.activeElement;
        return activeElement instanceof HTMLElement && activeElement.getAttribute("contenteditable") === "true";
      }), true, "remote tree refresh stole editor focus");

      console.error(`[sync-soak] ${distribution}: silent idle write amplification check (${soakMs}ms)`);
      await sleep(2_000);
      const idleBaselineItem = (await loadItem(targetItem.id)).item;
      const idleBaselineRevisions = (await loadRevisions()).revisions;
      const idleBaselineQuota = (await loadQuota()).quota;
      const decoy = await contextA.newPage();
      await decoy.goto("about:blank");
      const idleStartedAt = Date.now();
      let switchIndex = 0;
      while (Date.now() - idleStartedAt < soakMs) {
        if (switchIndex % 2 === 0) {
          await decoy.bringToFront();
        } else {
          await pageA.bringToFront();
          assert.equal(await pageA.locator("#doc-title-input").inputValue(), targetTitle);
          assert.equal(count((await targetEditorA.textContent()) ?? "", targetMarker), 1);
        }
        const currentItem = (await loadItem(targetItem.id)).item;
        assert.equal(currentItem.revision, idleBaselineItem.revision, "idle editor advanced document revision");
        assert.equal(currentItem.markdown, idleBaselineItem.markdown, "idle editor changed persisted markdown");
        switchIndex += 1;
        await sleep(Math.min(5_000, Math.max(0, soakMs - (Date.now() - idleStartedAt))));
      }
      await pageA.bringToFront();
      await decoy.close();
      const idleFinalItem = (await loadItem(targetItem.id)).item;
      const idleFinalRoomMarkdown = await loadCollaborativeMarkdown(targetItem.id);
      const idleFinalRevisions = (await loadRevisions()).revisions;
      const idleFinalQuota = (await loadQuota()).quota;
      assert.equal(idleFinalItem.revision, idleBaselineItem.revision);
      assert.equal(idleFinalItem.markdown, idleBaselineItem.markdown);
      assert.equal(count(idleFinalRoomMarkdown, targetMarker), 1, "collaborative room lost the target before lock");
      assert.equal(idleFinalRevisions.length, idleBaselineRevisions.length, "idle editor created history records");
      assert.equal(idleFinalQuota.used_bytes, idleBaselineQuota.used_bytes, "idle editor increased workspace storage");

      console.error(`[sync-soak] ${distribution}: lock/unlock and late join`);
      const saveIndexBeforeLock = itemSavesA.length;
      await pageA.click("#lock-workspace-btn");
      await pageA.waitForSelector("#workspace-unlock-panel:not([hidden])");
      const [postLockItem, postLockRoom] = await Promise.all([
        loadItem(targetItem.id).then((payload) => payload.item.markdown),
        loadCollaborativeMarkdown(targetItem.id),
      ]);
      assert.equal(count(postLockItem, targetMarker), 1, "locking erased the persisted item before unlock");
      assert.equal(count(postLockRoom, targetMarker), 1, "locking erased the collaborative room before unlock");
      await pageA.fill("#backend-workspace-id-input", workspaceId);
      await pageA.fill("#unlock-password-input", password);
      await pageA.click("#unlock-workspace-btn");
      await continueNicknamePrompt(pageA, `${distribution} A relock`);
      await pageA.waitForSelector(".workspace-shell:not([hidden])");
      console.error(`[sync-soak] ${distribution}: relocked client unlocked`);
      const restoredRowA = pageA.locator("#doc-tree .doc-list-item", { hasText: targetTitle }).first();
      await restoredRowA.click();
      console.error(`[sync-soak] ${distribution}: relocked client selected target`);
      await pageA.waitForFunction((title) => document.querySelector("#doc-title-input")?.value === title, targetTitle);
      console.error(`[sync-soak] ${distribution}: relocked client title restored`);
      const restoredEditorA = await editorFor(pageA);
      try {
        await pageA.waitForFunction(
          (marker) => (document.querySelector("#editor-root .doc-editor-surface--markdown")?.textContent ?? "").includes(marker),
          targetMarker,
          { timeout: 20_000 },
        );
      } catch (error) {
        const [stored, room, ui] = await Promise.all([
          loadItem(targetItem.id).then((payload) => payload.item.markdown),
          loadCollaborativeMarkdown(targetItem.id),
          restoredEditorA.textContent(),
        ]);
        throw new Error(`relocked client body did not restore: ${JSON.stringify({
          stored: count(stored, targetMarker),
          room: count(room, targetMarker),
          ui: count(ui ?? "", targetMarker),
          savesAfterLock: itemSavesA.slice(saveIndexBeforeLock).filter((save) => save.__itemId === targetItem.id).map((save) => ({ collaborative: Boolean(save.collaborative_update), marker: count(save.markdown ?? "", targetMarker), markdownLength: (save.markdown ?? "").length })),
        })}`, { cause: error });
      }
      assert.equal(count((await restoredEditorA.textContent()) ?? "", targetMarker), 1, "relocked client did not restore the target exactly once");
      console.error(`[sync-soak] ${distribution}: relocked client restored`);

      const contextC = await browser.newContext();
      await installDistributionRuntime(contextC, staticServer.baseUrl, workspaceId);
      const pageC = await contextC.newPage();
      await pageC.goto(`${staticServer.baseUrl}${entryPath}?backendUrl=${encodeURIComponent(backendUrl)}`);
      await pageC.waitForFunction(() => document.querySelector("#backend-health-status")?.getAttribute("data-status") === "online");
      await pageC.waitForSelector("#workspace-unlock-panel:not([hidden])");
      await pageC.fill("#backend-workspace-id-input", workspaceId);
      await pageC.fill("#unlock-password-input", password);
      await pageC.click("#unlock-workspace-btn");
      await continueNicknamePrompt(pageC, `${distribution} C late`);
      await pageC.waitForSelector(".workspace-shell:not([hidden])");
      console.error(`[sync-soak] ${distribution}: late joiner unlocked`);
      const targetRowC = pageC.locator("#doc-tree .doc-list-item", { hasText: targetTitle }).first();
      await targetRowC.click();
      await pageC.waitForFunction((title) => document.querySelector("#doc-title-input")?.value === title, targetTitle);
      const targetEditorC = await editorFor(pageC);
      await pageC.waitForFunction(
        (marker) => (document.querySelector("#editor-root .doc-editor-surface--markdown")?.textContent ?? "").includes(marker),
        targetMarker,
        { timeout: 20_000 },
      );
      assert.equal(count((await targetEditorC.textContent()) ?? "", targetMarker), 1, "late joiner did not load the target exactly once");
      console.error(`[sync-soak] ${distribution}: late joiner restored`);
      await contextC.close();
    }
  } catch (error) {
    try {
      const log = await readFile(backendLogPath, "utf8");
      if (log.trim()) console.error(log.slice(-12_000));
    } catch {
      // Preserve the original error.
    }
    throw error;
  } finally {
    await browserB?.close();
    await browser?.close();
    await new Promise((resolve) => staticServer?.server.close(resolve) ?? resolve());
    stopBackendProcess(backend, backendPort);
    await rm(dataDir, { recursive: true, force: true });
  }
}

await main();
