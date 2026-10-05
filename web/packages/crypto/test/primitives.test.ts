import { argon2id as nobleArgon2id } from "@noble/hashes/argon2.js";
import * as fc from "fast-check";
import { argon2id as wasmArgon2id } from "hash-wasm";
import { describe, expect, it } from "vitest";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  argon2id,
  CryptoError,
  fromB64,
  fromHex,
  hkdfBits,
  hmac,
  importAesKey,
  importHkdfKey,
  importHmacKey,
  passwordBytes,
  toB64,
  toHex,
  utf8,
} from "../src/index.ts";
import { TEST_KDF } from "./helpers.ts";

describe("base64url", () => {
  it("round-trips any bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        expect(toHex(fromB64(toB64(bytes)))).toBe(toHex(bytes));
        expect(toB64(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
      }),
    );
  });

  it("rejects padding, other alphabets and non-canonical tails", () => {
    for (const bad of ["AA==", "A+B/", "AB C", "A", "AB", "AAB"]) {
      expect(() => fromB64(bad)).toThrow(SyntaxError);
    }
    expect(toHex(fromB64("AA"))).toBe("00");
    expect(toHex(fromB64("AAA"))).toBe("0000");
  });
});

describe("known-answer vectors of the primitives", () => {
  it("HKDF-SHA256 matches RFC 5869 test case 1", async () => {
    const ikm = fromHex("0b".repeat(22));
    const salt = fromHex("000102030405060708090a0b0c");
    const info = fromHex("f0f1f2f3f4f5f6f7f8f9");
    const okm = await hkdfBits(await importHkdfKey(ikm), info, 42, salt);
    expect(toHex(okm)).toBe("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
  });

  it("HMAC-SHA256 matches RFC 4231 test case 2", async () => {
    const key = await importHmacKey(utf8("Jefe"));
    expect(toHex(await hmac(key, utf8("what do ya want for nothing?")))).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("AES-256-GCM matches the GCM specification test case 16", async () => {
    const key = await importAesKey(fromHex("feffe9928665731c6d6a8f9467308308".repeat(2)));
    const nonce = fromHex("cafebabefacedbaddecaf888");
    const plaintext = fromHex(
      "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
    );
    const aad = fromHex("feedfacedeadbeeffeedfacedeadbeefabaddad2");
    const sealed = await aesGcmEncrypt(key, nonce, plaintext, aad);
    expect(toHex(sealed)).toBe(
      "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662" +
        "76fc6ece0f4e1768cddf8853bb2d551b",
    );
    expect(toHex(await aesGcmDecrypt(key, nonce, sealed, aad))).toBe(toHex(plaintext));
    sealed[0]! ^= 1;
    await expect(aesGcmDecrypt(key, nonce, sealed, aad)).rejects.toEqual(new CryptoError("decrypt_failed"));
  });

  it("Argon2id matches the reference implementation's test vector", async () => {
    const out = await wasmArgon2id({
      password: "password",
      salt: "somesalt",
      iterations: 2,
      memorySize: 65536,
      parallelism: 1,
      hashLength: 32,
      outputType: "hex",
    });
    expect(out).toBe("09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7");
  });

  it("Argon2id (WebAssembly) agrees with an independent implementation", async () => {
    const salt = fromHex("00112233445566778899aabbccddeeff");
    const ours = await argon2id("senha do projeto ç", salt, TEST_KDF);
    const theirs = nobleArgon2id(passwordBytes("senha do projeto ç"), salt, { t: 1, m: 8192, p: 1, dkLen: 32 });
    expect(toHex(ours)).toBe(toHex(theirs));
  });

  it("normalizes passwords to NFC", async () => {
    const salt = fromHex("00112233445566778899aabbccddeeff");
    const composed = await argon2id("maçã", salt, TEST_KDF);
    const decomposed = await argon2id("maçã", salt, TEST_KDF);
    expect(toHex(composed)).toBe(toHex(decomposed));
  });

  it("refuses parameters outside the accepted range", async () => {
    const salt = fromHex("00112233445566778899aabbccddeeff");
    await expect(argon2id("x", salt, { ...TEST_KDF, memoryKiB: 1024 })).rejects.toEqual(
      new CryptoError("invalid_params"),
    );
    await expect(argon2id("x", salt, { ...TEST_KDF, iterations: 1000 })).rejects.toEqual(
      new CryptoError("invalid_params"),
    );
    await expect(argon2id("x", salt.subarray(0, 8), TEST_KDF)).rejects.toEqual(new CryptoError("invalid_params"));
  });
});
