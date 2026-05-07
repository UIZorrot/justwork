import http from "node:http";
import { getAgentCatalogJson } from "@justwork/agent-protocol";
import { dispatchInvoke, applyPutDocument, type DispatchContext } from "./dispatch.js";
import { emptyState, loadState, persistState, type DocState } from "./state.js";
import { createFileRuntimeStorage } from "./runtime-storage.js";

export type BridgeServerOptions = {
  port: number;
  /** 若设置，则要求请求头 `Authorization: Bearer <token>` */
  token?: string;
  /** 持久化目录；存在则启动时尝试加载，并在每次变更后写回 */
  dataDir?: string;
};

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(),
  });
  res.end(payload);
}

export async function startBridgeServer(opts: BridgeServerOptions): Promise<http.Server> {
  let state: DocState = emptyState();
  if (opts.dataDir) {
    const loaded = await loadState(opts.dataDir);
    if (loaded) {
      state = loaded;
    }
  }

  const bump = () => {
    state.revision += 1;
    state.updatedAt = new Date().toISOString();
    if (opts.dataDir) {
      void persistState(opts.dataDir, state);
    }
  };

  const runtimeStorage = createFileRuntimeStorage(opts.dataDir ?? ".justwork-data");
  const sharedCtx: DispatchContext = { state, bump, runtimeStorage };
  const ctx = (): DispatchContext => {
    sharedCtx.state = state;
    return sharedCtx;
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    const unauthorized = () => json(res, 401, { ok: false, error: "unauthorized" });

    if (opts.token) {
      const auth = req.headers.authorization;
      const expected = `Bearer ${opts.token}`;
      if (auth !== expected) {
        unauthorized();
        return;
      }
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    try {
      if (req.method === "GET" && url.pathname === "/v1/health") {
        json(res, 200, {
          ok: true,
          version: "0.0.1",
          port: opts.port,
          auth: opts.token ? "bearer" : "none",
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/schema") {
        json(res, 200, getAgentCatalogJson());
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/document") {
        json(res, 200, {
          markdown: state.markdown,
          revision: state.revision,
          updatedAt: state.updatedAt,
        });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/v1/document") {
        const raw = await readBody(req);
        const body = JSON.parse(raw || "{}");
        const out = applyPutDocument(ctx(), body);
        json(res, 200, out);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/agent/invoke") {
        const raw = await readBody(req);
        const body = JSON.parse(raw || "{}");
        const result = await dispatchInvoke(ctx(), body);
        json(res, 200, { ok: true, result });
        return;
      }

      json(res, 404, { ok: false, error: "not_found" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, 400, { ok: false, error: msg });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve());
  });

  return server;
}
