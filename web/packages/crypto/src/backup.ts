/**
 * The backup file format (docs/19 §13): a whole project (records and attachments) protected by a
 * password, readable offline, in the browser only. The server never sees the password or the file.
 *
 *   file    = header (32 bytes) || key check (16 bytes) || chunk 0 || chunk 1 || ... || last chunk
 *   header  = "OVBK" | version u8 | kdf id u8 (1 = Argon2id) | parallelism u8 | iterations u8
 *             | memoryKiB u32 | chunk size u32 | salt (16 bytes)            (all numbers big-endian)
 *   key     = HKDF-SHA256(Argon2id(password, salt), info "opesvault/backup/v1")      (AES-256-GCM)
 *   check   = AES-256-GCM(key, "", nonce = 0xFFFFFFFF counter, AAD = "opesvault/backup/v1|check|" || header)
 *   chunk i = AES-256-GCM(key, plaintext of exactly `chunk size` bytes (the last one 1..chunk size),
 *             nonce = 8 zero bytes || i (u32), AAD = "opesvault/backup/v1|chunk|" || header || i (u32) || final (u8))
 *
 * The plaintext is a stream of frames cut into chunks, so a record or an attachment may span chunks and
 * memory never holds more than one chunk plus the frame being assembled:
 *
 *   META   0x01 | length u32 | JSON {format, createdAt, projectName, app}      (always first)
 *   RECORD 0x02 | length u32 | JSON {kind, id, payload}
 *   BLOB   0x03 | blob id (16 bytes) | length u32 | the attachment's bytes
 *   END    0xFF | length u32 | JSON {records, blobs, missing: [blob ids that could not be read]} (always last)
 *
 * Nothing in the file is plaintext except the 32-byte header (format version, KDF parameters, chunk size
 * and salt): not the project's name, not a record, not even the number of records. The key is new for
 * every file (random salt), so counter nonces never repeat. The AAD binds every chunk to this file's
 * header (a chunk from another file or with another KDF or chunk size fails), to its position
 * (reordering fails) and to the final flag (cutting the file at a chunk boundary fails); data after the
 * last chunk fails because the former last chunk then reads as not final.
 */
import { argon2id, checkKdfParams, DEFAULT_KDF, SALT_BYTES, type KdfParams } from "./argon2.ts";
import { concatBytes, copyBytes, fromHex, fromUtf8, toHex, utf8, wipe, type Bytes } from "./bytes.ts";
import { CryptoError } from "./errors.ts";
import { aesGcmDecrypt, aesGcmEncrypt, hkdfAesKey, importHkdfKey, TAG_BYTES } from "./primitives.ts";
import type { PlainRecord } from "./project_keys.ts";
import { systemRandom, type RandomSource } from "./random.ts";

export const BACKUP_VERSION = 1;
export const BACKUP_MAGIC = utf8("OVBK");
export const BACKUP_FIXED_HEADER_BYTES = 32;
export const BACKUP_HEADER_BYTES = BACKUP_FIXED_HEADER_BYTES + TAG_BYTES;
export const BACKUP_CHUNK_BYTES = 1024 * 1024;
export const BACKUP_MIN_CHUNK_BYTES = 256;
export const BACKUP_MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const KDF_ARGON2ID = 1;
const CHECK_INDEX = 0xffffffff;
const MAX_CHUNKS = 0xfffffffe;
const MAX_FRAME_BYTES = 0xffffffff;

const TAG_META = 0x01;
const TAG_RECORD = 0x02;
const TAG_BLOB = 0x03;
const TAG_END = 0xff;

export type BackupErrorCode =
  /** Not an OpesVault backup (wrong magic or too short). */
  | "not_a_backup"
  /** A format version this build does not know. */
  | "unsupported_version"
  /** KDF parameters or chunk size outside the accepted range. */
  | "invalid_params"
  /** The password does not open the file (or the header was altered). */
  | "wrong_password"
  | "empty_password"
  /** A chunk failed authentication, the file was cut, reordered or extended. */
  | "corrupted"
  /** The authenticated content is not what this format describes (frames, counts). */
  | "invalid_content";

