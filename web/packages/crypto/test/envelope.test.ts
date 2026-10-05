import { describe, expect, it } from "vitest";
import {
  changeEnvelopePassword,
  createProjectSecrets,
  CryptoError,
  deriveLoginSecret,
  fromB64,
  normalizeEmail,
  openWithPassword,
  openWithRecoveryKey,
  regenerateEnvelopeRecoveryKey,
  toB64,
  type EnvelopeData,
  type ProjectKeys,
} from "../src/index.ts";
import { counterRandom, flipBit, TEST_KDF } from "./helpers.ts";

const PROJECT = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const options = { kdf: TEST_KDF };

/** Proves that two key sets are the same project key: one seals, the other opens. */
async function sameKeys(a: ProjectKeys, b: ProjectKeys): Promise<boolean> {
  const sealed = await a.sealRecord({ kind: "probe", id: "1", payload: 1 });
  const opened = await b.openRecord(sealed.id, sealed.ciphertext);
  return opened.payload === 1;
}

describe("key envelope", () => {
  it("has known bytes for known randomness (known-answer vector)", async () => {
    const created = await createProjectSecrets(PROJECT, "senha correta", { kdf: TEST_KDF, random: counterRandom(1) });
    expect(created.envelope).toMatchInlineSnapshot(`
      {
        "kdf": {
          "algorithm": "argon2id",
          "iterations": 1,
          "memoryKiB": 8192,
          "parallelism": 1,
          "salt": "ISIjJCUmJygpKissLS4vMA",
        },
        "recoverySalt": "UVJTVFVWV1hZWltcXV5fYA",
        "version": 1,
        "wrappedByPassword": "ATEyMzQ1Njc4OTo7PE1X9efoRAwvQIhPw5MB5L-U1TjeAvpIgcXe8r9OPxzuED89iqKEFe-DdAkQ0Psp6w",
        "wrappedByRecovery": "AWFiY2RlZmdoaWprbIbUPVeXBjC7wjvAgD4_VYuRVP_V3GIb1bSDC6Ni4hVNgDiG8aKyX6T6tQt8z1lg5A",
      }
    `);
    expect(created.recoveryKey).toMatchInlineSnapshot(`"7MZ3-YG21-891M-8HA6-8X44-JJJB-9H6M-WKTG-RXFS"`);
    const record = await created.keys.sealRecord(
      { kind: "operation", id: "op-1", payload: { amount: "10.00" } },
      counterRandom(200),
    );
    expect(record).toMatchInlineSnapshot(`
      {
        "ciphertext": "AcjJysvMzc7P0NHS0-d9QVpghA7rMZD7PO878YYJSjWBium11oHJPeYXaaxSQ9tg-fbIkf1jWNMM81CceJihKHgxPeoHq43ssQqLQYr5yqX2P1fg77Ss4v_KDCPD",
        "id": "7ade96a2c82d8238a7e0017d12b4e0fa",
      }
    `);
    expect(await created.keys.sealName("Casa", counterRandom(9))).toMatchInlineSnapshot(
      `"AQkKCwwNDg8QERITFBgllpYwlem1Tu97-O7mRWfid081"`,
    );
  });

  it("opens with the right password and the same key", async () => {
    const created = await createProjectSecrets(PROJECT, "senha correta", options);
    const keys = await openWithPassword(PROJECT, created.envelope, "senha correta");
    expect(await sameKeys(created.keys, keys)).toBe(true);
  });

  it("a wrong password is an error, never a new project", async () => {
    const created = await createProjectSecrets(PROJECT, "senha correta", options);
    await expect(openWithPassword(PROJECT, created.envelope, "senha errada")).rejects.toEqual(
      new CryptoError("wrong_password"),
    );
    await expect(openWithPassword(PROJECT, created.envelope, "")).rejects.toEqual(new CryptoError("wrong_password"));
  });

  it("is bound to its project", async () => {
    const created = await createProjectSecrets(PROJECT, "senha", options);
    await expect(openWithPassword(OTHER, created.envelope, "senha")).rejects.toEqual(new CryptoError("wrong_password"));
  });

  it("detects any change to the wrapped key or the salt", async () => {
    const created = await createProjectSecrets(PROJECT, "senha", options);
    const tampered: EnvelopeData = {
      ...created.envelope,
      wrappedByPassword: flipBit(created.envelope.wrappedByPassword, 20),
    };
    await expect(openWithPassword(PROJECT, tampered, "senha")).rejects.toEqual(new CryptoError("wrong_password"));
    const salt = fromB64(created.envelope.kdf.salt);
    salt[0]! ^= 1;
    const otherSalt: EnvelopeData = { ...created.envelope, kdf: { ...created.envelope.kdf, salt: toB64(salt) } };
    await expect(openWithPassword(PROJECT, otherSalt, "senha")).rejects.toEqual(new CryptoError("wrong_password"));
  });

  it("refuses envelopes with absurd parameters before deriving anything", async () => {
    const created = await createProjectSecrets(PROJECT, "senha", options);
    const hostile: EnvelopeData = {
      ...created.envelope,
      kdf: { ...created.envelope.kdf, memoryKiB: 64 * 1024 * 1024 },
    };
    await expect(openWithPassword(PROJECT, hostile, "senha")).rejects.toEqual(new CryptoError("invalid_params"));
    await expect(openWithPassword(PROJECT, { ...created.envelope, version: 2 }, "senha")).rejects.toEqual(
      new CryptoError("invalid_format"),
    );
  });

  it("changing the password re-wraps the same key; the old password stops working", async () => {
    const created = await createProjectSecrets(PROJECT, "antiga", options);
    await expect(changeEnvelopePassword(PROJECT, created.envelope, "errada", "nova", options)).rejects.toEqual(
      new CryptoError("wrong_password"),
    );
    const changed = await changeEnvelopePassword(PROJECT, created.envelope, "antiga", "nova", options);
    expect(changed.kdf.salt).not.toBe(created.envelope.kdf.salt);
    expect(changed.wrappedByRecovery).toBe(created.envelope.wrappedByRecovery);
    await expect(openWithPassword(PROJECT, changed, "antiga")).rejects.toEqual(new CryptoError("wrong_password"));
    expect(await sameKeys(created.keys, await openWithPassword(PROJECT, changed, "nova"))).toBe(true);
  });

  it("the recovery key opens the project and sets a new password", async () => {
    const created = await createProjectSecrets(PROJECT, "esquecida", options);
    const recovered = await openWithRecoveryKey(PROJECT, created.envelope, created.recoveryKey, "nova", options);
    expect(await sameKeys(created.keys, recovered.keys)).toBe(true);
    expect(await sameKeys(created.keys, await openWithPassword(PROJECT, recovered.envelope, "nova"))).toBe(true);
    await expect(openWithPassword(PROJECT, recovered.envelope, "esquecida")).rejects.toEqual(
      new CryptoError("wrong_password"),
    );
    // The recovery key itself keeps working until it is regenerated.
    await openWithRecoveryKey(PROJECT, recovered.envelope, created.recoveryKey, "outra", options);
  });

  it("a wrong or mistyped recovery key is reported as such", async () => {
    const created = await createProjectSecrets(PROJECT, "senha", options);
    const other = await createProjectSecrets(PROJECT, "senha", options);
    await expect(openWithRecoveryKey(PROJECT, created.envelope, other.recoveryKey, "nova", options)).rejects.toEqual(
      new CryptoError("wrong_recovery_key"),
    );
    await expect(openWithRecoveryKey(PROJECT, created.envelope, "AAAA-BBBB", "nova", options)).rejects.toEqual(
      new CryptoError("invalid_recovery_key"),
    );
    await expect(openWithRecoveryKey(OTHER, created.envelope, created.recoveryKey, "nova", options)).rejects.toEqual(
      new CryptoError("wrong_recovery_key"),
    );
  });

  it("regenerating the recovery key invalidates the old one", async () => {
    const created = await createProjectSecrets(PROJECT, "senha", options);
    await expect(regenerateEnvelopeRecoveryKey(PROJECT, created.envelope, "errada", options)).rejects.toEqual(
      new CryptoError("wrong_password"),
    );
    const regenerated = await regenerateEnvelopeRecoveryKey(PROJECT, created.envelope, "senha", options);
    expect(regenerated.recoveryKey).not.toBe(created.recoveryKey);
    await expect(
      openWithRecoveryKey(PROJECT, regenerated.envelope, created.recoveryKey, "nova", options),
    ).rejects.toEqual(new CryptoError("wrong_recovery_key"));
    const recovered = await openWithRecoveryKey(
      PROJECT,
      regenerated.envelope,
      regenerated.recoveryKey,
      "nova",
      options,
    );
    expect(await sameKeys(created.keys, recovered.keys)).toBe(true);
  });

  it("each project gets its own key", async () => {
    const a = await createProjectSecrets(PROJECT, "senha", options);
    const b = await createProjectSecrets(PROJECT, "senha", options);
    expect(a.envelope.wrappedByPassword).not.toBe(b.envelope.wrappedByPassword);
    await expect(sameKeys(a.keys, b.keys)).rejects.toEqual(new CryptoError("decrypt_failed"));
  });
});

describe("login secret", () => {
  const salt = toB64(new Uint8Array(16).fill(3));

  it("is deterministic for the same password and salt (known-answer vector)", async () => {
    const one = await deriveLoginSecret("senha da conta", salt, TEST_KDF);
    expect(await deriveLoginSecret("senha da conta", salt, TEST_KDF)).toBe(one);
    expect(one).toMatchInlineSnapshot(`"XLkeLOt78G0AXWGvbewxklCv7Bf5b91xiuPtqb1pcEo"`);
    expect(fromB64(one)).toHaveLength(32);
  });

  it("changes with the password and with the salt, and never contains the password", async () => {
    const one = await deriveLoginSecret("senha da conta", salt, TEST_KDF);
    expect(await deriveLoginSecret("senha da conta!", salt, TEST_KDF)).not.toBe(one);
    expect(await deriveLoginSecret("senha da conta", toB64(new Uint8Array(16).fill(4)), TEST_KDF)).not.toBe(one);
    expect(one).not.toContain("senha");
  });

  it("normalizes emails", () => {
    expect(normalizeEmail("  Ana@Exemplo.COM ")).toBe("ana@exemplo.com");
  });
});
