/**
 * Argon2id for passwords (hash-wasm, the reference algorithm compiled to WebAssembly).
 *
 * Parameters adopted provisionally (docs/18 §8, docs/19 §3): 64 MiB, 3 passes, 1 lane, 32 bytes.
 * They travel with each envelope, so they can be raised later without breaking old envelopes.
 */
import { argon2id as wasmArgon2id } from "hash-wasm";
import { copyBytes, utf8, wipe, type Bytes } from "./bytes.ts";
import { CryptoError } from "./errors.ts";

export interface KdfParams {
  readonly algorithm: "argon2id";
  readonly memoryKiB: number;
  readonly iterations: number;
  readonly parallelism: number;
}

export const DEFAULT_KDF: KdfParams = { algorithm: "argon2id", memoryKiB: 65536, iterations: 3, parallelism: 1 };

/**
 * Accepted range. The floor keeps an envelope from asking for trivially weak parameters; the
 * ceiling keeps a hostile envelope from exhausting the tab's memory or time.
 */
export const KDF_LIMITS = {
  minMemoryKiB: 8192,
  maxMemoryKiB: 1048576,
  minIterations: 1,
  maxIterations: 16,
  maxParallelism: 4,
} as const;

export const SALT_BYTES = 16;
export const ARGON2_OUTPUT_BYTES = 32;

export function checkKdfParams(params: KdfParams): void {
  const ok =
    params.algorithm === "argon2id" &&
    Number.isSafeInteger(params.memoryKiB) &&
    params.memoryKiB >= KDF_LIMITS.minMemoryKiB &&
    params.memoryKiB <= KDF_LIMITS.maxMemoryKiB &&
    Number.isSafeInteger(params.iterations) &&
    params.iterations >= KDF_LIMITS.minIterations &&
    params.iterations <= KDF_LIMITS.maxIterations &&
    Number.isSafeInteger(params.parallelism) &&
    params.parallelism >= 1 &&
    params.parallelism <= KDF_LIMITS.maxParallelism &&
    params.memoryKiB >= 8 * params.parallelism;
  if (!ok) throw new CryptoError("invalid_params");
}

/**
 * Passwords are normalized to Unicode NFC before encoding, so that the same password typed on
 * different systems (composed or decomposed accents) gives the same key.
 */
export function passwordBytes(password: string): Bytes {
  return utf8(password.normalize("NFC"));
}

export async function argon2id(password: string, salt: Bytes, params: KdfParams): Promise<Bytes> {
  checkKdfParams(params);
  if (salt.length < SALT_BYTES) throw new CryptoError("invalid_params");
  if (password.length === 0) throw new CryptoError("empty_password");
  const secret = passwordBytes(password);
  try {
    const out = await wasmArgon2id({
      password: secret,
      salt,
      iterations: params.iterations,
      parallelism: params.parallelism,
      memorySize: params.memoryKiB,
      hashLength: ARGON2_OUTPUT_BYTES,
      outputType: "binary",
    });
    const result = copyBytes(out);
    wipe(out);
    return result;
  } finally {
    wipe(secret);
  }
}
