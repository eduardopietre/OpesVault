/**
 * Browser security (docs/18 §3.7). The production CSP forbids inline scripts and styles, eval, third-party
 * origins and plugins, and requires Trusted Types for script sinks. The server sends the same policy as a
 * header (with frame-ancestors, which a <meta> cannot carry); `vite preview` gets it as a <meta>.
 */

export { CSP_DIRECTIVES, cspHeader, cspMeta } from "@opesvault/vault";

interface TrustedTypePolicyFactoryLike {
  createPolicy(
    name: string,
    rules: { createScriptURL?: (input: string) => string; createHTML?: (input: string) => string },
  ): unknown;
}

/**
 * A module worker bundled with this app: in a production build `assets/<name>.worker-<hash>.js`, and in
 * development (Vite) a `.worker.ts` source under `/src/`. Only the top-level `assets` folder counts, so
 * that no other same-origin path (an API route, an uploaded file) can ever become a worker script.
 */
export function isOwnWorker(url: URL, development: boolean = import.meta.env.DEV): boolean {
  if (url.origin !== location.origin || url.username !== "" || url.password !== "") return false;
  if (/^\/assets\/[\w-]+\.worker-[\w-]+\.js$/.test(url.pathname)) return url.search === "" && url.hash === "";
  return development && /^\/src\/([\w-]+\/)*[\w-]+\.worker\.ts$/.test(url.pathname);
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
