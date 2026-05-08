export type WorkspaceImageAssetMeta = {
  workspaceId: string;
  assetId: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  filename?: string;
  width?: number;
  height?: number;
};

export type WorkspaceImageAssetRecord = {
  meta: WorkspaceImageAssetMeta;
  bytes: ArrayBuffer;
  createdAt: string;
  updatedAt: string;
  refCount: number;
};

export type WorkspaceAssetBackend = {
  get(key: string): Promise<WorkspaceImageAssetRecord | undefined>;
  set(key: string, record: WorkspaceImageAssetRecord): Promise<void>;
  delete(key: string): Promise<void>;
  listKeys(prefix: string): Promise<string[]>;
};

