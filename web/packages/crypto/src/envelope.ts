/**
 * The key envelope: the project key wrapped by the password and by the recovery key (docs/19 §4).
 *
 *   passwordKey = HKDF(Argon2id(password, kdf.salt), info "opesvault/envelope/password/v1")
 *   recoveryKey = HKDF(recovery bytes, recoverySalt, info "opesvault/envelope/recovery/v1")
 *   wrapped     = version || nonce || AES-256-GCM(key, projectKey, AAD)
 *   AAD         = version || "opesvault/envelope/v1|" + projectId + "|" + purpose
 *
 * Changing the password or regenerating the recovery key only re-wraps the same project key.
 * A password that does not open the envelope is `wrong_password`; it never creates anything.
 */
import { argon2id, checkKdfParams, DEFAULT_KDF, SALT_BYTES, type KdfParams } from "./argon2.ts";
import { fromB64, toB64, utf8, wipe, type B64, type Bytes } from "./bytes.ts";
import { CryptoError } from "./errors.ts";
import { hkdfAesKey, importHkdfKey, KEY_BYTES, open, seal } from "./primitives.ts";
import { ProjectKeys } from "./project_keys.ts";
import { generateRecoveryKey, parseRecoveryKey } from "./recovery.ts";
import { systemRandom, type RandomSource } from "./random.ts";

export const ENVELOPE_VERSION = 1;
const WRAP_VERSION = 1;

export interface EnvelopeKdf extends KdfParams {
  readonly salt: B64;
}

/** The envelope's content. The backend adds its own `revision` (see `@opesvault/vault`). */
export interface EnvelopeData {
  readonly version: number;
  readonly kdf: EnvelopeKdf;
  readonly wrappedByPassword: B64;
  readonly recoverySalt: B64 | null;
  readonly wrappedByRecovery: B64 | null;
}

export interface EnvelopeOptions {
  /** Argon2id parameters for new wraps (tests use lighter ones). */
  readonly kdf?: KdfParams;
  /** Tests only: fixed randomness for known-answer vectors. */
  readonly random?: RandomSource;
}

type Purpose = "password" | "recovery";

function aad(projectId: string, purpose: Purpose): Bytes {
  return utf8(`opesvault/envelope/v${ENVELOPE_VERSION}|${projectId}|${purpose}`);
}

function decode(text: B64): Bytes {
  try {
    return fromB64(text);
  } catch {
    throw new CryptoError("invalid_format");
  }
}

async function passwordWrappingKey(password: string, salt: Bytes, params: KdfParams): Promise<CryptoKey> {
  const stretched = await argon2id(password, salt, params);
  try {
    return await hkdfAesKey(await importHkdfKey(stretched), utf8("opesvault/envelope/password/v1"));
  } finally {
    wipe(stretched);
  }
}

async function recoveryWrappingKey(recovery: Bytes, salt: Bytes): Promise<CryptoKey> {
  return hkdfAesKey(await importHkdfKey(recovery), utf8("opesvault/envelope/recovery/v1"), salt);
}

async function wrapWithPassword(
  projectId: string,
  projectKey: Bytes,
  password: string,
  params: KdfParams,
  random: RandomSource,
): Promise<{ kdf: EnvelopeKdf; wrapped: B64 }> {
  checkKdfParams(params);
  const salt = random(SALT_BYTES);
  const key = await passwordWrappingKey(password, salt, params);
  const wrapped = await seal(key, projectKey, aad(projectId, "password"), WRAP_VERSION, random);
  const kdf: EnvelopeKdf = {
    algorithm: "argon2id",
    memoryKiB: params.memoryKiB,
    iterations: params.iterations,
    parallelism: params.parallelism,
    salt: toB64(salt),
  };
  return { kdf, wrapped: toB64(wrapped) };
}

async function wrapWithRecovery(
  projectId: string,
  projectKey: Bytes,
  random: RandomSource,
): Promise<{ recoverySalt: B64; wrapped: B64; text: string }> {
  const recovery = generateRecoveryKey(random);
  const salt = random(SALT_BYTES);
  try {
    const key = await recoveryWrappingKey(recovery.bytes, salt);
    const wrapped = await seal(key, projectKey, aad(projectId, "recovery"), WRAP_VERSION, random);
    return { recoverySalt: toB64(salt), wrapped: toB64(wrapped), text: recovery.text };
  } finally {
    wipe(recovery.bytes);
  }
}

function checkEnvelope(envelope: EnvelopeData): void {
  if (envelope.version !== ENVELOPE_VERSION) throw new CryptoError("invalid_format");
  checkKdfParams(envelope.kdf);
}

/** Opens the project key with the password. The caller wipes the returned bytes. */
async function unwrapWithPassword(projectId: string, envelope: EnvelopeData, password: string): Promise<Bytes> {
  checkEnvelope(envelope);
  if (password.length === 0) throw new CryptoError("wrong_password");
  const key = await passwordWrappingKey(password, decode(envelope.kdf.salt), envelope.kdf);
  try {
    const raw = await open(key, decode(envelope.wrappedByPassword), aad(projectId, "password"), WRAP_VERSION);
    if (raw.length !== KEY_BYTES) throw new CryptoError("invalid_format");
    return raw;
  } catch (error) {
    if (error instanceof CryptoError && error.code === "decrypt_failed") throw new CryptoError("wrong_password");
    throw error;
  }
}

