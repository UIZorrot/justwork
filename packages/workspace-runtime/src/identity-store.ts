import { generateIdentity, type IdentityKeyPair } from "@justwork/security";
import { RUNTIME_STORAGE_KEYS, type RuntimeStorage } from "./storage.js";

export type StoredLocalIdentity = IdentityKeyPair & {
  createdAt: string;
};

export async function loadOrCreateLocalIdentity(
  storage: RuntimeStorage,
): Promise<StoredLocalIdentity> {
  const existing = await storage.get<StoredLocalIdentity>(RUNTIME_STORAGE_KEYS.IDENTITY);
  if (existing?.userId && existing.publicKeyJwk && existing.privateKeyJwk) {
    return existing;
  }

  const identity = await generateIdentity();
  const stored: StoredLocalIdentity = {
    ...identity,
    createdAt: new Date().toISOString(),
  };
  await storage.set(RUNTIME_STORAGE_KEYS.IDENTITY, stored);
  return stored;
}
