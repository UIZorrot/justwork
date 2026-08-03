import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, createReadStream, openSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const distDir = path.resolve("dist");

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function startStaticServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const requested = path.normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
    const filePath = path.join(distDir, requested || "src/pages/workbench/index.html");
    if (!filePath.startsWith(distDir)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error("not a file");
      res.writeHead(200, { "Content-Type": contentType(filePath) });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404);
      res.end("not found");
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
      const res = await fetch(`${baseUrl}/v1/health`);
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`backend did not start at ${baseUrl}`);
}

async function expectVisibleText(page, text) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: "visible" });
}

async function continueWorkspaceNicknamePromptIfVisible(page) {
  const prompt = page.locator("#workspace-nickname-prompt-root.is-open");
  try {
    await prompt.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    return;
  }
  await page.fill("#workspace-nickname-prompt-input", "E2E User");
  await page.click("#workspace-nickname-prompt-save-btn");
}

async function placeCaretAtEnd(editor) {
  await editor.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.focus();
  });
}

async function withDeadline(promise, label, timeout = 10_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeout}ms`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function stopBackendProcess(backend, backendPort) {
  if (process.platform !== "win32") {
    backend.kill();
    return;
  }
  if (backend.pid) {
    spawnSync("taskkill", ["/PID", String(backend.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
  // `uv run` may exit before its Windows Python launcher and base interpreter,
  // leaving them re-parented outside the original taskkill tree. Match only the
  // random port owned by this test and remove those verified descendants.
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

function collectConsoleViolations(page) {
  const violations = [];
  const capture = (text) => {
    if (
      text.includes("Content Security Policy") ||
      text.includes("Executing inline script") ||
      text.includes("Blocked aria-hidden")
    ) {
      violations.push(text);
    }
  };
  page.on("console", (message) => capture(message.text()));
  page.on("pageerror", (error) => capture(error.message));
  return violations;
}

async function main() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "justwork-backend-e2e-"));
  const backendLogPath = path.join(dataDir, "backend.log");
  const backendLog = openSync(backendLogPath, "a");
  const backendPort = 18_000 + Math.floor(Math.random() * 1_000);
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const backend = spawn(
    "uv",
    ["run", "--project", ".", "python", "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(backendPort)],
    {
      cwd: path.resolve("backend"),
      env: {
        ...process.env,
        JUSTWORK_DATABASE_URL: "",
        PYTHONUNBUFFERED: "1",
        JUSTWORK_BACKEND_DATA_FILE: path.join(dataDir, "workspaces.json"),
      },
      // Avoid piped stdio: some Windows environments raise spawn EPERM when stdio is piped to Node.
      stdio: ["ignore", backendLog, backendLog],
      windowsHide: true,
    },
  );
  closeSync(backendLog);

  let staticServer;
  let browser;
  let browserB;
  const step = (label) => {
    const message = `[backend-e2e] ${label}`;
    console.error(message);
    appendFileSync(backendLogPath, `${message}\n`);
  };
  try {
    step("wait for backend");
    await waitForBackend(backendUrl);
    staticServer = await startStaticServer();

    step("launch browser");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    let delayFirstCollaborationJoin = true;
    await page.route("**/collab/join", async (route) => {
      if (delayFirstCollaborationJoin) {
        delayFirstCollaborationJoin = false;
        await new Promise((resolve) => setTimeout(resolve, 2_500));
      }
      await route.continue();
    });
    const consoleViolations = collectConsoleViolations(page);
    const store = {};
    await page.exposeFunction("__jwStorageGet", async (keys) => {
      if (keys === null || keys === undefined) return { ...store };
      if (typeof keys === "string") return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, store[key]]));
      }
      return Object.fromEntries(Object.keys(keys).map((key) => [key, store[key] ?? keys[key]]));
    });
    await page.exposeFunction("__jwStorageSet", async (values) => {
      Object.assign(store, values);
    });
    await page.exposeFunction("__jwStorageRemove", async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete store[key];
      }
    });
    await page.addInitScript(({ base }) => {
      globalThis.chrome = {
        runtime: {
          getURL: (resource) => `${base}/${resource.replace(/^\/+/, "")}`,
        },
        storage: {
          local: {
            async get(keys) {
              return globalThis.__jwStorageGet(keys);
            },
            async set(values) {
              return globalThis.__jwStorageSet(values);
            },
            async remove(keys) {
              return globalThis.__jwStorageRemove(keys);
            },
          },
        },
      };
    }, { base: staticServer.baseUrl });

    step("open workbench");
    await page.goto(`${staticServer.baseUrl}/src/pages/workbench/index.html?backendUrl=${encodeURIComponent(backendUrl)}`);
    await page.waitForSelector("#workspace-setup-panel:not([hidden])");
    await page.waitForFunction(() => {
      const status = document.querySelector("#backend-health-status");
      return status?.getAttribute("data-status") === "online";
    });
    await page.fill("#backend-title-setup-input", "Backend E2E Doc");
    await page.fill("#setup-password-input", "backend-password");
    await page.click("#setup-workspace-btn");
    await continueWorkspaceNicknamePromptIfVisible(page);

    step("workspace created through UI");
    await page.waitForSelector(".workspace-shell:not([hidden])");
    await page.waitForFunction(() => {
      const input = document.querySelector("#doc-title-input");
      return input instanceof HTMLInputElement && input.value === "Untitled";
    });

    step("type while the canonical collaboration room is still joining");
    const bootstrapEditor = page.locator('#editor-root .doc-editor-surface--markdown [contenteditable="true"]').first();
    await bootstrapEditor.waitFor({ state: "visible", timeout: 15_000 });
    await bootstrapEditor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("Bootstrap typing must never disappear");
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const visibleText = await bootstrapEditor.textContent();
      assert.ok(
        visibleText?.includes("Bootstrap typing must never disappear"),
        `bootstrap typing disappeared after ${attempt * 50}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const workspaceId = store["justwork.backend.lastWorkspaceId"];
    assert.match(workspaceId, /^workspace_/);
    const fetchTree = async () => {
      const res = await fetch(`${backendUrl}/v1/workspaces/${workspaceId}/tree`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "backend-password" }),
      });
      assert.equal(res.status, 200);
      return res.json();
    };
    const createdTree = await fetchTree();
    assert.equal(createdTree.workspace_title, "Backend E2E Doc");
    const createdFirstPage = createdTree.items.find((item) => item.kind === "page");
    assert.equal(createdFirstPage?.title, "Untitled");
    const waitForTreeItem = async (predicate) => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        let tree;
        try {
          tree = await fetchTree();
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        const item = tree?.items?.find(predicate);
        if (item) return item;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new Error("timed out waiting for backend tree item");
    };
    const waitForTreeItems = async (predicate) => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        let tree;
        try {
          tree = await fetchTree();
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        if (tree?.items && predicate(tree.items)) return tree.items;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new Error("timed out waiting for backend tree state");
    };
    const createItem = async (body) => {
      const res = await fetch(`${backendUrl}/v1/workspaces/${workspaceId}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "backend-password", ...body }),
      });
      if (res.status !== 200) {
        throw new Error(`createItem failed: ${res.status} ${await res.text()}`);
      }
      return res.json();
    };
    const updateItem = async (itemId, path, body) => {
      step(`request ${path || "/update"} ${itemId}`);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        let expectedRevision = body.expected_revision;
        const current = await fetch(`${backendUrl}/v1/workspaces/${workspaceId}/items/${itemId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "backend-password" }),
          signal: AbortSignal.timeout(15_000),
        });
        if (current.status !== 200) {
          throw new Error(`load current item failed: ${current.status} ${await current.text()}`);
        }
        expectedRevision ??= (await current.json()).item.revision;
        const res = await fetch(`${backendUrl}/v1/workspaces/${workspaceId}/items/${itemId}${path}`, {
          method: path === "/hard-delete" ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "backend-password", ...body, expected_revision: expectedRevision }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 200) {
          step(`response ${path || "/update"} ${itemId}`);
          return res.json();
        }
        const responseText = await res.text();
        if (res.status !== 409 || body.expected_revision !== undefined || attempt === 3) {
          throw new Error(`updateItem failed: ${res.status} ${responseText}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)));
      }
      throw new Error("updateItem conflict retry exhausted");
    };

    step("rename initial page");
    const initialTree = await fetchTree();
    const pageDoc = initialTree.items.find((item) => item.kind === "page");
    assert.ok(pageDoc, "expected a page item in the initial tree");
    await updateItem(pageDoc.id, "", { title: "Backend E2E Updated" });
    const renamedPage = await waitForTreeItem(
      (item) => item.kind === "page" && item.id === pageDoc.id && item.title === "Backend E2E Updated",
    );
    assert.equal(renamedPage.title, "Backend E2E Updated");

    const fetchItem = async (itemId) => {
      const res = await fetch(`${backendUrl}/v1/workspaces/${workspaceId}/items/${itemId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "backend-password" }),
      });
      assert.equal(res.status, 200);
      return res.json();
    };

    const bootstrapPersisted = await (async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const item = (await fetchItem(createdFirstPage.id)).item;
        if (item.markdown.includes("Bootstrap typing must never disappear")) return item;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new Error("timed out waiting for bootstrap typing to persist");
    })();
    assert.equal(
      bootstrapPersisted.markdown.match(/Bootstrap typing must never disappear/g)?.length,
      1,
    );

    const markerText = "E2E Revert Marker";
    step("fetch initial page");
    const baseDoc = await fetchItem(pageDoc.id);
    step("write marker");
    const markerRes = await updateItem(pageDoc.id, "", { markdown: `${baseDoc.item.markdown}\n\n## ${markerText}` });
    const markerItem = markerRes.item;
    assert.ok(markerItem.markdown.includes(markerText));

    step("create lifecycle folder and pages");
    const folderDoc = (await createItem({ kind: "folder", title: "Backend E2E Folder", parent_id: "root" })).item;
    const createdPage = (await createItem({
      kind: "page",
      title: "Backend E2E Created Page",
      parent_id: folderDoc.id,
    })).item;
    assert.equal(createdPage.parent_id, folderDoc.id);
    const collapseChildPage = (await createItem({
      kind: "page",
      title: "Backend E2E Child Page",
      parent_id: folderDoc.id,
    })).item;
    assert.equal(collapseChildPage.parent_id, folderDoc.id);

    step("pin lifecycle page");
    let pageState = (await updateItem(createdPage.id, "/pin", { pinned: true })).item;
    assert.equal(pageState.pinned, true);

    step("trash lifecycle page");
    pageState = (await updateItem(pageState.id, "/trash", {})).item;
    assert.equal(pageState.in_trash, true);

    step("restore lifecycle page");
    pageState = (await updateItem(pageState.id, "/restore", {})).item;
    assert.equal(pageState.in_trash, false);

    step("trash lifecycle page again");
    pageState = (await updateItem(pageState.id, "/trash", {})).item;
    assert.equal(pageState.in_trash, true);
    await updateItem(pageState.id, "/hard-delete", {});
    await waitForTreeItems((items) => !items.some((item) => item.id === pageState.id));

    await page.click("#lock-workspace-btn");
    await page.waitForSelector("#workspace-unlock-panel:not([hidden])");
    await page.fill("#backend-workspace-id-input", workspaceId);
    await page.fill("#unlock-password-input", "backend-password");
    await page.click("#unlock-workspace-btn");
    await continueWorkspaceNicknamePromptIfVisible(page);
    await page.waitForSelector(".workspace-shell:not([hidden])");
    await expectVisibleText(page, "Backend E2E Updated");
    await expectVisibleText(page, "Backend E2E Folder");
    await expectVisibleText(page, "Backend E2E Child Page");

    const folderRow = page.locator("#doc-tree .doc-list-item", { hasText: "Backend E2E Folder" }).first();
    const childRow = page.locator("#doc-tree .doc-list-item", { hasText: "Backend E2E Child Page" }).first();
    await folderRow.click();
    await childRow.waitFor({ state: "detached" });
    assert.equal(await folderRow.getAttribute("aria-expanded"), "false");
    await folderRow.click();
    await childRow.waitFor({ state: "visible" });
    assert.equal(await folderRow.getAttribute("aria-expanded"), "true");

    const identity = store["justwork.identity.v1"];
    const nicknameKey = "justwork.backend.workspaceNicknames.v1";
    const localNicknameKey = `${workspaceId}::${identity.userId}`;
    const nicknameMap = { ...(store[nicknameKey] ?? {}) };
    step(`nickname keys before delete: ${Object.keys(nicknameMap).join(",") || "(none)"}`);
    delete nicknameMap[localNicknameKey];
    store[nicknameKey] = nicknameMap;
    assert.equal(store[nicknameKey]?.[localNicknameKey], undefined);
    await page.click("#lock-workspace-btn");
    await page.waitForSelector("#workspace-unlock-panel:not([hidden])");
    const nicknameStoreAfterReload = await page.evaluate((key) => chrome.storage.local.get(key), nicknameKey);
    assert.equal(nicknameStoreAfterReload[nicknameKey]?.[localNicknameKey], undefined);
    await page.fill("#backend-workspace-id-input", workspaceId);
    await page.fill("#unlock-password-input", "backend-password");
    await page.click("#unlock-workspace-btn");
    await page.locator("#workspace-nickname-prompt-root.is-open").waitFor({ state: "visible" });
    await page.fill("#workspace-nickname-prompt-input", "E2E User Again");
    await page.click("#workspace-nickname-prompt-save-btn");
    await page.waitForSelector(".workspace-shell:not([hidden])");

    step("open second collaborative client");
    browserB = await chromium.launch({ headless: true });
    const contextB = await browserB.newContext();
    const storeB = { "justwork.backend.lastWorkspaceId": workspaceId };
    await contextB.exposeFunction("__jwStorageGet", async (keys) => {
      if (keys === null || keys === undefined) return { ...storeB };
      if (typeof keys === "string") return { [keys]: storeB[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storeB[key]]));
      return Object.fromEntries(Object.keys(keys).map((key) => [key, storeB[key] ?? keys[key]]));
    });
    await contextB.exposeFunction("__jwStorageSet", async (values) => Object.assign(storeB, values));
    await contextB.exposeFunction("__jwStorageRemove", async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete storeB[key];
    });
    await contextB.addInitScript(({ base }) => {
      globalThis.chrome = {
        runtime: { getURL: (resource) => `${base}/${resource.replace(/^\/+/, "")}` },
        storage: {
          local: {
            async get(keys) { return globalThis.__jwStorageGet(keys); },
            async set(values) { return globalThis.__jwStorageSet(values); },
            async remove(keys) { return globalThis.__jwStorageRemove(keys); },
          },
        },
      };
    }, { base: staticServer.baseUrl });
    const pageB = await contextB.newPage();
    const consoleViolationsB = collectConsoleViolations(pageB);
    await pageB.goto(`${staticServer.baseUrl}/src/pages/workbench/index.html?backendUrl=${encodeURIComponent(backendUrl)}`);
    await pageB.waitForFunction(() => document.querySelector("#backend-health-status")?.getAttribute("data-status") === "online");
    await pageB.waitForSelector("#workspace-unlock-panel:not([hidden])");
    await pageB.fill("#backend-workspace-id-input", workspaceId);
    await pageB.fill("#unlock-password-input", "backend-password");
    await pageB.click("#unlock-workspace-btn");
    await continueWorkspaceNicknamePromptIfVisible(pageB);
    await pageB.waitForSelector(".workspace-shell:not([hidden])");

    const openInitialPage = async (targetPage) => {
      const row = targetPage.locator("#doc-tree .doc-list-item", { hasText: "Backend E2E Updated" }).first();
      await row.click();
      await targetPage.waitForFunction(() => {
        const title = document.querySelector("#doc-title-input");
        return title instanceof HTMLInputElement && title.value === "Backend E2E Updated";
      }, undefined, { timeout: 15_000 });
      const editor = targetPage.locator('#editor-root .doc-editor-surface--markdown [contenteditable="true"]').first();
      await editor.waitFor({ state: "visible", timeout: 15_000 });
      await targetPage.waitForFunction(() => {
        const host = document.querySelector("#editor-root .doc-editor-surface--markdown");
        return host
          && !host.closest("[inert]")
          && !host.hasAttribute("inert")
          && host.getAttribute("aria-busy") !== "true";
      });
      return editor;
    };
    const editorA = await openInitialPage(page);
    const editorB = await openInitialPage(pageB);

    step("verify bidirectional live collaboration");
    step("place Alice caret");
    await withDeadline(placeCaretAtEnd(editorA), "place Alice caret");
    step("insert Alice newline");
    await withDeadline(page.keyboard.press("Enter"), "insert Alice newline");
    step("insert Alice marker");
    await withDeadline(page.keyboard.insertText("Alice live marker"), "insert Alice marker");
    step("wait for Alice marker on Bob");
    try {
      await pageB.waitForFunction(
        () => document.querySelector("#editor-root .doc-editor-surface--markdown")?.textContent?.includes("Alice live marker"),
        undefined,
        { timeout: 15_000 },
      );
    } catch (error) {
      step("Alice marker did not reach Bob; collecting diagnostics");
      const canonical = (await fetchItem(pageDoc.id)).item.markdown;
      const [aliceSurface, bobSurface] = await Promise.all([
        editorA.textContent({ timeout: 3_000 }).catch(() => "<unresponsive>"),
        editorB.textContent({ timeout: 3_000 }).catch(() => "<unresponsive>"),
      ]);
      const diagnostic = JSON.stringify({
        canonical,
        aliceSurface,
        bobSurface,
      });
      console.error("[backend-e2e] live collaboration diagnostic", diagnostic);
      appendFileSync(backendLogPath, `[backend-e2e] live collaboration diagnostic ${diagnostic}\n`);
      throw error;
    }
    step("place Bob caret");
    await withDeadline(placeCaretAtEnd(editorB), "place Bob caret");
    step("insert Bob newline");
    await withDeadline(pageB.keyboard.press("Enter"), "insert Bob newline");
    step("insert Bob marker");
    await withDeadline(pageB.keyboard.insertText("Bob live marker"), "insert Bob marker");
    step("wait for Bob marker on Alice");
    await page.waitForFunction(
      () => document.querySelector("#editor-root .doc-editor-surface--markdown")?.textContent?.includes("Bob live marker"),
      undefined,
      { timeout: 15_000 },
    );

    const mergedItem = await (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const item = (await fetchItem(pageDoc.id)).item;
        if (item.markdown.includes("Alice live marker") && item.markdown.includes("Bob live marker")) {
          return item;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new Error("timed out waiting for both collaborative edits to persist");
    })();
    assert.ok(mergedItem.markdown.includes("Alice live marker"));
    assert.ok(mergedItem.markdown.includes("Bob live marker"));
    assert.deepEqual(consoleViolationsB, []);
    assert.deepEqual(consoleViolations, []);
  } catch (error) {
    try {
      const log = await readFile(backendLogPath, "utf8");
      if (log.trim()) {
        const tail = log.trim().split(/\r?\n/).slice(-160).join("\n");
        console.error("\n--- backend log (last 160 lines) ---\n" + tail + "\n--- end backend log ---");
      }
    } catch {
      // Keep the original failure if diagnostic log reading fails.
    }
    throw error;
  } finally {
    step("close second browser");
    if (browserB) {
      await withDeadline(browserB.close(), "close second browser", 5_000).catch((error) => {
        step(error instanceof Error ? error.message : String(error));
      });
    }
    step("close first browser");
    if (browser) {
      await withDeadline(browser.close(), "close first browser", 5_000).catch((error) => {
        step(error instanceof Error ? error.message : String(error));
      });
    }
    await new Promise((resolve) => staticServer?.server.close(resolve) ?? resolve());
    stopBackendProcess(backend, backendPort);
    await rm(dataDir, { recursive: true, force: true });
  }
}

await main();
