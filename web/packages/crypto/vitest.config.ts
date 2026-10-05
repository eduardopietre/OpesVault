import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "crypto", include: ["test/**/*.test.ts", "test/**/*.test.tsx"], environment: "node" },
});
