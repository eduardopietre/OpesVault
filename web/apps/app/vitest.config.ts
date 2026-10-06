import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "virtual:pwa-register/react": fileURLToPath(new URL("./test/pwa-register-stub.ts", import.meta.url)),
    },
  },
  test: {
    name: "app",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "happy-dom",
    // Page tests render whole screens over the demo project; under a full parallel run 5 s is too tight.
    testTimeout: 30_000,
    setupFiles: ["test/setup.ts"],
  },
});
