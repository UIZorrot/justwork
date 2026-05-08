import { sha256Hex, toArrayBuffer } from "./hash";
import type {
  WorkspaceAssetBackend,
  WorkspaceImageAssetMeta,
  WorkspaceImageAssetRecord,
} from "./types";

const DEFAULT_GRACE_PERIOD_MS = 15 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function backendKey(workspaceId: string, assetId: string): string {
  return `${workspaceId}::${assetId}`;
}

function blobFromRecord(record: WorkspaceImageAssetRecord): Blob {
  return new Blob([record.bytes], { type: record.meta.mimeType || "application/octet-stream" });
}

export function createMemoryWorkspaceAssetBackend(initial?: Record<string, WorkspaceImageAssetRecord>): WorkspaceAssetBackend {
  const map = new Map<string, WorkspaceImageAssetRecord>(Object.entries(initial ?? {}));

  return {
    async get(key: string) {
      const record = map.get(key);
      return record ? { ...record, meta: { ...record.meta } } : undefined;
    },
    async set(key: string, record: WorkspaceImageAssetRecord) {
      map.set(key, {
        ...record,
        meta: { ...record.meta },
        bytes: record.bytes.slice(0),
      });
    },
    async delete(key: string) {
      map.delete(key);
    },
    async listKeys(prefix: string) {
      return Array.from(map.keys()).filter((key) => key.startsWith(prefix));
    },
  };
}

export type WorkspaceImageAssetStore = {
  workspaceId: string;
  put(input: {
    bytes: ArrayBuffer | ArrayBufferView | Blob;
    mimeType: string;
    filename?: string;
    width?: number;
    height?: number;
  }): Promise<WorkspaceImageAssetMeta>;
  get(assetId: string): Promise<WorkspaceImageAssetRecord | null>;
  has(assetId: string): Promise<boolean>;
  listAssetIds(): Promise<string[]>;
  delete(assetId: string): Promise<void>;
  updateReferenceCounts(previousAssetIds: string[], nextAssetIds: string[]): Promise<void>;
  sweepUnreferenced(gracePeriodMs?: number): Promise<string[]>;
  loadBlobUrl(assetId: string): Promise<string | null>;
  resolveAssetUrlSync(assetId: string): string;
  resolveAssetIdFromUrl(url: string): string | null;
  rememberAssetUrl(assetId: string, url: string): void;
  forgetAssetUrl(url: string): void;
  clearTransientUrls(): void;
};

type WorkspaceImageAssetStoreOptions = {
  workspaceId: string;
  backend?: WorkspaceAssetBackend;
};

