import { defineConfig } from "vitest/config";

export default defineConfig({
  // Every persisted kind is registered before any test, as when the app opens a project.
  test: { name: "domain", include: ["test/**/*.test.ts"], environment: "node", setupFiles: ["./src/registry.ts"] },
});
