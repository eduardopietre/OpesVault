/**
 * Browser security (docs/18 §3.7). The production CSP forbids inline scripts and styles, eval, third-party
 * origins and plugins, and requires Trusted Types for script sinks. The server sends the same policy as a
 * header (with frame-ancestors, which a <meta> cannot carry); `vite preview` gets it as a <meta>.
 */

/** Directives shared by the header and the meta element. */
export const CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  // WebAssembly only (Argon2id); JavaScript eval stays forbidden.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  // The local Ollama is called from the browser (docs/18 §3.6).
  "connect-src 'self' http://localhost:* http://127.0.0.1:*",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "require-trusted-types-for 'script'",
  "trusted-types default",
];

/** The policy as an HTTP header (adds what only a header can say). */
export function cspHeader(): string {
  return [...CSP_DIRECTIVES, "frame-ancestors 'none'"].join("; ");
}

/** The policy for a <meta http-equiv> element. */
export function cspMeta(): string {
  return CSP_DIRECTIVES.join("; ");
}

interface TrustedTypePolicyFactoryLike {
  createPolicy(
    name: string,
    rules: { createScriptURL?: (input: string) => string; createHTML?: (input: string) => string },
  ): unknown;
}

/** A module worker bundled with this app (`something.worker.ts`, emitted as `assets/something.worker-<hash>.js`). */
export function isOwnWorker(url: URL): boolean {
  return url.origin === location.origin && /\/[\w-]+\.worker(-[\w-]+)?\.(js|ts)$/.test(url.pathname);
}

/**
 * The single Trusted Types policy: it lets through only the service worker script and the bundled module workers of this app, and the
 * empty string as HTML (the chart library clears its container with `innerHTML = ""`). Any other string
 * reaching a script sink (innerHTML, script src, eval-like) is refused by the browser.
 */
export function installTrustedTypes(serviceWorkerUrl: string): void {
  const factory = (globalThis as { trustedTypes?: TrustedTypePolicyFactoryLike }).trustedTypes;
  if (!factory) return;
  const allowed = new URL(serviceWorkerUrl, location.href).href;
  try {
    factory.createPolicy("default", {
      createHTML: (input) => {
        if (input === "") return input;
        throw new TypeError("HTML refused by the Trusted Types policy");
      },
      createScriptURL: (input) => {
        const url = new URL(input, location.href);
        if (url.href === allowed) return input;
        if (isOwnWorker(url)) return input;
        throw new TypeError("Script URL refused by the Trusted Types policy");
      },
    });
  } catch {
    // Already installed (hot reload).
  }
}
