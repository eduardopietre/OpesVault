/** Entity identifiers: lowercase canonical UUID strings, as the desktop persisted them. */
import { sha1 } from "@noble/hashes/legacy.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export type Id = string;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isId(text: string): boolean {
  return UUID_PATTERN.test(text);
}

/** A random (version 4) id. */
export function newId(): Id {
  return globalThis.crypto.randomUUID();
}

function format(h: string): Id {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Python's `uuid5(namespace, name)`: a stable id derived from a name. */
export function uuid5(namespace: Id, name: string): Id {
  const ns = namespace.replaceAll("-", "");
  const nsBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) nsBytes[i] = Number.parseInt(ns.slice(i * 2, i * 2 + 2), 16);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(16 + nameBytes.length);
  input.set(nsBytes);
  input.set(nameBytes, 16);
  const digest = sha1(input).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  return format(bytesToHex(digest));
}