/** Errors carry only a code: never the password, the project's name or any data. */
export class BackupError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode) {
    super(code);
    this.name = "BackupError";
    this.code = code;
  }
}

export interface BackupMeta {
  readonly format: number;
  /** ISO instant the backup was made. */
  readonly createdAt: string;
  readonly projectName: string;
  /** Which program wrote it. */
  readonly app: string;
}

export interface BackupTotals {
  readonly records: number;
  readonly blobs: number;
  /** Blob ids that were referenced but could not be read when the backup was made. */
  readonly missing: readonly string[];
}

export interface BackupFormatInfo {
  readonly version: number;
  readonly kdf: KdfParams;
  readonly chunkBytes: number;
}

export type BackupItem =
  | { readonly type: "meta"; readonly meta: BackupMeta }
  | { readonly type: "record"; readonly record: PlainRecord }
  | { readonly type: "blob"; readonly id: string; readonly data: Bytes }
  | { readonly type: "end"; readonly totals: BackupTotals };

const BLOB_ID = /^[0-9a-f]{32}$/;

function u32(value: number): Bytes {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function counterNonce(index: number): Bytes {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setUint32(8, index);
  return out;
}

function checkAad(header: Bytes): Bytes {
  return concatBytes(utf8("opesvault/backup/v1|check|"), header);
}

function chunkAad(header: Bytes, index: number, final: boolean): Bytes {
  return concatBytes(utf8("opesvault/backup/v1|chunk|"), header, u32(index), Uint8Array.of(final ? 1 : 0));
}

async function deriveKey(password: string, salt: Bytes, kdf: KdfParams): Promise<CryptoKey> {
  let stretched: Bytes;
  try {
    stretched = await argon2id(password, salt, kdf);
  } catch (error) {
    if (error instanceof CryptoError)
      throw new BackupError(error.code === "empty_password" ? "empty_password" : "invalid_params");
    throw error;
  }
  try {
    return await hkdfAesKey(await importHkdfKey(stretched), utf8("opesvault/backup/v1"));
  } finally {
    wipe(stretched);
  }
}

function checkChunkBytes(chunkBytes: number): void {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < BACKUP_MIN_CHUNK_BYTES || chunkBytes > BACKUP_MAX_CHUNK_BYTES) {
    throw new BackupError("invalid_params");
  }
}

function encodeHeader(kdf: KdfParams, chunkBytes: number, salt: Bytes): Bytes {
  const out = new Uint8Array(BACKUP_FIXED_HEADER_BYTES);
  out.set(BACKUP_MAGIC, 0);
  out[4] = BACKUP_VERSION;
  out[5] = KDF_ARGON2ID;
  out[6] = kdf.parallelism;
  out[7] = kdf.iterations;
  const view = new DataView(out.buffer);
  view.setUint32(8, kdf.memoryKiB);
  view.setUint32(12, chunkBytes);
  out.set(salt, 16);
  return out;
}

// ----------------------------------------------------------------------------------------------
// Writing

export interface BackupWriteOptions {
  /** Argon2id parameters (tests use lighter ones). */
  readonly kdf?: KdfParams;
  /** Plaintext bytes per chunk. */
  readonly chunkBytes?: number;
  /** Tests only: fixed randomness for known-answer vectors. */
  readonly random?: RandomSource;
  /** The program's name, kept inside the encrypted META. */
  readonly app?: string;
}

/**
 * Writes a backup as it goes: each sealed chunk is handed to `emit` in order, so the caller decides
 * where it goes (a list of Blob parts, a file stream). Only one chunk of plaintext is ever buffered.
 */
export class BackupWriter {
  readonly #emit: (bytes: Bytes) => void | Promise<void>;
  readonly #key: CryptoKey;
  readonly #header: Bytes;
  readonly #chunkBytes: number;
  readonly #buffer: Bytes;
  #length = 0;
  #index = 0;
  #records = 0;
  #blobs = 0;
  #finished = false;
  #emitted = 0;

  private constructor(emit: (bytes: Bytes) => void | Promise<void>, key: CryptoKey, header: Bytes, chunkBytes: number) {
    this.#emit = emit;
    this.#key = key;
    this.#header = header;
    this.#chunkBytes = chunkBytes;
    this.#buffer = new Uint8Array(chunkBytes);
  }

