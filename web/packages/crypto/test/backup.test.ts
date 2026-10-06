import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  BACKUP_HEADER_BYTES,
  BACKUP_VERSION,
  BackupError,
  BackupReader,
  BackupWriter,
  blobSource,
  bytesSource,
  concatBytes,
  toHex,
  utf8,
  type BackupItem,
  type BackupTotals,
  type Bytes,
  type PlainRecord,
} from "../src/index.ts";
import { counterRandom, TEST_KDF } from "./helpers.ts";

const PASSWORD = "senha do projeto";
const CHUNK = 256;
const SEALED = CHUNK + 16;
const CREATED = "2026-10-06T12:00:00.000Z";
const BLOB_A = "a".repeat(32);
const BLOB_B = "b".repeat(32);

function record(index: number, size = 40): PlainRecord {
  return {
    kind: "operation",
    id: `op-${index}`,
    payload: { description: `Mercado ${index} ${"x".repeat(size)}`, n: index },
  };
}

interface Built {
  readonly file: Bytes;
  readonly chunks: Bytes[];
  readonly totals: BackupTotals;
}

async function build(
  fill: (writer: BackupWriter) => Promise<void>,
  options: { chunkBytes?: number; missing?: string[]; name?: string } = {},
): Promise<Built> {
  const chunks: Bytes[] = [];
  const writer = await BackupWriter.create(
    PASSWORD,
    (bytes) => void chunks.push(bytes),
    { createdAt: CREATED, projectName: options.name ?? "Casa dos Souza" },
    { kdf: TEST_KDF, chunkBytes: options.chunkBytes ?? CHUNK },
  );
  await fill(writer);
  const totals = await writer.finish(options.missing ?? []);
  return { file: concatBytes(...chunks), chunks, totals };
}

async function standard(): Promise<Built> {
  return build(async (writer) => {
    for (let i = 0; i < 12; i++) await writer.writeRecord(record(i));
    await writer.writeBlob(
      BLOB_A,
      new Uint8Array(700).map((_, i) => i % 251),
    );
    await writer.writeBlob(BLOB_B, new Uint8Array(0));
  });
}

async function readAll(file: Bytes, password = PASSWORD) {
  const reader = await BackupReader.open(bytesSource(file), password);
  const items: BackupItem[] = [];
  for (let item = await reader.next(); item !== null; item = await reader.next()) items.push(item);
  return { reader, items };
}

async function expectBackupError(work: Promise<unknown>, code: BackupError["code"]) {
  await expect(work).rejects.toEqual(new BackupError(code));
}

function withByte(file: Bytes, index: number, xor = 1): Bytes {
  const copy = file.slice();
  copy[index] = copy[index]! ^ xor;
  return copy;
}

