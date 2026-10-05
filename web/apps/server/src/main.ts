/** Entry point: `node server.mjs` in the Docker image, `pnpm server` in development. */
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

const config = loadConfig();
const server = await startServer(config);
console.log(JSON.stringify({ time: new Date().toISOString(), event: "listening", port: server.port }));

let stopping = false;
function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ time: new Date().toISOString(), event: "stopping", signal }));
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  void server.close().then(() => process.exit(0));
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
