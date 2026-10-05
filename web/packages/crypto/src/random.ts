/**
 * Randomness. Production code always uses the system generator; the parameter exists so that
 * tests can produce known-answer vectors with fixed salts and nonces.
 */
import { toHex, type Bytes } from "./bytes.ts";

export type RandomSource = (length: number) => Bytes;

const MAX_CHUNK = 65536;

export const systemRandom: RandomSource = (length) => {
  const out = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += MAX_CHUNK) {
    globalThis.crypto.getRandomValues(out.subarray(offset, Math.min(length, offset + MAX_CHUNK)));
  }
  return out;
};

/** 128 random bits as 32 lowercase hex characters: project, blob and lease ids. */
export function randomId(random: RandomSource = systemRandom): string {
  return toHex(random(16));
}

/** Ids the server and the client exchange: 32 lowercase hex characters. */
export const ID_PATTERN = /^[0-9a-f]{32}$/;
