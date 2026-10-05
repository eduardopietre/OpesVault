import { runSyncBackendContract } from "../src/contract/index.ts";
import { MemoryServer } from "../src/memory_backend.ts";

runSyncBackendContract("MemoryBackend", async () => {
  const server = new MemoryServer();
  return { a: server.client(), b: server.client(), advanceTime: (ms) => server.advance(ms) };
});
