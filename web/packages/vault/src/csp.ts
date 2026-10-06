/**
 * The one Content Security Policy (docs/18 §3.7, docs/19 §12). The server sends it as a header and the
 * production build embeds the same directives as a <meta> (for `vite preview` and static hosting);
 * both read this module, and a test compares the built page and the server header.
 *
 * - `default-src 'none'`: every kind of load is allowed explicitly below.
 * - No 'unsafe-inline' and no 'unsafe-eval'. 'wasm-unsafe-eval' allows compiling WebAssembly only
 *   (Argon2id runs in WebAssembly); it does not allow eval of JavaScript.
 * - connect-src allows the local Ollama over loopback (docs/18 §3.6).
 * - Trusted Types are required for every DOM sink that takes script, with one policy named `default`.
 */

/** Directives a <meta http-equiv> element can carry. */
export const CSP_DIRECTIVES: readonly string[] = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' http://localhost:* http://127.0.0.1:*",
  "worker-src 'self'",
  "manifest-src 'self'",
  "media-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "require-trusted-types-for 'script'",
  "trusted-types default",
];

/** What only a header can say (a <meta> ignores these). */
const HEADER_ONLY: readonly string[] = ["frame-ancestors 'none'"];

/** The policy as an HTTP header; `secure` adds upgrade-insecure-requests (HTTPS deployments). */
export function cspHeader(secure = false): string {
  return [...CSP_DIRECTIVES, ...HEADER_ONLY, ...(secure ? ["upgrade-insecure-requests"] : [])].join("; ");
}

/** The policy for a <meta http-equiv> element. */
export function cspMeta(): string {
  return CSP_DIRECTIVES.join("; ");
}
