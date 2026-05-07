declare global {
  interface Window {
    __JUSTWORK_BACKEND_URL__?: string;
  }

  interface ImportMeta {
    readonly env: {
      readonly VITE_JUSTWORK_BACKEND_URL?: string;
    };
  }
}

export const DEFAULT_BACKEND_URL = "http://127.0.0.1:1446";

export function getJustWorkBackendUrl(): string {
  const injected = globalThis.window?.__JUSTWORK_BACKEND_URL__?.trim();
  const fromEnv = import.meta.env.VITE_JUSTWORK_BACKEND_URL?.trim();
  return (injected || fromEnv || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
}

export const JUSTWORK_BACKEND_URL = getJustWorkBackendUrl();
