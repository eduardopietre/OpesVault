/**
 * The account login secret: what the browser sends instead of the account password.
 *
 *   loginSecret = base64url(HKDF(Argon2id(account password, loginSalt), info "opesvault/login/v1"))
 *
 * The server hashes it again before storing it (docs/19 §5). The account password is not the
 * project password: one opens the server account, the other opens the project's data.
 */
import { argon2id, type KdfParams } from "./argon2.ts";
import { fromB64, toB64, utf8, wipe, type B64 } from "./bytes.ts";
import { CryptoError } from "./errors.ts";
import { hkdfBits, importHkdfKey } from "./primitives.ts";

export const LOGIN_SECRET_BYTES = 32;

/**
 * Argon2id parameters of the login secret, fixed for "opesvault/login/v1". Unlike an envelope or a backup, the
 * server keeps nothing that says which parameters an account used: raising these would change every login secret
 * and lock every account out. They are not `DEFAULT_KDF`, which may go up for new envelopes and backups; stronger
 * login parameters need a new version (stored per account, with a migration at sign-in).
 */
export const LOGIN_KDF: KdfParams = Object.freeze({
  algorithm: "argon2id",
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 1,
});

/** Emails are compared trimmed and in lower case, on both sides. */
export function normalizeEmail(email: string): string {
  return email.normalize("NFC").trim().toLowerCase();
}

export async function deriveLoginSecret(
  accountPassword: string,
  loginSalt: B64,
  params: KdfParams = LOGIN_KDF,
): Promise<B64> {
  let salt;
  try {
    salt = fromB64(loginSalt);
  } catch {
    throw new CryptoError("invalid_format");
  }
  const stretched = await argon2id(accountPassword, salt, params);
  try {
    const bits = await hkdfBits(await importHkdfKey(stretched), utf8("opesvault/login/v1"), LOGIN_SECRET_BYTES);
    const secret = toB64(bits);
    wipe(bits);
    return secret;
  } finally {
    wipe(stretched);
  }
}
