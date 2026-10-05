import type { Bytes, KdfParams, RandomSource } from "../src/index.ts";

/** Light Argon2id parameters so that tests run fast (production uses DEFAULT_KDF). */
export const TEST_KDF: KdfParams = { algorithm: "argon2id", memoryKiB: 8192, iterations: 1, parallelism: 1 };

/** Deterministic "randomness" for known-answer vectors: never used outside tests. */
export function counterRandom(seed = 0): RandomSource {
  let next = seed;
  return (length: number): Bytes => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = next & 255;
      next += 1;
    }
    return out;
  };
}

export function flipBit(text: string, index: number): string {
  const chars = [...text];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const at = alphabet.indexOf(chars[index]!);
  chars[index] = alphabet[at ^ 1]!;
  return chars.join("");
}
