/**
 * End-to-end tests against the production build (`vite preview`, with the CSP meta and the service worker),
 * on the preinstalled Chromium (/opt/pw-browsers; never `playwright install`).
 *   pnpm --filter @opesvault/app e2e       behaviour, accessibility, overflow, keyboard
 *   pnpm --filter @opesvault/app screens   screenshots in web/build/telas
 */
import { defineConfig, devices } from "@playwright/test";

// Each worktree can use its own port (OPESVAULT_E2E_PORT), so parallel runs do not share a server.
const PORT = Number(process.env["OPESVAULT_E2E_PORT"] ?? 4317);

export default defineConfig({
  testDir: "e2e",
  outputDir: "build/test-results",
  timeout: 60_000,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${PORT}`,
    serviceWorkers: "block",
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
  },
  webServer: {
    command: `pnpm build:e2e && pnpm exec vite preview --outDir build/dist-e2e --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
  projects: [
    { name: "e2e", testIgnore: /screens\.spec\.ts/ },
    { name: "screens", testMatch: /screens\.spec\.ts/ },
  ],
});
