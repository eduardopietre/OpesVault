/** The SyncBackend contract against HttpBackend talking to a real server in this process. */
import { runSyncBackendContract } from "@opesvault/vault/contract";
import { testServer } from "./helpers.ts";

runSyncBackendContract("HttpBackend + server (SQLite)", async () => {
  const test = await testServer();
  return { a: test.client(), b: test.client(), advanceTime: (ms) => test.advance(ms), dispose: () => test.dispose() };
});
