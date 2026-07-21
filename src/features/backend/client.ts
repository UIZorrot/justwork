/**
 * Backend API client — 第三方 Agent 与插件共用同一 HTTP 契约。
 * 响应体与 FastAPI/Pydantic 一致，字段为 snake_case。
 */

import {
  attachWriteSigningEnvelope,
  parseWorkspaceIdFromApiPath,
  shouldSignWriteRequest,
  signingTargetIdForPath,
} from "./sign-write";
import type { WorkspaceDocContent } from "@/shared/storage-keys";

export type BackendErrorBody = {
  ok: false;
  error: { code: string; message: string };
};

export class BackendApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BackendApiError";
    this.status = status;
    this.code = code;
  }
}

// --- API shapes (snake_case) ---

export type BackendWorkspaceItemKind = "page" | "folder" | "table" | "board";

export type WorkspaceSummary = {
  workspace_id: string;
  owner_user_id: string;
  owner_nickname: string;
  owner_display_name: string;
  encrypted_payload: string;
  updated_at: string;
};

export type WorkspaceTreeItem = {
  id: string;
  title: string;
  kind: BackendWorkspaceItemKind;
  parent_id: string | null;
  pinned: boolean;
  in_trash: boolean;
  revision: number;
  updated_at: string;
};

export type WorkspaceItem = {
  id: string;
  title: string;
  markdown: string;
  content?: WorkspaceDocContent | null;
  kind: BackendWorkspaceItemKind;
  parent_id: string | null;
  pinned: boolean;
  in_trash: boolean;
  revision: number;
  updated_at: string;
};

export type ProfileBody = {
  user_id: string;
  nickname: string;
  display_name: string;
};

export type WorkspaceMemberBody = {
  user_id: string;
  nickname: string;
  display_name: string;
  joined_at: string;
  updated_at: string;
  is_owner: boolean;
};

export type WorkspaceQuotaBody = {
  plan: string;
  used_bytes: number;
  limit_bytes: number;
  usage_ratio: number;
};

export type SearchResult = {
  id: string;
  title: string;
  kind: string;
  parent_id: string | null;
  score: number;
  excerpt: string;
};

export type OutlineHeading = {
  level: number;
  text: string;
  line: number;
};

export type CreateWorkspaceBody = {
  owner_user_id: string;
  nickname?: string;
  password: string;
  title?: string;
};

export type PasswordBody = {
  password: string;
  expected_revision?: number | null;
  client_mutation_id?: string | null;
};

export type UpdateItemBody = {
  password: string;
  title?: string | null;
  markdown?: string | null;
  content?: WorkspaceDocContent | null;
  expected_revision?: number | null;
  client_mutation_id?: string | null;
};

export type CreateItemBody = {
  password: string;
  kind: BackendWorkspaceItemKind;
  title?: string;
  parent_id?: string | null;
  client_item_id?: string | null;
  client_mutation_id?: string | null;
};

export type PinItemBody = {
  password: string;
  pinned: boolean;
  expected_revision?: number | null;
  client_mutation_id?: string | null;
};

export type UpdateWorkspaceSettingsBody = {
  password: string;
  title: string;
};

export type MoveItemBody = {
  password: string;
  parent_id: string | null;
  expected_revision?: number | null;
  client_mutation_id?: string | null;
};

export type SearchBody = {
  password: string;
  query: string;
};

export type PatchBody = {
  password: string;
  find: string;
  replace?: string;
  dry_run?: boolean;
  expected_revision?: number | null;
  client_mutation_id?: string | null;
};

export type PatchResponse = {
  ok: boolean;
  workspace_id: string;
  item: WorkspaceItem;
  changed: boolean;
  preview_markdown: string;
};

export type RelayJoinBody = {
  password: string;
};

export type RelayJoinResponse = {
  ok: boolean;
  workspace_id: string;
  ticket: string;
  expires_at: string;
};

export type CollaborativeJoinBody = {
  password: string;
};

export type CollaborativeJoinResponse = {
  ok: boolean;
  workspace_id: string;
  item_id: string;
  ticket: string;
  expires_at: string;
};

