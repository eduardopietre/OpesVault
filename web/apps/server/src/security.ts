/**
 * Security headers for every response (docs/18 §3.7, docs/19 §12).
 *
 * - CSP without 'unsafe-inline' or 'unsafe-eval'. 'wasm-unsafe-eval' allows compiling WebAssembly
 *   only (Argon2id runs in WebAssembly); it does not allow eval of JavaScript.
 * - connect-src allows the local Ollama over loopback (docs/18 §3.6).
 * - Trusted Types are required for every DOM sink that takes script.
 */
export function contentSecurityPolicy(secure: boolean): string {
  const directives = [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' http://localhost:* http://127.0.0.1:*",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
  ];
  if (secure) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "bluetooth=()",
  "browsing-topics=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "serial=()",
  "usb=()",
].join(", ");

export function securityHeaders(secure: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": contentSecurityPolicy(secure),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
  if (secure) headers["Strict-Transport-Security"] = "max-age=31536000";
  return headers;
}
