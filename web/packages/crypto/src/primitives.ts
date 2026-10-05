/**
 * The WebCrypto primitives the vault uses: HKDF-SHA256, AES-256-GCM and HMAC-SHA256.
 *
 * Keys are imported or derived as non-extractable CryptoKeys: once a key exists as a CryptoKey,
 * script code (ours or injected) cannot read its bytes back, only use it while the tab holds it.
 * Nothing here is home-made cryptography (docs/03 §2, docs/19 §3).
 */
import { concatBytes, copyBytes, type Bytes } from "./bytes.ts";
import { CryptoError } from "./errors.ts";
import { systemRandom, type RandomSource } from "./random.ts";

export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

function subtle(): SubtleCrypto {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error("WebCrypto unavailable (a secure context is required)");
  return value;
}

/** Imports high-entropy input keying material for HKDF. The bytes are not kept by the key object. */
export function importHkdfKey(ikm: Bytes): Promise<CryptoKey> {
  return subtle().importKey("raw", ikm, "HKDF", false, ["deriveKey", "deriveBits"]);
}

export function importAesKey(raw: Bytes): Promise<CryptoKey> {
  return subtle().importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export function importHmacKey(raw: Bytes): Promise<CryptoKey> {
  return subtle().importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

const EMPTY: Bytes = new Uint8Array(0);

function hkdfParams(salt: Bytes, info: Bytes): HkdfParams {
  return { name: "HKDF", hash: "SHA-256", salt, info };
}

/** HKDF-SHA256 to raw bits (used for the login secret and known-answer tests). */
export async function hkdfBits(base: CryptoKey, info: Bytes, length: number, salt: Bytes = EMPTY): Promise<Bytes> {
  const bits = await subtle().deriveBits(hkdfParams(salt, info), base, length * 8);
  return new Uint8Array(bits);
}

/** HKDF-SHA256 to a non-extractable AES-256-GCM key. */
export function hkdfAesKey(base: CryptoKey, info: Bytes, salt: Bytes = EMPTY): Promise<CryptoKey> {
  return subtle().deriveKey(hkdfParams(salt, info), base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** HKDF-SHA256 to a non-extractable HMAC-SHA256 key. */
export function hkdfHmacKey(base: CryptoKey, info: Bytes, salt: Bytes = EMPTY): Promise<CryptoKey> {
  return subtle().deriveKey(hkdfParams(salt, info), base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, [
    "sign",
  ]);
}

export async function hmac(key: CryptoKey, data: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle().sign("HMAC", key, data));
}

/** AES-256-GCM with an explicit nonce. Returns ciphertext || tag. */
export async function aesGcmEncrypt(key: CryptoKey, nonce: Bytes, plaintext: Bytes, aad: Bytes): Promise<Bytes> {
  const out = await subtle().encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
    key,
    plaintext,
  );
  return new Uint8Array(out);
}

/** AES-256-GCM decryption; any failure (wrong key, altered bytes, other AAD) is `decrypt_failed`. */
export async function aesGcmDecrypt(key: CryptoKey, nonce: Bytes, sealed: Bytes, aad: Bytes): Promise<Bytes> {
  try {
    const out = await subtle().decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
      key,
      sealed,
    );
    return new Uint8Array(out);
  } catch {
    throw new CryptoError("decrypt_failed");
  }
}

/**
 * The common sealed form: version byte || random 12-byte nonce || ciphertext || tag.
 * The version byte is also bound into the AAD so that it cannot be swapped.
 */
export async function seal(
  key: CryptoKey,
  plaintext: Bytes,
  aad: Bytes,
  version: number,
  random: RandomSource = systemRandom,
): Promise<Bytes> {
  const header = Uint8Array.of(version);
  const nonce = random(NONCE_BYTES);
  const body = await aesGcmEncrypt(key, nonce, plaintext, concatBytes(header, aad));
  return concatBytes(header, nonce, body);
}

export async function open(key: CryptoKey, sealed: Uint8Array, aad: Bytes, version: number): Promise<Bytes> {
  if (sealed.length < 1 + NONCE_BYTES + TAG_BYTES || sealed[0] !== version) throw new CryptoError("invalid_format");
  const nonce = copyBytes(sealed.subarray(1, 1 + NONCE_BYTES));
  const body = copyBytes(sealed.subarray(1 + NONCE_BYTES));
  return aesGcmDecrypt(key, nonce, body, concatBytes(Uint8Array.of(version), aad));
}
