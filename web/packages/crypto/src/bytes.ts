/**
 * Byte helpers: UTF-8, base64url, hex, wiping.
 *
 * `Bytes` is a Uint8Array backed by a plain ArrayBuffer, which is what WebCrypto accepts.
 */

export type Bytes = Uint8Array<ArrayBuffer>;

/** Base64url text (RFC 4648 §5) without padding. */
export type B64 = string;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(text: string): Bytes {
  return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** A copy of any Uint8Array as `Bytes`. */
export function copyBytes(bytes: Uint8Array): Bytes {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

export function concatBytes(...parts: readonly Uint8Array[]): Bytes {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Overwrites bytes we own with zeros. JavaScript gives no guarantee that no other copy exists
 * (the engine may have moved or copied the buffer); this only shortens the life of this copy.
 */
export function wipe(...arrays: readonly (Uint8Array | null | undefined)[]): void {
  for (const array of arrays) array?.fill(0);
}

/** Equality that does not stop at the first difference. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_LOOKUP = new Map<string, number>([...B64_ALPHABET].map((char, index) => [char, index]));
const B64_PATTERN = /^[A-Za-z0-9_-]*$/;

function b64char(n: number): string {
  return B64_ALPHABET[n & 63]!;
}

export function toB64(bytes: Uint8Array): B64 {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += b64char(n >> 18) + b64char(n >> 12) + b64char(n >> 6) + b64char(n);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += b64char(n >> 18) + b64char(n >> 12);
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += b64char(n >> 18) + b64char(n >> 12) + b64char(n >> 6);
  }
  return out;
}

/** Strict decoding: no padding, no whitespace, no standard-alphabet characters, canonical tail bits. */
export function fromB64(text: B64): Bytes {
  if (!B64_PATTERN.test(text) || text.length % 4 === 1) throw new SyntaxError("invalid base64url");
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  const at = (k: number): number => B64_LOOKUP.get(text[k]!)!;
  let o = 0;
  let i = 0;
  for (; i + 3 < text.length; i += 4) {
    const n = (at(i) << 18) | (at(i + 1) << 12) | (at(i + 2) << 6) | at(i + 3);
    out[o++] = (n >> 16) & 255;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  const rest = text.length - i;
  if (rest === 2) {
    const n = (at(i) << 18) | (at(i + 1) << 12);
    if (n & 0xffff) throw new SyntaxError("invalid base64url");
    out[o] = (n >> 16) & 255;
  } else if (rest === 3) {
    const n = (at(i) << 18) | (at(i + 1) << 12) | (at(i + 2) << 6);
    if (n & 0xff) throw new SyntaxError("invalid base64url");
    out[o] = (n >> 16) & 255;
    out[o + 1] = (n >> 8) & 255;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(text: string): Bytes {
  if (!/^(?:[0-9a-f]{2})*$/i.test(text)) throw new SyntaxError("invalid hex");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}
