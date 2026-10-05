import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "vault", include: ["test/**/*.test.ts", "test/**/*.test.tsx"], environment: "node" },
});
