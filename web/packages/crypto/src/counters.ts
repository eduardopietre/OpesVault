/** Big-endian counters for associated data and nonces of chunked encryption (backups, blobs). */
import type { Bytes } from "./bytes.ts";

/** `value` as 4 big-endian bytes. */
export function u32(value: number): Bytes {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

/** A 12-byte AES-GCM nonce holding `index` in its last 4 bytes (big-endian); only for single-use keys. */
export function counterNonce(index: number): Bytes {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setUint32(8, index);
  return out;
}
