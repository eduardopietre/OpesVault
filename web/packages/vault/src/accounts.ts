/**
 * Server accounts (docs/19 §5). The account password never leaves the browser: it is stretched
 * with Argon2id over the server's public login salt and only the derived login secret is sent.
 *
 * The account password opens the server account; the project password (shared by the members)
 * opens the project's data. They are different secrets.
 */
import { CryptoError, deriveLoginSecret, normalizeEmail, type KdfParams } from "@opesvault/crypto";
import type { AccountSession, SyncBackend } from "./backend.ts";
import { VaultError } from "./project_vault.ts";

async function loginSecret(backend: SyncBackend, email: string, password: string, kdf?: KdfParams): Promise<string> {
  if (password.length === 0) throw new VaultError("empty_password");
  const salt = await backend.loginSalt(email);
  try {
    return await deriveLoginSecret(password, salt, kdf);
  } catch (error) {
    if (error instanceof CryptoError && error.code === "empty_password") throw new VaultError("empty_password");
    throw error;
  }
}

/** Creates the account and signs in. `kdf` is for tests only. */
export async function signUp(
  backend: SyncBackend,
  email: string,
  accountPassword: string,
  kdf?: KdfParams,
): Promise<AccountSession> {
  const normalized = normalizeEmail(email);
  return backend.signUp(normalized, await loginSecret(backend, normalized, accountPassword, kdf));
}

export async function signIn(
  backend: SyncBackend,
  email: string,
  accountPassword: string,
  kdf?: KdfParams,
): Promise<AccountSession> {
  const normalized = normalizeEmail(email);
  return backend.signIn(normalized, await loginSecret(backend, normalized, accountPassword, kdf));
}

/**
 * Whether the browser keeps this site's storage under pressure, asking for it when it is not yet granted:
 * "denied" means it may erase IndexedDB, and with it changes not yet sent; "unavailable" when it cannot say.
 */
export async function persistentStorage(): Promise<"persisted" | "denied" | "unavailable"> {
  const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage;
  if (storage === undefined || typeof storage.persist !== "function") return "unavailable";
  try {
    if (typeof storage.persisted === "function" && (await storage.persisted())) return "persisted";
    return (await storage.persist()) ? "persisted" : "denied";
  } catch {
    return "unavailable";
  }
}