describe("backup format: round trip", () => {
  it("writes META, records, attachments and END, and reads them back in order", async () => {
    const built = await standard();
    expect(built.totals).toEqual({ records: 12, blobs: 2, missing: [] });
    const { items } = await readAll(built.file);
    expect(items[0]).toEqual({
      type: "meta",
      meta: { format: BACKUP_VERSION, createdAt: CREATED, projectName: "Casa dos Souza", app: "opesvault-web" },
    });
    const records = items.filter((i) => i.type === "record").map((i) => (i as { record: PlainRecord }).record);
    expect(records).toEqual(Array.from({ length: 12 }, (_, i) => record(i)));
    const blobs = items.filter((i) => i.type === "blob") as { id: string; data: Bytes }[];
    expect(blobs.map((b) => [b.id, b.data.length])).toEqual([
      [BLOB_A, 700],
      [BLOB_B, 0],
    ]);
    expect(blobs[0]!.data).toEqual(new Uint8Array(700).map((_, i) => i % 251));
    expect(items.at(-1)).toEqual({ type: "end", totals: { records: 12, blobs: 2, missing: [] } });
  });

  it("works across chunk sizes and when the content ends exactly on a chunk boundary", async () => {
    const plaintextBytes = (built: Built) =>
      built.file.length - BACKUP_HEADER_BYTES - 16 * built.chunks.slice(1).length;
    const probe = await build(async (writer) => writer.writeBlob(BLOB_A, new Uint8Array(0)));
    // The blob frame grows byte by byte: pick the size that makes the whole plaintext a multiple of the chunk.
    const exact = ((CHUNK - (plaintextBytes(probe) % CHUNK)) % CHUNK) + 3 * CHUNK;
    for (const size of [exact, exact - 1, exact + 1, 0, 1, CHUNK - 1, CHUNK, CHUNK + 1]) {
      const built = await build(async (writer) => writer.writeBlob(BLOB_A, new Uint8Array(size).fill(7)));
      if (size === exact) {
        expect(plaintextBytes(built) % CHUNK).toBe(0);
        expect((built.file.length - BACKUP_HEADER_BYTES) % SEALED).toBe(0);
      }
      const { items } = await readAll(built.file);
      expect((items.find((i) => i.type === "blob") as { data: Bytes }).data).toEqual(new Uint8Array(size).fill(7));
      expect(items.at(-1)?.type).toBe("end");
    }
  });

  it("an empty project (no records, no attachments) is a valid backup", async () => {
    const built = await build(async () => undefined);
    const { items } = await readAll(built.file);
    expect(items.map((i) => i.type)).toEqual(["meta", "end"]);
  });

  it("keeps the ids of attachments that could not be read, authenticated", async () => {
    const built = await build(async (writer) => writer.writeRecord(record(1)), { missing: [BLOB_A] });
    const { items } = await readAll(built.file);
    expect(items.at(-1)).toEqual({ type: "end", totals: { records: 1, blobs: 0, missing: [BLOB_A] } });
  });

  it("reads from a Blob like the browser does, and again after rewind with the same key", async () => {
    const built = await standard();
    const reader = await BackupReader.open(blobSource(new Blob([built.file])), PASSWORD);
    const first: string[] = [];
    for (let item = await reader.next(); item !== null; item = await reader.next()) first.push(item.type);
    expect(await reader.next()).toBeNull();
    reader.rewind();
    const second: string[] = [];
    for (let item = await reader.next(); item !== null; item = await reader.next()) second.push(item.type);
    expect(second).toEqual(first);
    expect(reader.info).toEqual({ version: 1, kdf: TEST_KDF, chunkBytes: CHUNK });
  });

  it("has no plaintext: not the project's name, the records, the kinds or the attachments", async () => {
    const built = await build(
      async (writer) => {
        await writer.writeRecord({
          kind: "operation",
          id: "lancamento-secreto",
          payload: { description: "Farmácia da Maria" },
        });
        await writer.writeBlob(BLOB_A, utf8("recibo secreto do plano de saúde"));
      },
      { name: "Família Sobrenome Rara" },
    );
    const text = new TextDecoder("latin1").decode(built.file);
    for (const needle of [
      "Sobrenome",
      "Rara",
      "secreto",
      "Farm",
      "operation",
      "description",
      "recibo",
      "OVBK-meta",
      "projectName",
    ]) {
      expect(text, needle).not.toContain(needle);
    }
    // Only the 32-byte header is readable: magic, version, KDF parameters, chunk size and salt.
    expect(text.slice(0, 4)).toBe("OVBK");
  });

  it("has a known-answer vector for fixed randomness (the format cannot drift unnoticed)", async () => {
    const chunks: Bytes[] = [];
    const writer = await BackupWriter.create(
      "senha do projeto",
      (bytes) => void chunks.push(bytes),
      { createdAt: CREATED, projectName: "Casa" },
      { kdf: TEST_KDF, chunkBytes: CHUNK, random: counterRandom(7) },
    );
    await writer.writeRecord({ kind: "operation", id: "op-1", payload: { amount: "10.00" } });
    await writer.writeBlob(BLOB_A, utf8("PDF"));
    await writer.finish();
    const file = concatBytes(...chunks);
    expect(toHex(file.subarray(0, 32))).toMatchInlineSnapshot(
      `"4f56424b0101010100002000000001000708090a0b0c0d0e0f10111213141516"`,
    );
    expect(toHex(sha256(file))).toMatchInlineSnapshot(
      `"0de354f301633b6c845b7f7d735668e19bc39d41b4287f86b2101578db079801"`,
    );
  });
});

