import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
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
  return {
    name: "opesvault-sri",
    apply: "build",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        const bundle = context.bundle;
        if (!bundle) return html;
        const digest = (path: string): string | null => {
          const item = bundle[path.replace(/^\//, "")];
          if (!item) return null;
          const data = item.type === "chunk" ? item.code : item.source;
          return `sha384-${createHash("sha384").update(data).digest("base64")}`;
        };
        return html.replace(/<(script|link)\b([^>]*)>/g, (tag, name: string, attrs: string) => {
          if (/\bintegrity=/.test(attrs)) return tag;
          const target = /\b(?:src|href)="(\/assets\/[^"]+)"/.exec(attrs)?.[1];
          if (!target) return tag;
          if (name === "link" && !/\brel="(?:stylesheet|modulepreload)"/.test(attrs)) return tag;
          const integrity = digest(target);
          if (integrity === null) throw new Error(`SRI: ${target} is not in the bundle`);
          return tag.replace(/\s*(\/?)>$/, ` integrity="${integrity}"$1>`);
        });
      },
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
