import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { cspMeta } from "./src/security.ts";

/** Production builds carry the CSP as a <meta> for `vite preview`; the server also sends it as a header. */
function contentSecurityPolicy(): Plugin {
  return {
    name: "opesvault-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler: () => [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: cspMeta() },
          injectTo: "head-prepend",
        },
      ],
    },
  };
}

/**
 * Subresource Integrity for the entry scripts, styles and preloads that `index.html` loads (docs/19 §12):
 * a file changed on the server or in transit no longer runs. Lazy chunks reached by `import()` carry no
 * integrity attribute (the browser has no per-import hook without an inline import map, which the CSP forbids);
 * they are same-origin, covered by the CSP, and precached by the service worker.
 */
function subresourceIntegrity(): Plugin {
  let outDir = "";
  return {
    name: "opesvault-sri",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    // After the files are written (so the hashes are those of the bytes on disk, which other plugins may have
    // changed after `transformIndexHtml`) and before the service worker is generated (it hashes index.html).
    async writeBundle() {
      const indexPath = join(outDir, "index.html");
      const html = await readFile(indexPath, "utf8");
      const tags = [...html.matchAll(/<(script|link)\b([^>]*)>/g)];
      let result = html;
      for (const [tag, name, attrs] of tags) {
        if (!tag || !name || attrs === undefined || /\bintegrity=/.test(attrs)) continue;
        const target = /\b(?:src|href)="\/(assets\/[^"]+)"/.exec(attrs)?.[1];
        if (!target) continue;
        if (name === "link" && !/\brel="(?:stylesheet|modulepreload)"/.test(attrs)) continue;
        const digest = createHash("sha384")
          .update(await readFile(join(outDir, target)))
          .digest("base64");
        result = result.replace(tag, tag.replace(/\s*(\/?)>$/, ` integrity="sha384-${digest}"$1>`));
      }
      await writeFile(indexPath, result);
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    contentSecurityPolicy(),
    subresourceIntegrity(),
    VitePWA({
      strategies: "generateSW",
      registerType: "prompt",
      // Registered from the app (UpdatePrompt) through the Trusted Types policy; no inline script.
      injectRegister: null,
      includeAssets: ["icon.svg"],
      manifest: {
        name: "OpesVault",
        short_name: "OpesVault",
        description: "Finanças do projeto, cifradas de ponta a ponta.",
        lang: "pt-BR",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#f2f2f4",
        theme_color: "#0a64c8",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      workbox: {
        // Only the app shell is cached; API responses (encrypted records) are never cached by the worker.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,webmanifest}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: "es2023",
    sourcemap: false,
  },
  server: { port: 5173 },
  preview: { port: 4317, strictPort: true },
});
