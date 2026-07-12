export type IdentityKeyPair = {
  userId: string;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
};

export type SignedPayload<T extends Record<string, unknown>> = {
  payload: T;
  signature: string;
};

const encoder = new TextEncoder();

function cryptoApi(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto API is not available");
  }
  return globalThis.crypto;
}

function base64Url(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBuffer(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** Lexicographic JSON for stable hashing (matches Backend Python `canonical_json`). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function importPrivateKey(privateKeyJwk: JsonWebKey): Promise<CryptoKey> {
  return cryptoApi().subtle.importKey(
    "jwk",
    privateKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

async function importPublicKey(publicKeyJwk: JsonWebKey): Promise<CryptoKey> {
  return cryptoApi().subtle.importKey(
    "jwk",
    publicKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

export async function generateIdentity(): Promise<IdentityKeyPair> {
  const pair = await cryptoApi().subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyJwk = await cryptoApi().subtle.exportKey("jwk", pair.publicKey);
  const privateKeyJwk = await cryptoApi().subtle.exportKey("jwk", pair.privateKey);
  const publicHash = await cryptoApi().subtle.digest("SHA-256", encoder.encode(canonicalJson(publicKeyJwk)));

  return {
    userId: `user_${base64Url(publicHash)}`,
    publicKeyJwk,
    privateKeyJwk,
  };
}

export async function signPayload<T extends Record<string, unknown>>(
  privateKeyJwk: JsonWebKey,
  payload: T,
): Promise<SignedPayload<T>> {
  const key = await importPrivateKey(privateKeyJwk);
  const signature = await cryptoApi().subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(canonicalJson(payload)),
  );
  return { payload, signature: base64Url(signature) };
}

/** ECDSA (P-256, SHA-256) over raw UTF-8 message bytes — used for HTTP write signing. */
export async function signUtf8Message(privateKeyJwk: JsonWebKey, message: string): Promise<string> {
  const key = await importPrivateKey(privateKeyJwk);
  const signature = await cryptoApi().subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(message),
  );
  return base64Url(signature);
}

/** Fields excluded when hashing request bodies for `body_hash`. */
export const WRITE_SIGNING_FIELD_NAMES = [
  "actor_user_id",
  "public_key",
  "signature",
  "nonce",
  "timestamp",
  "body_hash",
] as const;

export async function sha256HexOfUtf8(text: string): Promise<string> {
  const buf = await cryptoApi().subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 hex of canonical JSON of `body` after removing signing envelope keys. */
export async function computeWriteBodyHash(body: Record<string, unknown>): Promise<string> {
  const stripped: Record<string, unknown> = { ...body };
  for (const k of WRITE_SIGNING_FIELD_NAMES) {
    delete stripped[k];
  }
  for (const [key, value] of Object.entries(stripped)) {
    if (value === null || value === undefined) {
      delete stripped[key];
    }
  }
  return sha256HexOfUtf8(canonicalJson(stripped));
}

/** Canonical line-separated message signed for Backend write verification. */
export function buildWriteSigningMessage(params: {
  method: string;
  path: string;
  workspaceId: string;
  targetId: string;
  bodyHash: string;
  nonce: string;
  timestamp: string;
}): string {
  const { method, path, workspaceId, targetId, bodyHash, nonce, timestamp } = params;
  return [method.toUpperCase(), path, workspaceId, targetId, bodyHash, nonce, timestamp].join("\n");
}

export async function verifyPayloadSignature<T extends Record<string, unknown>>(
  publicKeyJwk: JsonWebKey,
  payload: T,
  signature: string,
): Promise<boolean> {
  const key = await importPublicKey(publicKeyJwk);
  return cryptoApi().subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    base64UrlToBuffer(signature),
    encoder.encode(canonicalJson(payload)),
  );
}
