import type { IdentityKeyPair } from "@justwork/security";
import {
  buildWriteSigningMessage,
  computeWriteBodyHash,
  signUtf8Message,
} from "@justwork/security";

/** Extract `workspace_*` from `/v1/workspaces/{id}/...`. */
export function parseWorkspaceIdFromApiPath(path: string): string | null {
  const m = path.match(/^\/v1\/workspaces\/([^/]+)(?:\/|$)/);
  return m ? m[1] : null;
}

/**
 * target_id for canonical signing string (must match Backend).
 * create item → `""`; profile → `profile`; revert → `event_id`; otherwise primary item id segment.
 */
export function signingTargetIdForPath(path: string): string {
  if (/\/v1\/workspaces\/[^/]+\/profile$/.test(path)) return "profile";
  if (/\/v1\/workspaces\/[^/]+\/settings$/.test(path)) return "settings";
  if (/\/v1\/workspaces\/[^/]+\/password$/.test(path)) return "password";
  if (/\/v1\/workspaces\/[^/]+\/items$/.test(path)) return "";
  const itemAction = path.match(
    /\/v1\/workspaces\/[^/]+\/items\/([^/]+)\/(?:pin|move|trash|restore|patch|hard-delete)$/,
  );
  if (itemAction) return itemAction[1];
  const itemOnly = path.match(/\/v1\/workspaces\/[^/]+\/items\/([^/]+)$/);
  if (itemOnly) return itemOnly[1];
  return "";
}

/** Whether this HTTP call should carry an optional write signature (mutating workspace writes). */
export function shouldSignWriteRequest(method: string, path: string): boolean {
  if (method !== "PUT" && method !== "POST") return false;
  if (path === "/v1/workspaces" && method === "POST") return false;
  if (/\/v1\/workspaces\/[^/]+\/tree$/.test(path)) return false;
  if (/\/search$/.test(path)) return false;
  if (/\/outline$/.test(path)) return false;
  // Read single item: POST .../items/{id} with no extra segments
  if (method === "POST" && /\/v1\/workspaces\/[^/]+\/items\/[^/]+$/.test(path)) return false;
  if (/\/v1\/workspaces\/[^/]+\/profile$/.test(path) && method === "PUT") return true;
  if (/\/v1\/workspaces\/[^/]+\/settings$/.test(path) && method === "PUT") return true;
  if (/\/v1\/workspaces\/[^/]+\/password$/.test(path) && method === "PUT") return true;
  if (/\/items\/[^/]+\/patch$/.test(path) && method === "POST") return true;
  if (/\/items\/[^/]+\/hard-delete$/.test(path) && method === "POST") return true;
  if (/\/v1\/workspaces\/[^/]+\/items$/.test(path) && method === "POST") return true;
  if (/\/v1\/workspaces\/[^/]+\/items\/[^/]+$/.test(path) && method === "PUT") return true;
  if (
    method === "PUT" &&
    /\/items\/[^/]+\/(?:pin|move|trash|restore)$/.test(path)
  )
    return true;
  return false;
}

export async function attachWriteSigningEnvelope(
  identity: IdentityKeyPair,
  params: {
    method: string;
    /** Absolute path beginning with `/v1/` including workspace id segments (must match server `request.url.path`). */
    path: string;
    workspaceId: string;
    targetId: string;
    /** Serializable JSON body fields including password / nickname etc.; signing keys stripped before hashing. */
    body: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const bodyHash = await computeWriteBodyHash(params.body);
  const nonce = globalThis.crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const message = buildWriteSigningMessage({
    method: params.method,
    path: params.path,
    workspaceId: params.workspaceId,
    targetId: params.targetId,
    bodyHash,
    nonce,
    timestamp,
  });
  const signature = await signUtf8Message(identity.privateKeyJwk, message);
  return {
    ...params.body,
    actor_user_id: identity.userId,
    public_key: identity.publicKeyJwk,
    signature,
    nonce,
    timestamp,
    body_hash: bodyHash,
  };
}