describe("backup format: wrong inputs", () => {
  it("a wrong or empty password is wrong_password / empty_password, never partial content", async () => {
    const { file } = await standard();
    await expectBackupError(BackupReader.open(bytesSource(file), "outra senha"), "wrong_password");
    await expectBackupError(BackupReader.open(bytesSource(file), ""), "empty_password");
    await expect(
      BackupWriter.create("", () => undefined, { createdAt: CREATED, projectName: "x" }, { kdf: TEST_KDF }),
    ).rejects.toEqual(new BackupError("empty_password"));
  });

  it("the same password in another Unicode form still opens it (NFC)", async () => {
    const decomposed = "café";
    const chunks: Bytes[] = [];
    const writer = await BackupWriter.create(
      "café",
      (bytes) => void chunks.push(bytes),
      { createdAt: CREATED, projectName: "x" },
      { kdf: TEST_KDF, chunkBytes: CHUNK },
    );
    await writer.finish();
    await BackupReader.open(bytesSource(concatBytes(...chunks)), decomposed);
  });

  it("refuses what is not a backup", async () => {
    await expectBackupError(BackupReader.open(bytesSource(new Uint8Array(0)), PASSWORD), "not_a_backup");
    await expectBackupError(
      BackupReader.open(bytesSource(utf8("%PDF-1.7 not a backup at all, only text...")), PASSWORD),
      "not_a_backup",
    );
    const { file } = await standard();
    await expectBackupError(BackupReader.open(bytesSource(file.slice(0, 20)), PASSWORD), "not_a_backup");
    await expectBackupError(BackupReader.open(bytesSource(withByte(file, 0)), PASSWORD), "not_a_backup");
  });

  it("refuses a format version this build does not know, before any key derivation", async () => {
    const { file } = await standard();
    await expectBackupError(BackupReader.open(bytesSource(withByte(file, 4, 3)), PASSWORD), "unsupported_version");
    await expectBackupError(
      BackupReader.open(bytesSource(withByte(file, 4, 0xff ^ 1)), PASSWORD),
      "unsupported_version",
    );
  });

  it("refuses KDF parameters and chunk sizes outside the accepted range, before deriving", async () => {
    const { file } = await standard();
    const set = (at: number, bytes: number[]) => {
      const copy = file.slice();
      copy.set(bytes, at);
      return copy;
    };
    // memory 1 KiB, memory 4 GiB, iterations 0 and 200, parallelism 0 and 9, another KDF id
    await expectBackupError(BackupReader.open(bytesSource(set(8, [0, 0, 4, 0])), PASSWORD), "invalid_params");
    await expectBackupError(
      BackupReader.open(bytesSource(set(8, [0xff, 0xff, 0xff, 0xff])), PASSWORD),
      "invalid_params",
    );
    await expectBackupError(BackupReader.open(bytesSource(set(7, [0])), PASSWORD), "invalid_params");
    await expectBackupError(BackupReader.open(bytesSource(set(7, [200])), PASSWORD), "invalid_params");
    await expectBackupError(BackupReader.open(bytesSource(set(6, [0])), PASSWORD), "invalid_params");
    await expectBackupError(BackupReader.open(bytesSource(set(6, [9])), PASSWORD), "invalid_params");
    await expectBackupError(BackupReader.open(bytesSource(set(5, [2])), PASSWORD), "invalid_params");
    // chunk size 16 and 4 GiB-1
    await expectBackupError(BackupReader.open(bytesSource(set(12, [0, 0, 0, 16])), PASSWORD), "invalid_params");
    await expectBackupError(
      BackupReader.open(bytesSource(set(12, [0xff, 0xff, 0xff, 0xff])), PASSWORD),
      "invalid_params",
    );
  });
});

