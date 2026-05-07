export type WorkspaceEncryptedBox = {
  iv: string;
  ciphertext: string;
};

export type EncryptedWorkspacePayload = {
  version: 1;
  workspaceId: string;
  algorithm: "AES-GCM";
  kdf: {
    name: "PBKDF2";
    hash: "SHA-256";
    iterations: number;
    salt: string;
  };
  check: WorkspaceEncryptedBox;
  payload: WorkspaceEncryptedBox;
};

export type EncryptWorkspacePayloadInput = {
  workspaceId: string;
  plaintext: string;
  password: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CHECK_TEXT = "justwork";
const KDF_ITERATIONS = 120_000;

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

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  cryptoApi().getRandomValues(bytes);
  return bytes;
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function deriveWorkspaceKey(password: string, salt: string, iterations: number): Promise<CryptoKey> {
  const baseKey = await cryptoApi().subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return cryptoApi().subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64UrlToBuffer(salt),
      iterations,
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptBox(key: CryptoKey, plaintext: string): Promise<WorkspaceEncryptedBox> {
  const iv = randomBytes(12);
  const ciphertext = await cryptoApi().subtle.encrypt(
    { name: "AES-GCM", iv: exactBuffer(iv) },
    key,
    encoder.encode(plaintext),
  );
  return {
    iv: base64Url(exactBuffer(iv)),
    ciphertext: base64Url(ciphertext),
  };
}

async function decryptBox(key: CryptoKey, box: WorkspaceEncryptedBox): Promise<string> {
  const plaintext = await cryptoApi().subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBuffer(box.iv) },
    key,
    base64UrlToBuffer(box.ciphertext),
  );
  return decoder.decode(plaintext);
}

export async function encryptWorkspacePayload(
  input: EncryptWorkspacePayloadInput,
): Promise<EncryptedWorkspacePayload> {
  const salt = base64Url(exactBuffer(randomBytes(16)));
  const key = await deriveWorkspaceKey(input.password, salt, KDF_ITERATIONS);
  return {
    version: 1,
    workspaceId: input.workspaceId,
    algorithm: "AES-GCM",
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: KDF_ITERATIONS,
      salt,
    },
    check: await encryptBox(key, CHECK_TEXT),
    payload: await encryptBox(key, input.plaintext),
  };
}

export async function decryptWorkspacePayload(
  encrypted: EncryptedWorkspacePayload,
  password: string,
): Promise<string> {
  const key = await deriveWorkspaceKey(password, encrypted.kdf.salt, encrypted.kdf.iterations);
  try {
    const check = await decryptBox(key, encrypted.check);
    if (check !== CHECK_TEXT) {
      throw new Error("invalid workspace password");
    }
  } catch {
    throw new Error("invalid workspace password");
  }
  return decryptBox(key, encrypted.payload);
}