  /** Derives the key (Argon2id), emits the header and the key check, and writes the META frame. */
  static async create(
    password: string,
    emit: (bytes: Bytes) => void | Promise<void>,
    meta: Pick<BackupMeta, "createdAt" | "projectName">,
    options: BackupWriteOptions = {},
  ): Promise<BackupWriter> {
    const random = options.random ?? systemRandom;
    const kdf = options.kdf ?? DEFAULT_KDF;
    const chunkBytes = options.chunkBytes ?? BACKUP_CHUNK_BYTES;
    checkChunkBytes(chunkBytes);
    try {
      checkKdfParams(kdf);
    } catch {
      throw new BackupError("invalid_params");
    }
    if (password.length === 0) throw new BackupError("empty_password");
    const salt = random(SALT_BYTES);
    const header = encodeHeader(kdf, chunkBytes, salt);
    const key = await deriveKey(password, salt, kdf);
    const check = await aesGcmEncrypt(key, counterNonce(CHECK_INDEX), new Uint8Array(0), checkAad(header));
    const writer = new BackupWriter(emit, key, header, chunkBytes);
    await emit(concatBytes(header, check));
    writer.#emitted = BACKUP_HEADER_BYTES;
    const full: BackupMeta = {
      format: BACKUP_VERSION,
      createdAt: meta.createdAt,
      projectName: meta.projectName,
      app: options.app ?? "opesvault-web",
    };
    await writer.#jsonFrame(TAG_META, full);
    return writer;
  }

  /** Plaintext waiting for the next chunk (never more than one chunk). */
  get bufferedBytes(): number {
    return this.#length;
  }

  /** Bytes handed to `emit` so far. */
  get emittedBytes(): number {
    return this.#emitted;
  }

  async #append(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      // A full buffer is sealed only when more data follows, so the last chunk can carry the final flag.
      if (this.#length === this.#chunkBytes) await this.#flush(false);
      const take = Math.min(bytes.length - offset, this.#chunkBytes - this.#length);
      this.#buffer.set(bytes.subarray(offset, offset + take), this.#length);
      this.#length += take;
      offset += take;
    }
  }

  async #flush(final: boolean): Promise<void> {
    if (this.#index >= MAX_CHUNKS) throw new BackupError("invalid_content");
    const sealed = await aesGcmEncrypt(
      this.#key,
      counterNonce(this.#index),
      this.#buffer.subarray(0, this.#length),
      chunkAad(this.#header, this.#index, final),
    );
    this.#index += 1;
    this.#length = 0;
    this.#emitted += sealed.length;
    await this.#emit(sealed);
  }

  async #jsonFrame(tag: number, value: unknown): Promise<void> {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError("not JSON");
    const body = utf8(text);
    if (body.length > MAX_FRAME_BYTES) throw new RangeError("frame too large");
    await this.#append(concatBytes(Uint8Array.of(tag), u32(body.length), body));
    wipe(body);
  }

  #ready(): void {
    if (this.#finished) throw new Error("backup already finished");
  }

  async writeRecord(record: PlainRecord): Promise<void> {
    this.#ready();
    await this.#jsonFrame(TAG_RECORD, { kind: record.kind, id: record.id, payload: record.payload });
    this.#records += 1;
  }

  async writeBlob(id: string, data: Uint8Array): Promise<void> {
    this.#ready();
    if (!BLOB_ID.test(id)) throw new TypeError("blob id must be 32 lowercase hex characters");
    if (data.length > MAX_FRAME_BYTES) throw new RangeError("attachment too large");
    await this.#append(concatBytes(Uint8Array.of(TAG_BLOB), fromHex(id), u32(data.length)));
    await this.#append(data);
    this.#blobs += 1;
  }

  /** Writes the END frame and the last chunk. The writer cannot be used afterwards. */
  async finish(missing: readonly string[] = []): Promise<BackupTotals> {
    this.#ready();
    const totals: BackupTotals = { records: this.#records, blobs: this.#blobs, missing: [...missing] };
    await this.#jsonFrame(TAG_END, totals);
    await this.#flush(true);
    this.#finished = true;
    wipe(this.#buffer);
    return totals;
  }
}

// ----------------------------------------------------------------------------------------------
// Reading

/** Where a backup's bytes come from: a File or Blob in the browser, a Uint8Array in tests. */
export interface ByteSource {
  readonly size: number;
  /** `length` bytes from `offset` (fewer only at the end). */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return { size: bytes.length, read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)) };
}

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a backup frame by frame, decrypting one chunk at a time. */
export class BackupReader {
  readonly #source: ByteSource;
  readonly #key: CryptoKey;
  readonly #header: Bytes;
  readonly info: BackupFormatInfo;
  readonly #sealedChunk: number;
  readonly #chunkCount: number;
  #next = 0;
  #parts: Bytes[] = [];
  #available = 0;
  #stage: "meta" | "body" | "done" = "meta";
  #records = 0;
  #blobs = 0;
  #maxBuffered = 0;