describe("backup format: tampering is always detected", () => {
  it("a flipped bit anywhere in the header or the key check fails (the header is authenticated)", async () => {
    const { file } = await standard();
    for (let at = 8; at < BACKUP_HEADER_BYTES; at += 3) {
      // Bytes 8..15 hold parameters that may be refused before the check; the rest is the check itself.
      await expect(BackupReader.open(bytesSource(withByte(file, at)), PASSWORD), `byte ${at}`).rejects.toBeInstanceOf(
        BackupError,
      );
    }
    await expectBackupError(BackupReader.open(bytesSource(withByte(file, 20)), PASSWORD), "wrong_password"); // salt
    await expectBackupError(BackupReader.open(bytesSource(withByte(file, 40)), PASSWORD), "wrong_password"); // check
  });

  it("a flipped bit in any chunk is detected (reading fails, nothing after it is trusted)", async () => {
    const built = await standard();
    expect(built.chunks.length).toBeGreaterThan(6);
    let offset = BACKUP_HEADER_BYTES;
    const header = built.file.length - built.chunks.slice(1).reduce((n, c) => n + c.length, 0);
    expect(header).toBe(BACKUP_HEADER_BYTES);
    for (let i = 1; i < built.chunks.length; i++) {
      const chunk = built.chunks[i]!;
      for (const at of [0, chunk.length >> 1, chunk.length - 1]) {
        await expect(readAll(withByte(built.file, offset + at)), `chunk ${i - 1} byte ${at}`).rejects.toEqual(
          new BackupError("corrupted"),
        );
      }
      offset += chunk.length;
    }
  });

  it("truncation is detected: at a chunk boundary, inside a chunk, and down to the header", async () => {
    const built = await standard();
    const full = built.chunks.slice(1);
    let length = BACKUP_HEADER_BYTES;
    for (let i = 0; i < full.length - 1; i++) {
      length += full[i]!.length;
      // exactly after chunk i: every chunk present is authentic, but the last one was not sealed as final
      await expectBackupError(readAll(built.file.slice(0, length)), "corrupted");
    }
    await expectBackupError(readAll(built.file.slice(0, built.file.length - 1)), "corrupted");
    await expectBackupError(readAll(built.file.slice(0, built.file.length - 20)), "corrupted");
    await expectBackupError(readAll(built.file.slice(0, BACKUP_HEADER_BYTES + 5)), "corrupted");
    await expectBackupError(readAll(built.file.slice(0, BACKUP_HEADER_BYTES)), "corrupted");
  });

  it("appended data is detected (extra chunks, a few bytes, a copy of a chunk)", async () => {
    const built = await standard();
    await expectBackupError(readAll(concatBytes(built.file, new Uint8Array(3))), "corrupted");
    await expectBackupError(readAll(concatBytes(built.file, new Uint8Array(40))), "corrupted");
    await expectBackupError(readAll(concatBytes(built.file, built.chunks.at(-1)!)), "corrupted");
    await expectBackupError(readAll(concatBytes(built.file, built.chunks[1]!)), "corrupted");
  });

  it("reordered, duplicated and dropped chunks are detected", async () => {
    const built = await standard();
    const head = concatBytes(built.chunks[0]!);
    const body = built.chunks.slice(1);
    const join = (order: number[]) => concatBytes(head, ...order.map((i) => body[i]!));
    const count = body.length;
    const natural = Array.from({ length: count }, (_, i) => i);
    // swap two full chunks
    const swapped = [...natural];
    [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    await expectBackupError(readAll(join(swapped)), "corrupted");
    // swap the first and the final chunk
    const ends = [...natural];
    [ends[0], ends[count - 1]] = [ends[count - 1]!, ends[0]!];
    await expectBackupError(readAll(join(ends)), "corrupted");
    // drop a middle chunk (all remaining are full or final, so the geometry still parses)
    await expectBackupError(readAll(join(natural.filter((i) => i !== 2))), "corrupted");
    // repeat a chunk
    await expectBackupError(readAll(join([...natural.slice(0, 3), 2, ...natural.slice(3)])), "corrupted");
    // drop the final chunk
    await expectBackupError(readAll(join(natural.slice(0, -1))), "corrupted");
  });

  it("chunks of another backup of the same password do not fit (swapped files)", async () => {
    const a = await standard();
    const b = await standard();
    expect(toHex(a.file.subarray(16, 32))).not.toBe(toHex(b.file.subarray(16, 32))); // a new salt each time
    // A's header with B's body: the key check passes (A's), the first chunk does not
    await expectBackupError(readAll(concatBytes(a.chunks[0]!, ...b.chunks.slice(1))), "corrupted");
    // B's header with A's body: B's key opens the check, A's chunks do not open under it
    await expectBackupError(readAll(concatBytes(b.chunks[0]!, ...a.chunks.slice(1))), "corrupted");
    // one of B's chunks inside A
    const mixed = a.chunks.slice();
    mixed[2] = b.chunks[2]!;
    await expectBackupError(readAll(concatBytes(...mixed)), "corrupted");
  });

  it("a file with another chunk size in its header fails (the chunk size is authenticated)", async () => {
    const { file } = await standard();
    const copy = file.slice();
    copy.set([0, 0, 1, 0x10], 12); // 272 instead of 256
    await expectBackupError(readAll(copy), "wrong_password");
  });
});

describe("backup format: streaming keeps memory bounded", () => {
  it("never buffers more than one chunk while writing a large project", async () => {
    const chunkBytes = 64 * 1024;
    const sizes: number[] = [];
    let peak = 0;
    const holder: { writer?: BackupWriter } = {};
    const writer = await BackupWriter.create(
      PASSWORD,
      (bytes) => {
        sizes.push(bytes.length);
        peak = Math.max(peak, holder.writer?.bufferedBytes ?? 0);
      },
      { createdAt: CREATED, projectName: "Grande" },
      { kdf: TEST_KDF, chunkBytes },
    );
    holder.writer = writer;
    for (let i = 0; i < 3000; i++) {
      await writer.writeRecord(record(i, 150));
      peak = Math.max(peak, writer.bufferedBytes);
    }
    await writer.writeBlob(BLOB_A, new Uint8Array(3 * 1024 * 1024).fill(9));
    await writer.writeBlob(BLOB_B, new Uint8Array(1024 * 1024).fill(3));
    const totals = await writer.finish();
    expect(totals).toMatchObject({ records: 3000, blobs: 2 });
    expect(peak).toBeLessThanOrEqual(chunkBytes);
    expect(sizes.length).toBeGreaterThan(60);
    // every chunk but the last is full; the header comes first
    expect(sizes[0]).toBe(BACKUP_HEADER_BYTES);
    for (const size of sizes.slice(1, -1)) expect(size).toBe(chunkBytes + 16);
    expect(writer.emittedBytes).toBe(sizes.reduce((a, b) => a + b, 0));
  });

  it("reads records chunk by chunk: the buffer stays near one chunk", async () => {
    const built = await build(
      async (writer) => {
        for (let i = 0; i < 4000; i++) await writer.writeRecord(record(i, 120));
      },
      { chunkBytes: 4096 },
    );
    const { reader, items } = await readAll(built.file);
    expect(items.filter((i) => i.type === "record")).toHaveLength(4000);
    expect(reader.maxBufferedBytes).toBeLessThanOrEqual(4096 * 2);
  });

  it("hands a large file to a Blob source in slices (no whole-file read)", async () => {
    const built = await standard();
    const reads: number[] = [];
    const source = bytesSource(built.file);
    const spy = {
      size: source.size,
      read: (offset: number, length: number) => {
        reads.push(length);
        return source.read(offset, length);
      },
    };
    const reader = await BackupReader.open(spy, PASSWORD);
    while ((await reader.next()) !== null) {
      /* drain */
    }
    expect(Math.max(...reads)).toBeLessThanOrEqual(SEALED);
  });
});
