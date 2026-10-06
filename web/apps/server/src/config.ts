/**
 * Server configuration from the environment (docs/20 §3).
 *
 * PORT                      listening port (8080)
 * HOST                      listening address (0.0.0.0)
 * OPESVAULT_DATA_DIR        database, blobs and generated secret (./.data)
 * OPESVAULT_SECRET          the server secret, or a path to a file holding it; generated in the
 *                           data dir on first start when absent. Keep it: login salts depend on it.
 * OPESVAULT_SECRET_FILE     path to a file holding the secret (Docker secrets)
 * OPESVAULT_SECURE_COOKIES  "false" only for local development over plain http (true)
 * OPESVAULT_TRUST_PROXY     "true" behind Caddy: client IP from X-Forwarded-For (false)
 * OPESVAULT_STATIC_DIR      the built app to serve (none: API only)
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly dataDir: string;
  readonly secret: Buffer;
  readonly secureCookies: boolean;
  readonly trustProxy: boolean;
  readonly staticDir: string | null;
  /** scrypt cost for stored login secrets (2^15 in production; tests use less). */
  readonly scryptN: number;
  /** Sign-in and sign-up attempts per IP per minute. */
  readonly ipAttemptsPerMinute: number;
  /** Failed sign-ins per email per 15 minutes. */
  readonly emailFailuresPer15Minutes: number;
  /** Every API request per IP per minute. */
  readonly requestsPerMinute: number;
  /** Login-salt lookups per IP, project creations and member additions per account, per minute. */
  readonly sensitivePerMinute: number;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

const MIN_SECRET_LENGTH = 32;

/** Reads the secret from a value, a file, or the data dir (creating it there with mode 0600). */
export function loadSecret(env: NodeJS.ProcessEnv, dataDir: string): Buffer {
  const fromFile = (path: string): Buffer => Buffer.from(readFileSync(path, "utf8").trim(), "utf8");
  let secret: Buffer;
  if (env.OPESVAULT_SECRET_FILE) secret = fromFile(env.OPESVAULT_SECRET_FILE);
  else if (env.OPESVAULT_SECRET) {
    const value = env.OPESVAULT_SECRET;
    const looksLikePath = isAbsolute(value) || value.startsWith("./") || value.startsWith("../");
    secret = looksLikePath && existsSync(value) ? fromFile(value) : Buffer.from(value, "utf8");
  } else {
    const path = join(dataDir, "secret");
    if (!existsSync(path)) writeFileSync(path, randomBytes(48).toString("base64url"), { mode: 0o600, flag: "wx" });
    secret = fromFile(path);
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`OPESVAULT_SECRET must have at least ${MIN_SECRET_LENGTH} characters`);
  }
  return secret;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = resolve(env.OPESVAULT_DATA_DIR ?? ".data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const port = Number.parseInt(env.PORT ?? "8080", 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT is not a valid port");
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    dataDir,
    secret: loadSecret(env, dataDir),
    secureCookies: flag(env.OPESVAULT_SECURE_COOKIES, true),
    trustProxy: flag(env.OPESVAULT_TRUST_PROXY, false),
    staticDir: env.OPESVAULT_STATIC_DIR ? resolve(env.OPESVAULT_STATIC_DIR) : null,
    scryptN: 1 << 15,
    ipAttemptsPerMinute: 30,
    emailFailuresPer15Minutes: 10,
    requestsPerMinute: 600,
    sensitivePerMinute: 60,
  };
}
