/**
 * Stored login secrets (docs/19 §5): the browser already sent an Argon2id-derived secret; the
 * server hashes it again with scrypt and a per-account salt, and compares in constant time.
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const HASH_BYTES = 32;
const SALT_BYTES = 16;

function scryptAsync(secret: string, salt: Buffer, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, HASH_BYTES, { N: n, r: 8, p: 1, maxmem: 256 * n * 8 + 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashLoginSecret(secret: string, n: number): Promise<{ hash: Buffer; salt: Buffer }> {
  const salt = randomBytes(SALT_BYTES);
  return { hash: await scryptAsync(secret, salt, n), salt };
}

/** Always runs scrypt, also for unknown accounts (`stored` null), so timing does not reveal them. */
export async function verifyLoginSecret(
  secret: string,
  stored: { hash: Buffer; salt: Buffer } | null,
  n: number,
): Promise<boolean> {
  const salt = stored?.salt ?? randomBytes(SALT_BYTES);
  const candidate = await scryptAsync(secret, salt, n);
  if (stored === null || stored.hash.length !== candidate.length) return false;
  return timingSafeEqual(candidate, stored.hash);
}

/** Session tokens are stored as SHA-256: a copy of the database does not hand out sessions. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}
