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
/** Character code of each of the 64 digits, and digit of each character code (255 = not in the alphabet). */
const B64_CODES = Uint8Array.from(B64_ALPHABET, (char) => char.charCodeAt(0));
const B64_LOOKUP = new Uint8Array(128).fill(255);
B64_CODES.forEach((code, index) => (B64_LOOKUP[code] = index));
const ASCII = new TextDecoder("latin1");

export function toB64(bytes: Uint8Array): B64 {
  const length = Math.ceil((bytes.length * 4) / 3);
  const out = new Uint8Array(length);
  let o = 0;
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out[o++] = B64_CODES[n >> 18]!;
    out[o++] = B64_CODES[(n >> 12) & 63]!;
    out[o++] = B64_CODES[(n >> 6) & 63]!;
    out[o++] = B64_CODES[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out[o++] = B64_CODES[n >> 18]!;
    out[o] = B64_CODES[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out[o++] = B64_CODES[n >> 18]!;
    out[o++] = B64_CODES[(n >> 12) & 63]!;
    out[o] = B64_CODES[(n >> 6) & 63]!;
  }
  return ASCII.decode(out);
}

/** Strict decoding: no padding, no whitespace, no standard-alphabet characters, canonical tail bits. */
interface NativeBase64 {
  fromBase64?: (
    text: string,
    options: { alphabet: "base64url"; lastChunkHandling: "loose" },
  ) => Uint8Array<ArrayBuffer>;
}
interface NativeEncoder {
  toBase64(options: { alphabet: "base64url"; omitPadding: true }): string;
}
const nativeFromBase64 = (Uint8Array as unknown as NativeBase64).fromBase64;

export function fromB64(text: B64): Bytes {
  if (nativeFromBase64 !== undefined) {
    // The browser's own decoder is several times faster. It is lenient (it skips whitespace, accepts padding and
    // stray tail bits), so what it returns is written back and must be the very same text: strictness is kept.
    let out: Uint8Array<ArrayBuffer>;
    try {
      out = nativeFromBase64.call(Uint8Array, text, { alphabet: "base64url", lastChunkHandling: "loose" });
    } catch {
      throw new SyntaxError("invalid base64url");
    }
    if ((out as unknown as NativeEncoder).toBase64({ alphabet: "base64url", omitPadding: true }) !== text) {
      throw new SyntaxError("invalid base64url");
    }
    return out;
  }
  return fromB64Js(text);
}

function fromB64Js(text: B64): Bytes {
  const length = text.length;
  if (length % 4 === 1) throw new SyntaxError("invalid base64url");
  const out = new Uint8Array(Math.floor((length * 3) / 4));
  const table = B64_LOOKUP;
  let bad = 0;
  let o = 0;
  let i = 0;
  // Characters are read as UTF-16 codes; anything outside the alphabet (or above 127) gives 255, which
  // sets a bit that valid digits (below 64) never set.
  for (; i + 3 < length; i += 4) {
    const c0 = text.charCodeAt(i);
    const c1 = text.charCodeAt(i + 1);
    const c2 = text.charCodeAt(i + 2);
    const c3 = text.charCodeAt(i + 3);
    const d0 = c0 < 128 ? table[c0]! : 255;
    const d1 = c1 < 128 ? table[c1]! : 255;
    const d2 = c2 < 128 ? table[c2]! : 255;
    const d3 = c3 < 128 ? table[c3]! : 255;
    bad |= d0 | d1 | d2 | d3;
    const n = (d0 << 18) | (d1 << 12) | (d2 << 6) | d3;
    out[o++] = (n >> 16) & 255;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  const digit = (k: number): number => {
    const code = text.charCodeAt(k);
    const d = code < 128 ? table[code]! : 255;
    bad |= d;
    return d;
  };
  const rest = length - i;
  if (rest === 2) {
    const n = (digit(i) << 18) | (digit(i + 1) << 12);
    if (n & 0xffff) throw new SyntaxError("invalid base64url");
    out[o] = (n >> 16) & 255;
  } else if (rest === 3) {
    const n = (digit(i) << 18) | (digit(i + 1) << 12) | (digit(i + 2) << 6);
    if (n & 0xff) throw new SyntaxError("invalid base64url");
    out[o] = (n >> 16) & 255;
    out[o + 1] = (n >> 8) & 255;
  }
  if (bad & 0xc0) throw new SyntaxError("invalid base64url");
  return out;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += HEX[byte]!;
  return out;
}

export function fromHex(text: string): Bytes {
  if (!/^(?:[0-9a-f]{2})*$/i.test(text)) throw new SyntaxError("invalid hex");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}
