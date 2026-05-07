import {
  decryptWorkspacePayload,
  encryptWorkspacePayload,
  type EncryptedWorkspacePayload,
} from "@justwork/security";
import type { StoredLocalIdentity } from "./identity-store.js";
import { RUNTIME_STORAGE_KEYS, type RuntimeStorage } from "./storage.js";

export type WorkspaceMeta = {
  workspaceId: string;
  creatorUserId: string;
  memberUserIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceSession<TState = unknown> = {
  locked: boolean;
  meta: WorkspaceMeta;
  state?: TState;
};

export type CreateEncryptedWorkspaceInput<TState = unknown> = {
  creator: StoredLocalIdentity;
  password: string;
  plaintextState: TState;
};

export type CreateEncryptedWorkspaceResult<TState = unknown> = {
  meta: WorkspaceMeta;
  session: WorkspaceSession<TState>;
};

export type SaveEncryptedWorkspaceStateInput<TState = unknown> = {
  password: string;
  state: TState;
};

export type MigrateLegacyWorkspaceInput = {
  creator: StoredLocalIdentity;
  password: string;
};

export type MigrateLegacyWorkspaceResult<TState = unknown> = {
  migrated: boolean;
  meta?: WorkspaceMeta;
  session?: WorkspaceSession<TState>;
};

function makeWorkspaceId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const binary = String.fromCharCode(...bytes);
  return `workspace_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

export async function createEncryptedWorkspace<TState>(
  storage: RuntimeStorage,
  input: CreateEncryptedWorkspaceInput<TState>,
): Promise<CreateEncryptedWorkspaceResult<TState>> {
  const now = new Date().toISOString();
  const meta: WorkspaceMeta = {
    workspaceId: makeWorkspaceId(),
    creatorUserId: input.creator.userId,
    memberUserIds: [input.creator.userId],
    createdAt: now,
    updatedAt: now,
  };
  const payload = await encryptWorkspacePayload({
    workspaceId: meta.workspaceId,
    plaintext: JSON.stringify(input.plaintextState),
    password: input.password,
  });

  await storage.set(RUNTIME_STORAGE_KEYS.WORKSPACE_META, meta);
  await storage.set(RUNTIME_STORAGE_KEYS.WORKSPACE_PAYLOAD, payload);

  return {
    meta,
    session: {
      locked: false,
      meta,
      state: input.plaintextState,
    },
  };
}

export async function loadWorkspaceMeta(storage: RuntimeStorage): Promise<WorkspaceMeta | undefined> {
  return storage.get<WorkspaceMeta>(RUNTIME_STORAGE_KEYS.WORKSPACE_META);
}

export async function saveEncryptedWorkspaceState<TState>(
  storage: RuntimeStorage,
  input: SaveEncryptedWorkspaceStateInput<TState>,
): Promise<WorkspaceMeta> {
  const meta = await loadWorkspaceMeta(storage);
  if (!meta) {
    throw new Error("workspace not found");
  }
  const nextMeta: WorkspaceMeta = {
    ...meta,
    updatedAt: new Date().toISOString(),
  };
  const payload = await encryptWorkspacePayload({
    workspaceId: nextMeta.workspaceId,
    plaintext: JSON.stringify(input.state),
    password: input.password,
  });
  await storage.set(RUNTIME_STORAGE_KEYS.WORKSPACE_META, nextMeta);
  await storage.set(RUNTIME_STORAGE_KEYS.WORKSPACE_PAYLOAD, payload);
  return nextMeta;
}

export async function unlockWorkspace<TState = unknown>(
  storage: RuntimeStorage,
  password: string,
): Promise<WorkspaceSession<TState>> {
  const meta = await storage.get<WorkspaceMeta>(RUNTIME_STORAGE_KEYS.WORKSPACE_META);
  const payload = await storage.get<EncryptedWorkspacePayload>(RUNTIME_STORAGE_KEYS.WORKSPACE_PAYLOAD);
  if (!meta || !payload) {
    throw new Error("workspace not found");
  }

  const plaintext = await decryptWorkspacePayload(payload, password);
  return {
    locked: false,
    meta,
    state: JSON.parse(plaintext) as TState,
  };
}

export function lockWorkspace(session: WorkspaceSession): void {
  session.locked = true;
  delete session.state;
}

export async function migrateLegacyWorkspace<TState = unknown>(
  storage: RuntimeStorage,
  input: MigrateLegacyWorkspaceInput,
): Promise<MigrateLegacyWorkspaceResult<TState>> {
  const legacy = await storage.get<TState>(RUNTIME_STORAGE_KEYS.LEGACY_DOCS);
  if (!legacy) {
    return { migrated: false };
  }

  const created = await createEncryptedWorkspace(storage, {
    creator: input.creator,
    password: input.password,
    plaintextState: legacy,
  });
  await storage.remove(RUNTIME_STORAGE_KEYS.LEGACY_DOCS);

  return {
    migrated: true,
    meta: created.meta,
    session: created.session,
  };
}
