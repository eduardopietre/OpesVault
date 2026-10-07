/**
 * The keys derived from an open project key: records, opaque record ids, the project's name and
 * attachment keys. All of them are non-extractable CryptoKeys; the raw project key itself is only
 * held for the moment it takes to derive them (docs/19 §3).
 */
import { concatBytes, copyBytes, fromB64, fromUtf8, toB64, toHex, utf8, wipe, type B64, type Bytes } from "./bytes.ts";
import { gunzip, gzip } from "./compress.ts";
import { counterNonce, u32 } from "./counters.ts";
import { CryptoError } from "./errors.ts";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  hkdfAesKey,
  hkdfHmacKey,
  hmac,
  importAesKey,
  importHkdfKey,
  KEY_BYTES,
  open,
  seal,
  TAG_BYTES,
} from "./primitives.ts";
import { systemRandom, type RandomSource } from "./random.ts";

/** A record as the app sees it: the persisted `(kind, id, JSON)` of the Ledger (docs/18 §2). */
export interface PlainRecord {
  readonly kind: string;
  readonly id: string;
  readonly payload: unknown;
}

export const INFO = {
  records: "opesvault/records/v1",
  recordId: "opesvault/record-id/v1",
  name: "opesvault/project-name/v1",
  blobKey: "opesvault/blob-key/v1",
  deviceSnapshot: "opesvault/device-snapshot/v1",
} as const;

const RECORD_VERSION = 1;
const NAME_VERSION = 1;
const BLOB_KEY_VERSION = 1;
/** 2: the plaintext is gzip-compressed before sealing (1, uncompressed, is no longer opened: it is rewritten). */
const SNAPSHOT_VERSION = 2;
/** Plaintext is padded with JSON whitespace to a multiple of this, to blur exact sizes. */
export const RECORD_PADDING = 64;
export const OPAQUE_ID_CHARS = 32;

export const BLOB_MAGIC = utf8("OVB1");
export const BLOB_CHUNK_BYTES = 1024 * 1024;
const BLOB_HEADER_BYTES = 4 + 4 + 1 + 12 + KEY_BYTES + TAG_BYTES;

function checkRecordRef(kind: string, id: string): void {
  if (typeof kind !== "string" || typeof id !== "string" || kind.length === 0 || id.length === 0) {
    throw new TypeError("record kind and id must be non-empty strings");
  }
  if (kind.includes("\n")) throw new TypeError("record kind cannot contain a line break");
}

function recordAad(projectId: string, opaqueId: string): Bytes {
  return utf8(`opesvault/record/v1|${projectId}|${opaqueId}`);
}

function padded(text: string): Bytes {
  const raw = utf8(text);
  const length = Math.ceil((raw.length + 1) / RECORD_PADDING) * RECORD_PADDING;
  const out = new Uint8Array(length).fill(0x20);
  out.set(raw);
  wipe(raw);
  return out;
}

/** Chunk nonces are counters: every blob has its own random key, so a counter never repeats under a key. */
const chunkNonce = counterNonce;

function chunkAad(projectId: string, blobId: string, index: number, final: boolean, chunkBytes: number): Bytes {
  return utf8(`opesvault/blob/v1|${projectId}|${blobId}|${index}|${final ? 1 : 0}|${chunkBytes}`);
}

export class ProjectKeys {
  readonly projectId: string;
  #records: CryptoKey | null;
  #recordIds: CryptoKey | null;
  #name: CryptoKey | null;
  #blobKeys: CryptoKey | null;
  #snapshot: CryptoKey | null;

  private constructor(
    projectId: string,
    records: CryptoKey,
    recordIds: CryptoKey,
    name: CryptoKey,
    blobs: CryptoKey,
    snapshot: CryptoKey,
  ) {
    this.projectId = projectId;
    this.#records = records;
    this.#recordIds = recordIds;
    this.#name = name;
    this.#blobKeys = blobs;
    this.#snapshot = snapshot;
  }

  /** Derives the working keys from the raw project key. The caller still owns (and wipes) `raw`. */
  static async fromProjectKey(projectId: string, raw: Bytes): Promise<ProjectKeys> {
    if (raw.length !== KEY_BYTES) throw new CryptoError("invalid_format");
    const base = await importHkdfKey(raw);
    const [records, recordIds, name, blobs, snapshot] = await Promise.all([
      hkdfAesKey(base, utf8(INFO.records)),
      hkdfHmacKey(base, utf8(INFO.recordId)),
      hkdfAesKey(base, utf8(INFO.name)),
      hkdfAesKey(base, utf8(INFO.blobKey)),
      hkdfAesKey(base, utf8(INFO.deviceSnapshot)),
    ]);
    return new ProjectKeys(projectId, records, recordIds, name, blobs, snapshot);
  }

