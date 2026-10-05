/**
 * Serves the built single-page app: files under the static dir, anything else falls back to
 * index.html (client-side routes). Paths are resolved and must stay inside the static dir.
 */
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

export interface StaticFile {
  readonly body: Uint8Array;
  readonly type: string;
  readonly cacheControl: string;
}

export class StaticSite {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async #file(relative: string): Promise<StaticFile | null> {
    const path = resolve(this.#root, normalize(relative));
    if (path !== this.#root && !path.startsWith(this.#root + sep)) return null;
    try {
      if (!(await stat(path)).isFile()) return null;
      const body = await readFile(path);
      const hashed = relative.startsWith(`assets${sep}`) || relative.startsWith("assets/");
      return {
        body,
        type: TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
        // Built assets carry a content hash in their names; everything else is revalidated.
        cacheControl: hashed ? "public, max-age=31536000, immutable" : "no-cache",
      };
    } catch {
      return null;
    }
  }

  /** The file for a URL path, or index.html for client-side routes; null without an app. */
  async serve(urlPath: string): Promise<StaticFile | null> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (decoded.includes("\0")) return null;
    const relative = join(".", decoded);
    const file = relative === "." ? null : await this.#file(relative);
    if (file !== null) return file;
    // Missing files with an extension are real 404s; extensionless paths are app routes.
    if (extname(decoded) !== "" && !decoded.endsWith(".html")) return null;
    return this.#file("index.html");
  }
}