  private constructor(source: ByteSource, key: CryptoKey, header: Bytes, info: BackupFormatInfo, chunks: number) {
    this.#source = source;
    this.#key = key;
    this.#header = header;
    this.info = info;
    this.#sealedChunk = info.chunkBytes + TAG_BYTES;
    this.#chunkCount = chunks;
  }

  /**
   * Opens the file: checks the header and the version, derives the key (Argon2id, once) and checks the
   * password with the key check. Nothing of the content is read yet.
   */
  static async open(source: ByteSource, password: string): Promise<BackupReader> {
    if (source.size < BACKUP_FIXED_HEADER_BYTES) throw new BackupError("not_a_backup");
    const head = copyBytes(await source.read(0, BACKUP_HEADER_BYTES));
    if (head.length < BACKUP_FIXED_HEADER_BYTES) throw new BackupError("not_a_backup");
    for (let i = 0; i < BACKUP_MAGIC.length; i++)
      if (head[i] !== BACKUP_MAGIC[i]) throw new BackupError("not_a_backup");
    if (head[4] !== BACKUP_VERSION) throw new BackupError("unsupported_version");
    if (head[5] !== KDF_ARGON2ID) throw new BackupError("invalid_params");
    const view = new DataView(head.buffer);
    const kdf: KdfParams = {
      algorithm: "argon2id",
      parallelism: head[6]!,
      iterations: head[7]!,
      memoryKiB: view.getUint32(8),
    };
    const chunkBytes = view.getUint32(12);
    try {
      checkKdfParams(kdf);
    } catch {
      throw new BackupError("invalid_params");
    }
    checkChunkBytes(chunkBytes);
    if (source.size < BACKUP_HEADER_BYTES + TAG_BYTES + 1) throw new BackupError("corrupted");
    const body = source.size - BACKUP_HEADER_BYTES;
    const sealed = chunkBytes + TAG_BYTES;
    const chunks = Math.ceil(body / sealed);
    const last = body - (chunks - 1) * sealed;
    if (chunks > MAX_CHUNKS || last < TAG_BYTES + 1) throw new BackupError("corrupted");
    if (password.length === 0) throw new BackupError("empty_password");
    const fixed = head.subarray(0, BACKUP_FIXED_HEADER_BYTES);
    const key = await deriveKey(password, copyBytes(fixed.subarray(16, 32)), kdf);
    try {
      await aesGcmDecrypt(
        key,
        counterNonce(CHECK_INDEX),
        copyBytes(head.subarray(BACKUP_FIXED_HEADER_BYTES, BACKUP_HEADER_BYTES)),
        checkAad(copyBytes(fixed)),
      );
    } catch {
      throw new BackupError("wrong_password");
    }
    return new BackupReader(source, key, copyBytes(fixed), { version: BACKUP_VERSION, kdf, chunkBytes }, chunks);
  }

  /** Starts over from the first frame, keeping the derived key (restoring reads the file twice). */
  rewind(): void {
    this.#next = 0;
    this.#parts = [];
    this.#available = 0;
    this.#stage = "meta";
    this.#records = 0;
    this.#blobs = 0;
  }

  /** The most plaintext this reader held at once (to show that memory stays bounded). */
  get maxBufferedBytes(): number {
    return this.#maxBuffered;
  }

