/**
 * Bundles the server into one ESM file (`dist/server.mjs`) for the Docker image: no node_modules
 * at runtime. Node built-ins (node:sqlite, node:crypto…) stay external.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "linked",
  // Some dependencies may still call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
