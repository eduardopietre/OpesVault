import { beforeAll, describe, expect, it } from "vitest";
import { CryptoError, fromB64, fromUtf8, ProjectKeys, RECORD_PADDING, toB64, type PlainRecord } from "../src/index.ts";
import { counterRandom, flipBit } from "./helpers.ts";

const PROJECT = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const RAW = new Uint8Array(32).map((_, i) => i);

let keys: ProjectKeys;
let otherProjectSameKey: ProjectKeys;
let otherKey: ProjectKeys;

beforeAll(async () => {
  keys = await ProjectKeys.fromProjectKey(PROJECT, RAW.slice());
  otherProjectSameKey = await ProjectKeys.fromProjectKey(OTHER, RAW.slice());
  otherKey = await ProjectKeys.fromProjectKey(
    PROJECT,
    RAW.map((byte) => byte ^ 0xff),
  );
});

const record: PlainRecord = {
  kind: "operation",
  id: "op-1",
  payload: { description: "Mercado Pão", amount: "123.45" },
};

describe("records", () => {
  it("round-trip with an opaque id derived from kind and id", async () => {
    const sealed = await keys.sealRecord(record);
    expect(sealed.id).toMatch(/^[0-9a-f]{32}$/);
    expect(sealed.id).toBe(await keys.opaqueId("operation", "op-1"));
    expect(await keys.openRecord(sealed.id, sealed.ciphertext)).toEqual(record);
  });

  it("has known opaque ids and ciphertext for a known key (known-answer vector)", async () => {
    expect(await keys.opaqueId("operation", "op-1")).toMatchInlineSnapshot(`"dafa5dc15c44ebaba669792dcbc543ff"`);
    expect(await keys.sealRecord(record, counterRandom(50))).toMatchInlineSnapshot(`
      {
        "ciphertext": "ATIzNDU2Nzg5Ojs8Pbfx-hh8XzF0QUic5RGiUp8wWPNrUpAjaf18vuXQZNRTo54jnYxC9ucUVs8FzTurU3W8Et57Kuk0nLjTVf7kwY7oeZG2-34cJR9_A7--L5R6VheLtDMRLECJ8tWB-yBtVcUkCnKMAJLK5YBTWXFGhgtjkgPGNMTsNW_ibYqYUMYOmNOoFlc3lu3NGfa0feCRMg",
        "id": "dafa5dc15c44ebaba669792dcbc543ff",
      }
    `);
  });

  it("opaque ids differ by kind, by id and by project key", async () => {
    const ids = new Set([
      await keys.opaqueId("operation", "op-1"),
      await keys.opaqueId("operation", "op-2"),
      await keys.opaqueId("account", "op-1"),
      await otherKey.opaqueId("operation", "op-1"),
    ]);
    expect(ids.size).toBe(4);
    await expect(keys.opaqueId("a\nb", "c")).rejects.toThrow(TypeError);
  });

  it("uses a fresh nonce every time", async () => {
    const a = await keys.sealRecord(record);
    const b = await keys.sealRecord(record);
    expect(a.id).toBe(b.id);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("pads plaintext to blur its exact size", async () => {
    const short = await keys.sealRecord({ kind: "k", id: "1", payload: "a" });
    const longer = await keys.sealRecord({ kind: "k", id: "1", payload: "abcdefghij" });
    expect(fromB64(short.ciphertext).length).toBe(fromB64(longer.ciphertext).length);
    expect((fromB64(short.ciphertext).length - 1 - 12 - 16) % RECORD_PADDING).toBe(0);
  });

  it("detects a flipped bit anywhere", async () => {
    const sealed = await keys.sealRecord(record);
    for (const index of [2, 10, 20, sealed.ciphertext.length - 2]) {
      await expect(keys.openRecord(sealed.id, flipBit(sealed.ciphertext, index))).rejects.toBeInstanceOf(CryptoError);
    }
  });

  it("detects a record moved under another opaque id", async () => {
    const a = await keys.sealRecord(record);
    const b = await keys.sealRecord({ ...record, id: "op-2" });
    await expect(keys.openRecord(b.id, a.ciphertext)).rejects.toEqual(new CryptoError("decrypt_failed"));
  });

  it("detects a record moved to another project, even with the same key", async () => {
    const sealed = await keys.sealRecord(record);
    await expect(otherProjectSameKey.openRecord(sealed.id, sealed.ciphertext)).rejects.toEqual(
      new CryptoError("decrypt_failed"),
    );
    await expect(otherKey.openRecord(sealed.id, sealed.ciphertext)).rejects.toEqual(new CryptoError("decrypt_failed"));
  });

  it("rejects an unknown format version and garbage", async () => {
    const sealed = fromB64((await keys.sealRecord(record)).ciphertext);
    sealed[0] = 2;
    await expect(keys.openRecord((await keys.sealRecord(record)).id, toB64(sealed))).rejects.toEqual(
      new CryptoError("invalid_format"),
    );
    await expect(keys.openRecord("x", "not base64!")).rejects.toEqual(new CryptoError("invalid_format"));
    await expect(keys.openRecord("x", "AAAA")).rejects.toEqual(new CryptoError("invalid_format"));
  });

  it("never carries the plaintext in the ciphertext", async () => {
    const sealed = await keys.sealRecord(record);
    const bytes = fromB64(sealed.ciphertext);
    expect(sealed.ciphertext).not.toContain("Mercado");
    expect(Buffer.from(bytes).toString("latin1")).not.toContain("Mercado");
    expect(() => fromUtf8(bytes)).toThrow();
  });

  it("stops working once destroyed (lock)", async () => {
    const local = await ProjectKeys.fromProjectKey(PROJECT, RAW.slice());
    const sealed = await local.sealRecord(record);
    local.destroy();
    expect(local.destroyed).toBe(true);
    await expect(local.openRecord(sealed.id, sealed.ciphertext)).rejects.toThrow(/locked/);
  });
});

describe("project name", () => {
  it("round-trips and is bound to the project", async () => {
    const sealed = await keys.sealName("Família Silva");
    expect(sealed).not.toContain("Silva");
    expect(await keys.openName(sealed)).toBe("Família Silva");
    await expect(otherProjectSameKey.openName(sealed)).rejects.toEqual(new CryptoError("decrypt_failed"));
    await expect(keys.openName(flipBit(sealed, 15))).rejects.toEqual(new CryptoError("decrypt_failed"));
  });
});

describe("blobs", () => {
  const BLOB = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const data = new Uint8Array(10_000).map((_, i) => (i * 7) & 255);

  it("round-trip with any chunk size, including empty data", async () => {
    for (const chunk of [1000, 4096, 10_000, 65536]) {
      const sealed = await keys.sealBlob(BLOB, data, undefined, chunk);
      expect(Array.from(await keys.openBlob(BLOB, sealed))).toEqual(Array.from(data));
    }
    const empty = await keys.sealBlob(BLOB, new Uint8Array(0));
    expect((await keys.openBlob(BLOB, empty)).length).toBe(0);
    const large = new Uint8Array(2.5 * 1024 * 1024).fill(9);
    expect((await keys.openBlob(BLOB, await keys.sealBlob(BLOB, large))).length).toBe(large.length);
  });

  it("detects flipped bits, truncation, reordered chunks and another blob id or project", async () => {
    const sealed = await keys.sealBlob(BLOB, data, undefined, 1000);
    const flipped = sealed.slice();
    flipped[sealed.length - 100]! ^= 1;
    await expect(keys.openBlob(BLOB, flipped)).rejects.toEqual(new CryptoError("decrypt_failed"));
    const header = sealed.length - 10 * 1016;
    await expect(keys.openBlob(BLOB, sealed.subarray(0, sealed.length - 1016))).rejects.toEqual(
      new CryptoError("decrypt_failed"),
    );
    const swapped = sealed.slice();
    swapped.set(sealed.subarray(header, header + 1016), header + 1016);
    swapped.set(sealed.subarray(header + 1016, header + 2032), header);
    await expect(keys.openBlob(BLOB, swapped)).rejects.toEqual(new CryptoError("decrypt_failed"));
    await expect(keys.openBlob("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", sealed)).rejects.toEqual(
      new CryptoError("decrypt_failed"),
    );
    await expect(otherProjectSameKey.openBlob(BLOB, sealed)).rejects.toEqual(new CryptoError("decrypt_failed"));
    const sizeChanged = sealed.slice();
    sizeChanged[7] = 0xe7;
    await expect(keys.openBlob(BLOB, sizeChanged)).rejects.toBeInstanceOf(CryptoError);
    await expect(keys.openBlob(BLOB, new Uint8Array(10))).rejects.toEqual(new CryptoError("invalid_format"));
  });
});