export function createWorkspaceImageAssetStore(opts: WorkspaceImageAssetStoreOptions): WorkspaceImageAssetStore {
  const backend = opts.backend ?? createMemoryWorkspaceAssetBackend();
  const workspaceId = opts.workspaceId;
  const prefix = `${workspaceId}::`;
  const urlByAssetId = new Map<string, string>();
  const assetIdByUrl = new Map<string, string>();
  const urlKindByAssetId = new Map<string, "real" | "placeholder">();
  const transientUrls = new Set<string>();

  const createUrl = (record: WorkspaceImageAssetRecord): string => {
    const cached = urlByAssetId.get(record.meta.assetId);
    const kind = urlKindByAssetId.get(record.meta.assetId);
    if (cached && kind === "real") return cached;
    if (cached && kind === "placeholder") {
      URL.revokeObjectURL(cached);
      assetIdByUrl.delete(cached);
      transientUrls.delete(cached);
      urlByAssetId.delete(record.meta.assetId);
      urlKindByAssetId.delete(record.meta.assetId);
    }
    const url = URL.createObjectURL(blobFromRecord(record));
    urlByAssetId.set(record.meta.assetId, url);
    assetIdByUrl.set(url, record.meta.assetId);
    urlKindByAssetId.set(record.meta.assetId, "real");
    transientUrls.add(url);
    return url;
  };

  const placeholderUrlFor = (assetId: string): string => {
    const cached = urlByAssetId.get(assetId);
    const kind = urlKindByAssetId.get(assetId);
    if (cached && kind === "placeholder") return cached;
    if (cached && kind === "real") return cached;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="400" viewBox="0 0 720 400">
      <rect width="720" height="400" fill="#eef2f7"/>
      <rect x="24" y="24" width="672" height="352" rx="18" fill="#ffffff" stroke="#c7d2e0"/>
      <path d="M144 280l104-112 88 94 60-60 160 178H144z" fill="#d9e2ec"/>
      <circle cx="258" cy="170" r="32" fill="#c7d2e0"/>
      <text x="48" y="60" font-family="Arial, sans-serif" font-size="28" fill="#526071">Image pending sync</text>
      <text x="48" y="98" font-family="Arial, sans-serif" font-size="18" fill="#738496">${assetId}</text>
    </svg>`;
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    urlByAssetId.set(assetId, url);
    assetIdByUrl.set(url, assetId);
    urlKindByAssetId.set(assetId, "placeholder");
    transientUrls.add(url);
    return url;
  };

  const recordToMeta = (record: WorkspaceImageAssetRecord): WorkspaceImageAssetMeta => ({
    ...record.meta,
  });

  return {
    workspaceId,
    async put(input) {
      const bytes = await toArrayBuffer(input.bytes);
      const sha256 = await sha256Hex(bytes);
      const meta: WorkspaceImageAssetMeta = {
        workspaceId,
        assetId: sha256,
        mimeType: input.mimeType,
        sizeBytes: bytes.byteLength,
        sha256,
        filename: input.filename,
        width: input.width,
        height: input.height,
      };
      const key = backendKey(workspaceId, meta.assetId);
      const existing = await backend.get(key);
      const record: WorkspaceImageAssetRecord = {
        meta,
        bytes,
        createdAt: existing?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
        refCount: existing?.refCount ?? 0,
      };
      await backend.set(key, record);
      createUrl(record);
      return record.meta;
    },
    async get(assetId) {
      const record = await backend.get(backendKey(workspaceId, assetId));
      if (!record) return null;
      createUrl(record);
      return record;
    },
    async has(assetId) {
      return (await backend.get(backendKey(workspaceId, assetId))) !== undefined;
    },
    async listAssetIds() {
      return (await backend.listKeys(prefix)).map((key) => key.slice(prefix.length));
    },
    async delete(assetId) {
      const key = backendKey(workspaceId, assetId);
      const existing = await backend.get(key);
      if (existing) {
        const url = urlByAssetId.get(assetId);
        if (url) {
          URL.revokeObjectURL(url);
          transientUrls.delete(url);
          assetIdByUrl.delete(url);
        }
        urlByAssetId.delete(assetId);
        await backend.delete(key);
      }
    },
    async updateReferenceCounts(previousAssetIds, nextAssetIds) {
      const previous = new Map<string, number>();
      const next = new Map<string, number>();
      for (const id of previousAssetIds) previous.set(id, (previous.get(id) ?? 0) + 1);
      for (const id of nextAssetIds) next.set(id, (next.get(id) ?? 0) + 1);

      const touched = new Set([...previous.keys(), ...next.keys()]);
      for (const assetId of touched) {
        const key = backendKey(workspaceId, assetId);
        const record = await backend.get(key);
        if (!record) continue;
        const delta = (next.get(assetId) ?? 0) - (previous.get(assetId) ?? 0);
        const nextCount = Math.max(0, record.refCount + delta);
        await backend.set(key, {
          ...record,
          refCount: nextCount,
          updatedAt: nowIso(),
        });
      }
    },
    async sweepUnreferenced(gracePeriodMs = DEFAULT_GRACE_PERIOD_MS) {
      const now = Date.now();
      const removed: string[] = [];
      for (const assetId of await this.listAssetIds()) {
        const record = await backend.get(backendKey(workspaceId, assetId));
        if (!record) continue;
        const age = now - new Date(record.updatedAt).getTime();
        if (record.refCount <= 0 && age >= gracePeriodMs) {
          await this.delete(assetId);
          removed.push(assetId);
        }
      }
      return removed;
    },
    async loadBlobUrl(assetId) {
      const record = await this.get(assetId);
      if (!record) return null;
      return createUrl(record);
    },
    resolveAssetUrlSync(assetId) {
      return urlByAssetId.get(assetId) ?? placeholderUrlFor(assetId);
    },
    resolveAssetIdFromUrl(url) {
      return assetIdByUrl.get(url) ?? null;
    },
    rememberAssetUrl(assetId, url) {
      urlByAssetId.set(assetId, url);
      assetIdByUrl.set(url, assetId);
      urlKindByAssetId.set(assetId, "real");
      transientUrls.add(url);
    },
    forgetAssetUrl(url) {
      const assetId = assetIdByUrl.get(url);
      if (assetId) {
        const current = urlByAssetId.get(assetId);
        if (current === url) urlByAssetId.delete(assetId);
        urlKindByAssetId.delete(assetId);
      }
      assetIdByUrl.delete(url);
      transientUrls.delete(url);
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    },
    clearTransientUrls() {
      for (const url of transientUrls) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
      }
      transientUrls.clear();
      urlByAssetId.clear();
      assetIdByUrl.clear();
      urlKindByAssetId.clear();
    },
  };
}
