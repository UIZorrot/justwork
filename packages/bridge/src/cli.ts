#!/usr/bin/env node
import { startBridgeServer } from "./server.js";

const port = Number(process.env.JUSTWORK_BRIDGE_PORT ?? process.argv[2] ?? "17373");
const token = process.env.JUSTWORK_TOKEN;
const dataDir = process.env.JUSTWORK_DATA_DIR;

if (!Number.isFinite(port) || port <= 0) {
  console.error("invalid port");
  process.exit(1);
}

const server = await startBridgeServer({
  port,
  token,
  dataDir,
});

console.error(
  `[justwork-bridge] listening on http://127.0.0.1:${port} (auth: ${token ? "bearer" : "none"})`,
);
if (dataDir) {
  console.error(`[justwork-bridge] persist: ${dataDir}`);
}

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