  get destroyed(): boolean {
    return this.#records === null;
  }

  /** Drops every key reference. The CryptoKeys become unreachable from here on. */
  destroy(): void {
    this.#records = null;
    this.#recordIds = null;
    this.#name = null;
    this.#blobKeys = null;
    this.#snapshot = null;
  }

  #key(key: CryptoKey | null): CryptoKey {
    if (key === null) throw new Error("project keys were destroyed (locked)");
    return key;
  }

  /** HMAC-SHA256(recordIdKey, kind + "\n" + id), hex, first 32 characters. */
  async opaqueId(kind: string, id: string): Promise<string> {
    checkRecordRef(kind, id);
    const mac = await hmac(this.#key(this.#recordIds), utf8(`${kind}\n${id}`));
    return toHex(mac).slice(0, OPAQUE_ID_CHARS);
  }

  async sealRecord(record: PlainRecord, random: RandomSource = systemRandom): Promise<{ id: string; ciphertext: B64 }> {
    const key = this.#key(this.#records);
    const id = await this.opaqueId(record.kind, record.id);
    const text = JSON.stringify({ kind: record.kind, id: record.id, payload: record.payload });
    if (text === undefined) throw new TypeError("record is not JSON");
    const plaintext = padded(text);
    try {
      const sealed = await seal(key, plaintext, recordAad(this.projectId, id), RECORD_VERSION, random);
      return { id, ciphertext: toB64(sealed) };
    } finally {
      wipe(plaintext);
    }
  }

  /**
   * Opens a record stored under `opaqueId`. Fails if the bytes were altered, belong to another
   * record or project, or if the record inside does not hash to this opaque id.
   */
  async openRecord(opaqueId: string, ciphertext: B64): Promise<PlainRecord> {
    return openSealedRecord(this.projectId, this.#key(this.#records), this.#key(this.#recordIds), opaqueId, ciphertext);
  }

  /**
   * Seals this device's snapshot of the project (docs/19 §8): every opened record at one generation of the
   * local cache, in a single block, so that opening a big project decrypts one block instead of each record.
   * It never leaves the device. The generation is bound into the AAD: a snapshot cannot pass for another one.
   * The plaintext is compressed before sealing: a smaller block to store, read and decrypt. Compressing before
   * encrypting leaks nothing here: the snapshot stays on the device and no one can mix chosen text into it and
   * watch its size (the CRIME kind of attack needs both).
   */
  async sealSnapshot(plaintext: Bytes, generation: number, random: RandomSource = systemRandom): Promise<Bytes> {
    const aad = this.#snapshotAad(generation);
    const compressed = await gzip(plaintext);
    try {
      return await seal(this.#key(this.#snapshot), compressed, aad, SNAPSHOT_VERSION, random);
    } finally {
      wipe(compressed);
    }
  }

  /**
   * Opens a snapshot sealed by `sealSnapshot` for this project and generation; anything else fails (also a snapshot
   * of an earlier format, `invalid_format`).
   */
  async openSnapshot(sealed: Uint8Array, generation: number): Promise<Bytes> {
    const compressed = await open(this.#key(this.#snapshot), sealed, this.#snapshotAad(generation), SNAPSHOT_VERSION);
    try {
      return await gunzip(compressed);
    } catch {
      throw new CryptoError("invalid_format");
    } finally {
      wipe(compressed);
    }
  }

  #snapshotAad(generation: number): Bytes {
    if (!Number.isSafeInteger(generation) || generation < 0) throw new CryptoError("invalid_format");
    return utf8(`${INFO.deviceSnapshot}|${this.projectId}|${generation}`);
  }

  async sealName(name: string, random: RandomSource = systemRandom): Promise<B64> {
    const plaintext = utf8(name);
    const sealed = await seal(
      this.#key(this.#name),
      plaintext,
      utf8(`${INFO.name}|${this.projectId}`),
      NAME_VERSION,
      random,
    );
    wipe(plaintext);
    return toB64(sealed);
  }

  async openName(sealedName: B64): Promise<string> {
    let sealed: Bytes;
    try {
      sealed = fromB64(sealedName);
    } catch {
      throw new CryptoError("invalid_format");
    }
    const plaintext = await open(this.#key(this.#name), sealed, utf8(`${INFO.name}|${this.projectId}`), NAME_VERSION);
    try {
      return fromUtf8(plaintext);
    } catch {
      throw new CryptoError("invalid_format");
    }
  }

  /**
   * Encrypts an attachment with its own random key, wrapped by the project's blob-key key.
   *
   * Format: "OVB1" | chunk size (u32) | wrapped key (version, nonce, key, tag) | chunks.
   * Each chunk is AES-256-GCM with a counter nonce and AAD binding project, blob id, chunk index,
   * the final flag and the chunk size, so chunks cannot be reordered, dropped or truncated.
   */
  async sealBlob(
    blobId: string,
    data: Uint8Array,
    random: RandomSource = systemRandom,
    chunkBytes: number = BLOB_CHUNK_BYTES,
  ): Promise<Bytes> {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 0xffffffff) {
      throw new RangeError("invalid chunk size");
    }
    const rawKey = random(KEY_BYTES);
    const wrapped = await seal(
      this.#key(this.#blobKeys),
      rawKey,
      utf8(`${INFO.blobKey}|${this.projectId}|${blobId}`),
      BLOB_KEY_VERSION,
      random,
    );
    const blobKey = await importAesKey(rawKey);
    wipe(rawKey);
    const parts: Bytes[] = [BLOB_MAGIC, u32(chunkBytes), wrapped];
    const count = Math.max(1, Math.ceil(data.length / chunkBytes));
    for (let index = 0; index < count; index++) {
      const final = index === count - 1;
      const chunk = copyBytes(data.subarray(index * chunkBytes, (index + 1) * chunkBytes));
      parts.push(
        await aesGcmEncrypt(
          blobKey,
          chunkNonce(index),
          chunk,
          chunkAad(this.projectId, blobId, index, final, chunkBytes),
        ),
      );
      wipe(chunk);
    }
    return concatBytes(...parts);
  }

  async openBlob(blobId: string, sealed: Uint8Array): Promise<Bytes> {
    if (sealed.length < BLOB_HEADER_BYTES + TAG_BYTES) throw new CryptoError("invalid_format");
    for (let i = 0; i < BLOB_MAGIC.length; i++) {
      if (sealed[i] !== BLOB_MAGIC[i]) throw new CryptoError("invalid_format");
    }
    const chunkBytes = new DataView(sealed.buffer, sealed.byteOffset + 4, 4).getUint32(0);
    if (chunkBytes < 1) throw new CryptoError("invalid_format");
    const rawKey = await open(
      this.#key(this.#blobKeys),
      sealed.subarray(8, BLOB_HEADER_BYTES),
      utf8(`${INFO.blobKey}|${this.projectId}|${blobId}`),
      BLOB_KEY_VERSION,
    );
    const blobKey = await importAesKey(rawKey);
    wipe(rawKey);
    const chunks: Bytes[] = [];
    let offset = BLOB_HEADER_BYTES;
    let index = 0;
    const sealedChunk = chunkBytes + TAG_BYTES;
    while (offset < sealed.length) {
      const final = sealed.length - offset <= sealedChunk;
      const end = final ? sealed.length : offset + sealedChunk;
      const body = copyBytes(sealed.subarray(offset, end));
      chunks.push(
        await aesGcmDecrypt(
          blobKey,
          chunkNonce(index),
          body,
          chunkAad(this.projectId, blobId, index, final, chunkBytes),
        ),
      );
      offset = end;
      index += 1;
    }
    if (index === 0) throw new CryptoError("invalid_format");
    const out = concatBytes(...chunks);
    wipe(...chunks);
    return out;
  }
}

/** The body of `ProjectKeys.openRecord`: opens one record and checks that it hashes to its opaque id. */
async function openSealedRecord(
  projectId: string,
  records: CryptoKey,
  recordIds: CryptoKey,
  opaqueId: string,
  ciphertext: B64,
): Promise<PlainRecord> {
  let sealed: Bytes;
  try {
    sealed = fromB64(ciphertext);
  } catch {
    throw new CryptoError("invalid_format");
  }
  const plaintext = await open(records, sealed, recordAad(projectId, opaqueId), RECORD_VERSION);
  let value: unknown;
  try {
    value = JSON.parse(fromUtf8(plaintext));
  } catch {
    throw new CryptoError("invalid_format");
  } finally {
    wipe(plaintext);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as PlainRecord).kind !== "string" ||
    typeof (value as PlainRecord).id !== "string" ||
    !("payload" in value)
  ) {
    throw new CryptoError("invalid_format");
  }
  const record = value as PlainRecord;
  checkRecordRef(record.kind, record.id);
  const mac = await hmac(recordIds, utf8(`${record.kind}\n${record.id}`));
  if (toHex(mac).slice(0, OPAQUE_ID_CHARS) !== opaqueId) throw new CryptoError("decrypt_failed");
  return { kind: record.kind, id: record.id, payload: record.payload };
}
