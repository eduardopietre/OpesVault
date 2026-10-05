/**
 * The account login secret: what the browser sends instead of the account password.
 *
 *   loginSecret = base64url(HKDF(Argon2id(account password, loginSalt), info "opesvault/login/v1"))
 *
 * The server hashes it again before storing it (docs/19 §5). The account password is not the
 * project password: one opens the server account, the other opens the project's data.
 */
import { argon2id, DEFAULT_KDF, type KdfParams } from "./argon2.ts";
import { fromB64, toB64, utf8, wipe, type B64 } from "./bytes.ts";
import { CryptoError } from "./errors.ts";
import { hkdfBits, importHkdfKey } from "./primitives.ts";

export const LOGIN_SECRET_BYTES = 32;

/** Emails are compared trimmed and in lower case, on both sides. */
export function normalizeEmail(email: string): string {
  return email.normalize("NFC").trim().toLowerCase();
}

export async function deriveLoginSecret(
  accountPassword: string,
  loginSalt: B64,
  params: KdfParams = DEFAULT_KDF,
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
