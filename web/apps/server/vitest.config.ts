import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "server",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
    // node:sqlite is still flagged experimental in Node 22; the warning is noise in test output.
    execArgv: ["--disable-warning=ExperimentalWarning"],
  },
});
