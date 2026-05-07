import type { BridgeSettings } from "@/shared/storage-keys";

export type BridgeDocument = {
  markdown: string;
  revision: number;
  updatedAt: string;
};

function headers(settings: BridgeSettings): HeadersInit {
  const h: Record<string, string> = { Accept: "application/json" };
  if (settings.token?.length) {
    h.Authorization = `Bearer ${settings.token}`;
  }
  return h;
}

export async function fetchBridgeDocument(
  settings: BridgeSettings,
): Promise<BridgeDocument | null> {
  if (!settings.enabled) {
    return null;
  }
  try {
    const url = `${settings.baseUrl.replace(/\/$/, "")}/v1/document`;
    const res = await fetch(url, { headers: headers(settings) });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as BridgeDocument;
    if (typeof data.markdown !== "string" || typeof data.revision !== "number") {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export async function putBridgeDocument(
  settings: BridgeSettings,
  markdown: string,
): Promise<BridgeDocument | null> {
  if (!settings.enabled) {
    return null;
  }
  try {
    const url = `${settings.baseUrl.replace(/\/$/, "")}/v1/document`;
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        ...headers(settings),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ markdown }),
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as BridgeDocument;
  } catch {
    return null;
  }
}