async function unwrapWithRecovery(projectId: string, envelope: EnvelopeData, recoveryKey: string): Promise<Bytes> {
  checkEnvelope(envelope);
  const recovery = parseRecoveryKey(recoveryKey);
  if (envelope.recoverySalt === null || envelope.wrappedByRecovery === null) {
    wipe(recovery);
    throw new CryptoError("wrong_recovery_key");
  }
  try {
    const key = await recoveryWrappingKey(recovery, decode(envelope.recoverySalt));
    const raw = await open(key, decode(envelope.wrappedByRecovery), aad(projectId, "recovery"), WRAP_VERSION);
    if (raw.length !== KEY_BYTES) throw new CryptoError("invalid_format");
    return raw;
  } catch (error) {
    if (error instanceof CryptoError && error.code === "decrypt_failed") throw new CryptoError("wrong_recovery_key");
    throw error;
  } finally {
    wipe(recovery);
  }
}

export interface NewProjectSecrets {
  readonly envelope: EnvelopeData;
  /** Shown to the user once; never stored or sent anywhere by the app. */
  readonly recoveryKey: string;
  readonly keys: ProjectKeys;
}

/** A new random project key, wrapped by the password and by a new recovery key. */
export async function createProjectSecrets(
  projectId: string,
  password: string,
  options: EnvelopeOptions = {},
): Promise<NewProjectSecrets> {
  const random = options.random ?? systemRandom;
  const projectKey = random(KEY_BYTES);
  try {
    const byPassword = await wrapWithPassword(projectId, projectKey, password, options.kdf ?? DEFAULT_KDF, random);
    const byRecovery = await wrapWithRecovery(projectId, projectKey, random);
    const keys = await ProjectKeys.fromProjectKey(projectId, projectKey);
    return {
      envelope: {
        version: ENVELOPE_VERSION,
        kdf: byPassword.kdf,
        wrappedByPassword: byPassword.wrapped,
        recoverySalt: byRecovery.recoverySalt,
        wrappedByRecovery: byRecovery.wrapped,
      },
      recoveryKey: byRecovery.text,
      keys,
    };
  } finally {
    wipe(projectKey);
  }
}

export async function openWithPassword(
  projectId: string,
  envelope: EnvelopeData,
  password: string,
): Promise<ProjectKeys> {
  const raw = await unwrapWithPassword(projectId, envelope, password);
  try {
    return await ProjectKeys.fromProjectKey(projectId, raw);
  } finally {
    wipe(raw);
  }
}

/**
 * Opens the project with the recovery key and sets a new password. The recovery key keeps
 * working: the user regenerates it separately if it may have been exposed.
 */
export async function openWithRecoveryKey(
  projectId: string,
  envelope: EnvelopeData,
  recoveryKey: string,
  newPassword: string,
  options: EnvelopeOptions = {},
): Promise<{ keys: ProjectKeys; envelope: EnvelopeData }> {
  const raw = await unwrapWithRecovery(projectId, envelope, recoveryKey);
  try {
    const byPassword = await wrapWithPassword(
      projectId,
      raw,
      newPassword,
      options.kdf ?? DEFAULT_KDF,
      options.random ?? systemRandom,
    );
    const keys = await ProjectKeys.fromProjectKey(projectId, raw);
    return { keys, envelope: { ...envelope, kdf: byPassword.kdf, wrappedByPassword: byPassword.wrapped } };
  } finally {
    wipe(raw);
  }
}

/** Re-wraps the same project key under a new password (fresh salt). The current password is required. */
export async function changeEnvelopePassword(
  projectId: string,
  envelope: EnvelopeData,
  currentPassword: string,
  newPassword: string,
  options: EnvelopeOptions = {},
): Promise<EnvelopeData> {
  const raw = await unwrapWithPassword(projectId, envelope, currentPassword);
  try {
    const byPassword = await wrapWithPassword(
      projectId,
      raw,
      newPassword,
      options.kdf ?? DEFAULT_KDF,
      options.random ?? systemRandom,
    );
    return { ...envelope, kdf: byPassword.kdf, wrappedByPassword: byPassword.wrapped };
  } finally {
    wipe(raw);
  }
}

/** A new recovery key replaces the old wrap; the old key stops opening this envelope. */
export async function regenerateEnvelopeRecoveryKey(
  projectId: string,
  envelope: EnvelopeData,
  password: string,
  options: EnvelopeOptions = {},
): Promise<{ envelope: EnvelopeData; recoveryKey: string }> {
  const raw = await unwrapWithPassword(projectId, envelope, password);
  try {
    const byRecovery = await wrapWithRecovery(projectId, raw, options.random ?? systemRandom);
    return {
      envelope: { ...envelope, recoverySalt: byRecovery.recoverySalt, wrappedByRecovery: byRecovery.wrapped },
      recoveryKey: byRecovery.text,
    };
  } finally {
    wipe(raw);
  }
}
