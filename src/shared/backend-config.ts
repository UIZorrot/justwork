declare global {
  interface ImportMeta {
    readonly env: {
      readonly VITE_JUSTWORK_BACKEND_URL?: string;
    };
  }
}

export const DEFAULT_BACKEND_URL = "https://api.tool.justwork.txzy.net";

function backendUrlFromLocation(): string {
  if (typeof globalThis.location === "undefined") return "";
  try {
    const params = new URLSearchParams(globalThis.location.search);
    return params.get("backendUrl")?.trim() ?? "";
  } catch {
    return "";
  }
}

export function getJustWorkBackendUrl(): string {
  const fromQuery = backendUrlFromLocation();
  const fromEnv = import.meta.env.VITE_JUSTWORK_BACKEND_URL?.trim();
  return (fromQuery || fromEnv || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
}

export const JUSTWORK_BACKEND_URL = getJustWorkBackendUrl();
