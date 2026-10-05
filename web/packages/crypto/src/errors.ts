export type CryptoErrorCode =
  /** The password did not open the envelope. Never treated as "a new project". */
  | "wrong_password"
  /** The recovery key is well formed but does not open the envelope. */
  | "wrong_recovery_key"
  /** The recovery key was mistyped (bad character, length or check group). */
  | "invalid_recovery_key"
  /** Authentication failed: the ciphertext was altered, moved or belongs elsewhere. */
  | "decrypt_failed"
  /** Bytes that do not follow the expected format or version. */
  | "invalid_format"
  /** KDF parameters outside the accepted range. */
  | "invalid_params"
  /** A new password (project or account) cannot be empty. */
  | "empty_password";

/** Errors carry only a code: never key material, plaintext or user data. */
export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode) {
    super(code);
    this.name = "CryptoError";
    this.code = code;
  }
}