  async #loadChunk(): Promise<boolean> {
    if (this.#next >= this.#chunkCount) return false;
    const index = this.#next;
    const final = index === this.#chunkCount - 1;
    const offset = BACKUP_HEADER_BYTES + index * this.#sealedChunk;
    const length = final ? this.#source.size - offset : this.#sealedChunk;
    const sealed = copyBytes(await this.#source.read(offset, length));
    if (sealed.length !== length) throw new BackupError("corrupted");
    let plain: Bytes;
    try {
      plain = await aesGcmDecrypt(this.#key, counterNonce(index), sealed, chunkAad(this.#header, index, final));
    } catch {
      throw new BackupError("corrupted");
    }
    this.#next += 1;
    this.#parts.push(plain);
    this.#available += plain.length;
    return true;
  }

  async #take(count: number): Promise<Bytes> {
    while (this.#available < count) {
      if (!(await this.#loadChunk())) throw new BackupError("invalid_content");
    }
    if (this.#available > this.#maxBuffered) this.#maxBuffered = this.#available;
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const part = this.#parts[0]!;
      const take = Math.min(part.length, count - filled);
      out.set(part.subarray(0, take), filled);
      filled += take;
      if (take === part.length) {
        wipe(part);
        this.#parts.shift();
      } else {
        this.#parts[0] = part.subarray(take) as Bytes;
      }
    }
    this.#available -= count;
    return out;
  }

  async #atEnd(): Promise<boolean> {
    if (this.#available > 0) return false;
    return !(await this.#loadChunk());
  }

  async #json(): Promise<Record<string, unknown>> {
    const length = new DataView((await this.#take(4)).buffer).getUint32(0);
    const body = await this.#take(length);
    try {
      const value: unknown = JSON.parse(fromUtf8(body));
      if (!isObject(value)) throw new BackupError("invalid_content");
      return value;
    } catch (error) {
      if (error instanceof BackupError) throw error;
      throw new BackupError("invalid_content");
    } finally {
      wipe(body);
    }
  }

  /** The next frame, or null after the END frame. Throws `BackupError` on anything wrong. */
  async next(): Promise<BackupItem | null> {
    if (this.#stage === "done") return null;
    const tag = (await this.#take(1))[0]!;
    if (this.#stage === "meta") {
      if (tag !== TAG_META) throw new BackupError("invalid_content");
      const value = await this.#json();
      if (
        value["format"] !== BACKUP_VERSION ||
        typeof value["createdAt"] !== "string" ||
        typeof value["projectName"] !== "string" ||
        typeof value["app"] !== "string"
      ) {
        throw new BackupError("invalid_content");
      }
      this.#stage = "body";
      return {
        type: "meta",
        meta: {
          format: BACKUP_VERSION,
          createdAt: value["createdAt"],
          projectName: value["projectName"],
          app: value["app"],
        },
      };
    }
    switch (tag) {
      case TAG_RECORD: {
        const value = await this.#json();
        if (typeof value["kind"] !== "string" || typeof value["id"] !== "string" || !("payload" in value)) {
          throw new BackupError("invalid_content");
        }
        this.#records += 1;
        return { type: "record", record: { kind: value["kind"], id: value["id"], payload: value["payload"] } };
      }
      case TAG_BLOB: {
        const id = toHex(await this.#take(16));
        const length = new DataView((await this.#take(4)).buffer).getUint32(0);
        const data = await this.#take(length);
        this.#blobs += 1;
        return { type: "blob", id, data };
      }
      case TAG_END: {
        const value = await this.#json();
        const missing = value["missing"];
        if (
          value["records"] !== this.#records ||
          value["blobs"] !== this.#blobs ||
          !Array.isArray(missing) ||
          !missing.every((id) => typeof id === "string" && BLOB_ID.test(id))
        ) {
          throw new BackupError("invalid_content");
        }
        // Nothing may follow the END frame.
        if (!(await this.#atEnd())) throw new BackupError("invalid_content");
        this.#stage = "done";
        return { type: "end", totals: { records: this.#records, blobs: this.#blobs, missing: missing as string[] } };
      }
      default:
        throw new BackupError("invalid_content");
    }
  }
}
