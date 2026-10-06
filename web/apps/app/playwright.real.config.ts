/**
 * End-to-end tests against the REAL services: the production build with VITE_SERVICES=real, served by the real
 * server (static app, API, SQLite, security headers). By default a server is started here on E2E_REAL_PORT with
 * a throwaway data dir (build/real-data) that the tests scan for plaintext afterwards.
 *
 *   pnpm --filter @opesvault/app e2e:real
 *
 * To run against another deployment (the Docker compose behind Caddy), pass REAL_BASE_URL (self-signed
 * certificates are accepted), e.g. REAL_BASE_URL=https://localhost:8443 pnpm --filter @opesvault/app e2e:real
 */
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env["E2E_REAL_PORT"] ?? 4841);
const external = process.env["REAL_BASE_URL"];
/** Absolute: the server runs from its own package folder. */
const dataDir = resolve("build/real-data");
const staticDir = resolve("build/dist-real");

export default defineConfig({
  testDir: "e2e-real",
  outputDir: "build/test-results-real",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: external ?? `http://localhost:${PORT}`,
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
  },
  ...(external
    ? {}
    : {
        webServer: {
          command:
            `rm -rf ${dataDir} && VITE_SERVICES=real pnpm exec vite build --outDir ${staticDir} && ` +
            `OPESVAULT_DATA_DIR=${dataDir} OPESVAULT_STATIC_DIR=${staticDir} OPESVAULT_SECURE_COOKIES=false ` +
            `PORT=${PORT} HOST=127.0.0.1 pnpm --filter @opesvault/server exec tsx src/main.ts`,
          url: `http://localhost:${PORT}/api/v1/health`,
          reuseExistingServer: false,
          timeout: 240_000,
        },
      }),
});
