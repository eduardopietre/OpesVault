/**
 * The recovery key: 160 random bits shown once, in Crockford base32 groups of four, plus one
 * check group so that a typo reads as "mistyped" and not as "wrong key".
 *
 * Example: `7K3M-QX9D-…-H2P4` (nine groups: eight of key, one of check).
 * Parsing is lenient: lower case, spaces and dashes are accepted, O reads as 0, I and L as 1.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8, wipe, type Bytes } from "./bytes.ts";
import { CryptoError } from "./errors.ts";
import { systemRandom, type RandomSource } from "./random.ts";

export const RECOVERY_KEY_BYTES = 20;
const KEY_CHARS = 32;
const CHECK_CHARS = 4;
const GROUP = 4;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CHECK_LABEL = utf8("opesvault/recovery-check/v1");

function encodeBase32(bytes: Uint8Array, chars: number): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  let index = 0;
  while (out.length < chars) {
    if (bits < 5) {
      buffer = (buffer << 8) | (index < bytes.length ? bytes[index]! : 0);
      index += 1;
      bits += 8;
    }
    out += ALPHABET[(buffer >> (bits - 5)) & 31]!;
    bits -= 5;
    buffer &= (1 << bits) - 1;
  }
  return out;
}

function decodeBase32(text: string, length: number): Bytes {
  const out = new Uint8Array(length);
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (const char of text) {
    buffer = (buffer << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out[o++] = (buffer >> (bits - 8)) & 255;
      bits -= 8;
      buffer &= (1 << bits) - 1;
    }
  }
  return out;
}

function checkGroup(key: Uint8Array): string {
  const digest = sha256(concatBytes(CHECK_LABEL, key));
  const group = encodeBase32(digest, CHECK_CHARS);
  wipe(digest);
  return group;
}

function grouped(text: string): string {
  const groups: string[] = [];
  for (let i = 0; i < text.length; i += GROUP) groups.push(text.slice(i, i + GROUP));
  return groups.join("-");
}

/** Renders 20 key bytes as the text the user writes down. */
export function formatRecoveryKey(key: Uint8Array): string {
  if (key.length !== RECOVERY_KEY_BYTES) throw new CryptoError("invalid_recovery_key");
  return grouped(encodeBase32(key, KEY_CHARS) + checkGroup(key));
}

export function generateRecoveryKey(random: RandomSource = systemRandom): { bytes: Bytes; text: string } {
  const bytes = random(RECOVERY_KEY_BYTES);
  return { bytes, text: formatRecoveryKey(bytes) };
}

/** Normalizes what the user typed; throws `invalid_recovery_key` on any mistake. */
export function parseRecoveryKey(input: string): Bytes {
  const text = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (text.length !== KEY_CHARS + CHECK_CHARS || ![...text].every((char) => ALPHABET.includes(char))) {
    throw new CryptoError("invalid_recovery_key");
  }
  const keyText = text.slice(0, KEY_CHARS);
  const key = decodeBase32(keyText, RECOVERY_KEY_BYTES);
  if (encodeBase32(key, KEY_CHARS) !== keyText || checkGroup(key) !== text.slice(KEY_CHARS)) {
    wipe(key);
    throw new CryptoError("invalid_recovery_key");
  }
  return key;
}
