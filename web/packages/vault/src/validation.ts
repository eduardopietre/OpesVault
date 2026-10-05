/**
 * Validation rules every `SyncBackend` adapter applies, in this order, to what it receives.
 * Shared by the in-memory reference and the server, so that both refuse the same things with the
 * same codes (`invalid` for malformed input, `too_large` past a limit).
 */
import { normalizeEmail } from "@opesvault/crypto";
import {
  BackendError,
  HOLDER_PATTERN,
  ID_PATTERN,
  LIMITS,
  type B64,
  type EnvelopeContent,
  type PushRecord,
} from "./backend.ts";

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const B64_PATTERN = /^[A-Za-z0-9_-]*$/;

export function invalid(): never {
  throw new BackendError("invalid");
}

/** Normalized email (NFC, trimmed, lower case) or `invalid`. */
export function checkEmail(email: unknown): string {
  if (typeof email !== "string" || email.length > 320) invalid();
  const normalized = normalizeEmail(email);
  if (!EMAIL_PATTERN.test(normalized)) invalid();
  return normalized;
}

export function checkB64(value: unknown, max: number, min = 1): B64 {
  if (typeof value !== "string" || !B64_PATTERN.test(value) || value.length < min) invalid();
  if (value.length > max) throw new BackendError("too_large");
  return value;
}

/** A login secret: base64url of 16 to 96 bytes. */
export function checkLoginSecret(value: unknown): B64 {
  return checkB64(value, 128, 22);
}

export function checkId(value: unknown): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) invalid();
  return value;
}

export function checkRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

export function checkHolder(value: unknown): string {
  if (typeof value !== "string" || !HOLDER_PATTERN.test(value)) invalid();
  return value;
}

export function checkPullLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid();
  return Math.min(value, LIMITS.maxPullLimit);
}

export function checkEnvelope(envelope: unknown): EnvelopeContent {
  const max = LIMITS.maxEnvelopeField;
  if (typeof envelope !== "object" || envelope === null) invalid();
  const value = envelope as EnvelopeContent;
  const kdf = value.kdf as EnvelopeContent["kdf"] | null | undefined;
  if (typeof kdf !== "object" || kdf === null) invalid();
  const ints = [value.version, kdf.memoryKiB, kdf.iterations, kdf.parallelism];
  if (kdf.algorithm !== "argon2id" || !ints.every((n) => Number.isSafeInteger(n) && n > 0)) invalid();
  if (value.recoverySalt === undefined || value.wrappedByRecovery === undefined) invalid();
  if ((value.recoverySalt === null) !== (value.wrappedByRecovery === null)) invalid();
  return {
    version: value.version,
    kdf: {
      algorithm: "argon2id",
      memoryKiB: kdf.memoryKiB,
      iterations: kdf.iterations,
      parallelism: kdf.parallelism,
      salt: checkB64(kdf.salt, max),
    },
    wrappedByPassword: checkB64(value.wrappedByPassword, max),
    recoverySalt: value.recoverySalt === null ? null : checkB64(value.recoverySalt, max),
    wrappedByRecovery: value.wrappedByRecovery === null ? null : checkB64(value.wrappedByRecovery, max),
  };
}

/** A push: 1 to `maxPushRecords` distinct records, each within the size limit, all within the total. */
export function checkPushRecords(records: unknown): PushRecord[] {
  if (!Array.isArray(records) || records.length === 0) invalid();
  if (records.length > LIMITS.maxPushRecords) throw new BackendError("too_large");
  const seen = new Set<string>();
  const out: PushRecord[] = [];
  let total = 0;
  for (const record of records as unknown[]) {
    if (typeof record !== "object" || record === null) invalid();
    const { id, baseRevision, ciphertext } = record as Record<string, unknown>;
    const checkedId = checkId(id);
    const base = checkRevision(baseRevision);
    if (seen.has(checkedId)) invalid();
    seen.add(checkedId);
    if (ciphertext === undefined) invalid();
    const sealed = ciphertext === null ? null : checkB64(ciphertext, LIMITS.maxRecordCiphertext);
    total += sealed?.length ?? 0;
    out.push({ id: checkedId, baseRevision: base, ciphertext: sealed });
  }
  if (total > LIMITS.maxPushCiphertext) throw new BackendError("too_large");
  return out;
}
