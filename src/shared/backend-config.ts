declare global {
  interface ImportMeta {
    readonly env: {
      readonly VITE_JUSTWORK_BACKEND_URL?: string;
    };
  }
}

export const DEFAULT_BACKEND_URL = "http://127.0.0.1:1446";

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
