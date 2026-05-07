#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { Command } from "commander";
import { startBridgeServer } from "@justwork/bridge";
import { getAgentCatalogJson } from "@justwork/agent-protocol";
import { authHeaders, bridgeBaseUrl } from "./env.js";

const docPath = "/v1/document";
const invokePath = "/v1/agent/invoke";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) {
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function httpJson(method: string, pathSuffix: string, body?: unknown): Promise<unknown> {
  const url = `${bridgeBaseUrl()}${pathSuffix}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return text ? (JSON.parse(text) as unknown) : null;
}

const program = new Command();
program.name("justwork").description("JustWork 文档 / Agent CLI").showHelpAfterError();

const bridge = program.command("bridge").description("本机 HTTP Bridge");
bridge
  .command("start")
  .description("启动 Bridge（扩展与 Agent 通过 REST 访问）")
  .option("--port <n>", "端口", "17373")
  .option("--token <s>", "Bearer token（也可用 JUSTWORK_TOKEN）")
  .option("--data-dir <path>", "持久化目录（也可用 JUSTWORK_DATA_DIR）")
  .action(async (opts: { port?: string; token?: string; dataDir?: string }) => {
    const port = Number(opts.port);
    const token: string | undefined = opts.token ?? process.env.JUSTWORK_TOKEN;
    const dataDir: string | undefined = opts.dataDir ?? process.env.JUSTWORK_DATA_DIR;
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error("invalid --port");
    }
    const server = await startBridgeServer({ port, token, dataDir });
    console.error(
      `[justwork] bridge http://127.0.0.1:${port}  auth=${token ? "bearer" : "none"}`,
    );
    if (dataDir) {
      console.error(`[justwork] persist ${dataDir}`);
    }
    const stop = () => {
      server.close(() => process.exit(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

program
  .command("health")
  .description("GET /v1/health")
  .action(async () => {
    const r = (await httpJson("GET", "/v1/health")) as { ok?: boolean };
    console.log(JSON.stringify(r, null, 2));
    if (!r?.ok) {
      process.exitCode = 1;
    }
  });

program
  .command("schema")
  .description("打印 agent 操作目录（JSON Schema）")
  .option("--raw", "单行 JSON")
  .action((opts: { raw?: boolean }) => {
    const cat = getAgentCatalogJson();
    console.log(opts.raw ? JSON.stringify(cat) : JSON.stringify(cat, null, 2));
  });

const doc = program.command("doc").description("文档（HTTP Bridge）");
doc
  .command("get")
  .description("GET /v1/document")
  .action(async () => {
    const r = await httpJson("GET", docPath);
    console.log(JSON.stringify(r, null, 2));
  });

doc
  .command("set")
  .description("PUT /v1/document（文件或 stdin）")
  .option("-f, --file <path>", "Markdown 文件")
  .action(async (opts: { file?: string }) => {
    let md: string;
    if (opts.file) {
      md = await readFile(String(opts.file), "utf8");
    } else {
      md = await readStdin();
    }
    if (md.length === 0) {
      throw new Error("empty input");
    }
    const r = await httpJson("PUT", docPath, { markdown: md });
    console.log(JSON.stringify(r, null, 2));
  });

doc
  .command("pull")
  .description("Bridge → 本地文件")
  .requiredOption("-o, --output <path>", "输出文件")
  .action(async (opts: { output: string }) => {
    const r = (await httpJson("GET", docPath)) as { markdown?: string };
    if (typeof r.markdown !== "string") {
      throw new Error("unexpected response");
    }
    await writeFile(opts.output, r.markdown, "utf8");
    console.error(`wrote ${opts.output}`);
  });

doc
  .command("push")
  .description("本地文件 → Bridge")
  .requiredOption("-i, --input <path>", "Markdown 文件")
  .action(async (opts: { input: string }) => {
    const md = await readFile(String(opts.input), "utf8");
    const r = await httpJson("PUT", docPath, { markdown: md });
    console.log(JSON.stringify(r, null, 2));
  });

const agent = program.command("agent").description("结构化 invoke（面向 Agent）");
agent
  .command("invoke")
  .description("POST /v1/agent/invoke")
  .argument("<op>", "操作名，如 doc.get、doc.append")
  .option("-a, --args <json>", "JSON 参数（Windows Agent 建议改用 --args-file）", "{}")
  .option("--args-file <path>", "从 UTF-8 JSON 文件读取参数，优先级高于 --args")
  .action(async (op: string, opts: { args?: string; argsFile?: string }) => {
    let raw = "{}";
    if (opts.argsFile) {
      raw = await readFile(String(opts.argsFile), "utf8");
    } else {
      raw = String(opts.args ?? "{}");
    }
    raw = raw.replace(/^\uFEFF/, "").trim();
    let args: unknown = {};
    try {
      args = JSON.parse(raw);
    } catch {
      throw new Error("invalid JSON args");
    }
    const r = await httpJson("POST", invokePath, { op, args });
    console.log(JSON.stringify(r, null, 2));
  });

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
