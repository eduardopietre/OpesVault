import { beforeAll, describe, expect, it } from "vitest";
import { CryptoError, ProjectKeys, fromUtf8, utf8 } from "../src/index.ts";
import { gunzip, gzip } from "../src/compress.ts";

const PROJECT = "0123456789abcdef0123456789abcdef";
const RAW = new Uint8Array(32).map((_, i) => i);

let keys: ProjectKeys;

beforeAll(async () => {
  keys = await ProjectKeys.fromProjectKey(PROJECT, RAW.slice());
});

/** Text like the snapshot's: many similar JSON records, more than one chunk of the stream. */
function bigText(records: number): string {
  const rows = Array.from({ length: records }, (_, i) => [
    i.toString(16).padStart(32, "0"),
    i + 1,
    "open",
    { kind: "operation", id: `op-${i}`, payload: { description: `Mercado ${i % 97}`, amount: `${i}.50` } },
  ]);
  return JSON.stringify(rows);
}

describe("gzip", () => {
  it("round-trips empty, small and multi-chunk input", async () => {
    for (const text of ["", "a", bigText(30_000)]) {
      const packed = await gzip(utf8(text));
      expect(fromUtf8(await gunzip(packed))).toBe(text);
    }
  });

  it("rejects what is not gzip", async () => {
    await expect(gunzip(utf8("not gzip at all"))).rejects.toBeDefined();
  });
});

describe("the device snapshot (docs/19 §8)", () => {
  it("is compressed before sealing and opens to the same text", async () => {
    const text = bigText(5000);
    const sealed = await keys.sealSnapshot(utf8(text), 7);
    expect(sealed.length).toBeLessThan(text.length / 3);
    expect(sealed[0]).toBe(2);
    expect(fromUtf8(await keys.openSnapshot(sealed, 7))).toBe(text);
  });

  it("is bound to its generation", async () => {
    const sealed = await keys.sealSnapshot(utf8("[]"), 7);
    await expect(keys.openSnapshot(sealed, 8)).rejects.toBeInstanceOf(CryptoError);
  });

  it("an uncompressed snapshot of the first format is not opened", async () => {
    const old = (await keys.sealSnapshot(utf8("[]"), 7)).slice();
    old[0] = 1;
    await expect(keys.openSnapshot(old, 7)).rejects.toMatchObject({ code: "invalid_format" });
  });
});