/** Same shape as `@justwork/security` IdentityKeyPair — inlined to avoid circular workspace deps in types. */
export type SigningIdentity = {
  userId: string;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
};

export type BackendClientOptions = {
  baseUrl: string;
  getToken?: () => string | undefined;
  /** When set, mutating workspace writes include ECDSA P-256 signing envelope fields. */
  signingIdentity?: SigningIdentity;
};

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BackendApiError(res.status, "invalid_json", text.slice(0, 200));
  }
}

function isErrorPayload(v: unknown): v is BackendErrorBody {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as BackendErrorBody).ok === false &&
    typeof (v as BackendErrorBody).error?.code === "string"
  );
}

export function createBackendClient(opts: BackendClientOptions) {
  const base = normalizeBaseUrl(opts.baseUrl);

  const headers = (): HeadersInit => {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const t = opts.getToken?.();
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
  };

  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let outgoing: unknown = body;
    if (
      opts.signingIdentity &&
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      shouldSignWriteRequest(method, path)
    ) {
      const ws = parseWorkspaceIdFromApiPath(path);
      if (ws) {
        outgoing = await attachWriteSigningEnvelope(opts.signingIdentity, {
          method,
          path,
          workspaceId: ws,
          targetId: signingTargetIdForPath(path),
          body: body as Record<string, unknown>,
        });
      }
    }
    const res = await fetch(`${base}${path}`, {
      method,
      headers: headers(),
      body: outgoing === undefined ? undefined : JSON.stringify(outgoing),
    });
    const data = await parseJson(res);
    if (!res.ok) {
      if (isErrorPayload(data)) {
        throw new BackendApiError(res.status, data.error.code, data.error.message);
      }
      throw new BackendApiError(res.status, "http_error", `HTTP ${res.status}`);
    }
    return data as T;
  };

  const requestBytes = async (method: string, path: string, body?: unknown): Promise<Uint8Array> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await parseJson(res);
      if (isErrorPayload(data)) {
        throw new BackendApiError(res.status, data.error.code, data.error.message);
      }
      throw new BackendApiError(res.status, "http_error", `HTTP ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  };

  return {
    baseUrl: base,

    health(): Promise<{ ok: boolean; mode?: string }> {
      return request("GET", "/v1/health");
    },

    createWorkspace(
      body: CreateWorkspaceBody,
    ): Promise<{
      ok: boolean;
      workspace: WorkspaceSummary;
      workspace_title: string;
      active_item_id: string;
      items: WorkspaceTreeItem[];
    }> {
      return request("POST", "/v1/workspaces", body);
    },

    getWorkspace(workspaceId: string): Promise<{ ok: boolean; workspace: WorkspaceSummary | null }> {
      return request("GET", `/v1/workspaces/${encodeURIComponent(workspaceId)}`);
    },

    getTree(
      workspaceId: string,
      body: PasswordBody,
    ): Promise<{
      ok: boolean;
      workspace_id: string;
      workspace_title: string;
      active_item_id: string;
      items: WorkspaceTreeItem[];
    }> {
      return request("POST", `/v1/workspaces/${encodeURIComponent(workspaceId)}/tree`, body);
    },

    updateWorkspaceSettings(
      workspaceId: string,
      body: UpdateWorkspaceSettingsBody,
    ): Promise<{ ok: boolean; workspace_id: string; title: string }> {
      return request("PUT", `/v1/workspaces/${encodeURIComponent(workspaceId)}/settings`, body);
    },

    getItem(
      workspaceId: string,
      itemId: string,
      body: PasswordBody,
    ): Promise<{ ok: boolean; workspace_id: string; item: WorkspaceItem }> {
      return request(
        "POST",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}`,
        body,
      );
    },

    updateItem(
      workspaceId: string,
      itemId: string,
      body: UpdateItemBody,
    ): Promise<{ ok: boolean; workspace_id: string; item: WorkspaceItem }> {
      return request(
        "PUT",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}`,
        body,
      );
    },

    createItem(
      workspaceId: string,
      body: CreateItemBody,
    ): Promise<{ ok: boolean; workspace_id: string; item: WorkspaceItem }> {
      return request("POST", `/v1/workspaces/${encodeURIComponent(workspaceId)}/items`, body);
    },

    pinItem(
      workspaceId: string,
      itemId: string,
      body: PinItemBody,
    ): Promise<{ ok: boolean; workspace_id: string; item: WorkspaceItem }> {
      return request(
        "PUT",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/pin`,
        body,
      );
    },

    moveItem(
      workspaceId: string,
      itemId: string,
      body: MoveItemBody,
    ): Promise<{ ok: boolean; workspace_id: string; item: WorkspaceItem }> {
      return request(
        "PUT",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/move`,
        body,
      );
    },

    trashItem(
      workspaceId: string,
      itemId: string,
      body: PasswordBody,
    ): Promise<{ ok: boolean; workspace_id: string; item: WorkspaceItem }> {
      return request(
        "PUT",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/trash`,
        body,
      );
    },

    restoreItem(
      workspaceId: string,
      itemId: string,
      body: PasswordBody,
    ): Promise<{ ok: boolean; workspace_id: string; item: WorkspaceItem }> {
      return request(
        "PUT",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/restore`,
        body,
      );
    },

    hardDeleteItem(
      workspaceId: string,
      itemId: string,
      body: PasswordBody,
    ): Promise<{ ok: boolean; workspace_id: string; item: WorkspaceItem }> {
      return request(
        "POST",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/hard-delete`,
        body,
      );
    },

    search(
      workspaceId: string,
      body: SearchBody,
    ): Promise<{ ok: boolean; workspace_id: string; results: SearchResult[] }> {
      return request("POST", `/v1/workspaces/${encodeURIComponent(workspaceId)}/search`, body);
    },

    outline(
      workspaceId: string,
      itemId: string,
      body: PasswordBody,
    ): Promise<{ ok: boolean; workspace_id: string; item_id: string; headings: OutlineHeading[] }> {
      return request(
        "POST",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/outline`,
        body,
      );
    },

    patchItem(
      workspaceId: string,
      itemId: string,
      body: PatchBody,
    ): Promise<PatchResponse> {
      return request(
        "POST",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/patch`,
        body,
      );
    },

    createShareLink(
      workspaceId: string,
      itemId: string,
    ): Promise<{ ok: boolean; workspace_id: string; item_id: string; share_url: string }> {
      return request(
        "POST",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/share`,
      );
    },

    getProfile(workspaceId: string): Promise<{ ok: boolean; profile: ProfileBody }> {
      return request("GET", `/v1/workspaces/${encodeURIComponent(workspaceId)}/profile`);
    },

    listMembers(
      workspaceId: string,
      body: PasswordBody,
    ): Promise<{ ok: boolean; workspace_id: string; members: WorkspaceMemberBody[] }> {
      return request("POST", `/v1/workspaces/${encodeURIComponent(workspaceId)}/members`, body);
    },

    getQuota(workspaceId: string): Promise<{ ok: boolean; workspace_id: string; quota: WorkspaceQuotaBody }> {
      return request("GET", `/v1/workspaces/${encodeURIComponent(workspaceId)}/quota`);
    },

    updateProfile(
      workspaceId: string,
      body: { nickname: string; password?: string | null },
    ): Promise<{ ok: boolean; profile: ProfileBody }> {
      return request("PUT", `/v1/workspaces/${encodeURIComponent(workspaceId)}/profile`, body);
    },

    joinRelay(workspaceId: string, body: RelayJoinBody): Promise<RelayJoinResponse> {
      return request("POST", `/v1/workspaces/${encodeURIComponent(workspaceId)}/relay/join`, body);
    },

    joinCollaborativeMarkdown(
      workspaceId: string,
      itemId: string,
      body: CollaborativeJoinBody,
    ): Promise<CollaborativeJoinResponse> {
      return request(
        "POST",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/collab/join`,
        body,
      );
    },

    getCollaborativeMarkdownState(
      workspaceId: string,
      itemId: string,
      body: PasswordBody,
    ): Promise<Uint8Array> {
      return requestBytes(
        "POST",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/collab/state`,
        body,
      );
    },
  };
}

export type BackendClient = ReturnType<typeof createBackendClient>;
