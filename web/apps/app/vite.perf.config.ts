/**
 * Build of the measurement page (perf.html): the same app code with a big generated project, without the
 * service worker and the CSP. `pnpm --filter @opesvault/app build:perf`; used by `e2e/perf.spec.ts`.
 */
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: "es2023",
    sourcemap: false,
    outDir: "build/dist-perf",
    emptyOutDir: true,
    rollupOptions: { input: "perf.html" },
  },
});
