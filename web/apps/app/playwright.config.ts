/**
 * End-to-end tests against the production build (`vite preview`, with the CSP meta and the service worker),
 * on the preinstalled Chromium (/opt/pw-browsers; never `playwright install`).
 *   pnpm --filter @opesvault/app e2e       behaviour, accessibility, overflow, keyboard
 *   pnpm --filter @opesvault/app screens   screenshots in web/build/telas
 *   pnpm --filter @opesvault/app perf      big-project measurements (perf.html), build/perf/results.json
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env["E2E_PORT"] ?? 4317);
const PERF = process.env["PERF"] === "1";

export default defineConfig({
  testDir: "e2e",
  outputDir: "build/test-results",
  timeout: 60_000,
  fullyParallel: true,
  // Whole-app e2e is CPU heavy; with more workers, timings and mid-animation states turn into flakes.
  workers: process.env.CI ? 2 : 3,
  retries: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${PORT}`,
    serviceWorkers: "block",
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
  },
  webServer: {
    command: PERF
      ? `pnpm build:perf && pnpm exec vite preview --outDir build/dist-perf --port ${PORT} --strictPort`
      : `pnpm build:e2e && pnpm exec vite preview --outDir build/dist-e2e --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}${PERF ? "/perf.html" : ""}`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
  projects: [
    { name: "e2e", testIgnore: /(screens|perf)\.spec\.ts/ },
    { name: "screens", testMatch: /screens\.spec\.ts/ },
    // Big-project measurements (docs/18 W12): `pnpm perf`; never part of the default run.
    { name: "perf", testMatch: /perf\.spec\.ts/, retries: 0, workers: 1, fullyParallel: false },
  ],
});
