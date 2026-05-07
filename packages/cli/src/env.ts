import process from "node:process";

export function bridgeBaseUrl(): string {
  return (process.env.JUSTWORK_BRIDGE_URL ?? "http://127.0.0.1:17373").replace(/\/$/, "");
}

export function bridgeToken(): string | undefined {
  const t = process.env.JUSTWORK_TOKEN;
  return t && t.length > 0 ? t : undefined;
}

export function authHeaders(): HeadersInit {
  const token = bridgeToken();
  if (!token) {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}
