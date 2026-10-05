import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "backend-http", include: ["test/**/*.test.ts", "test/**/*.test.tsx"], environment: "node" },
});
