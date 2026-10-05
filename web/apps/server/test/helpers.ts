import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cookieJarFetch, HttpBackend } from "@opesvault/backend-http";
import type { LogEntry } from "../src/app.ts";
import type { ServerConfig } from "../src/config.ts";
import { startServer, type RunningServer } from "../src/server.ts";

export function testConfig(dataDir: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    secret: Buffer.from("test-secret-that-is-long-enough-0123456789"),
    secureCookies: false,
    trustProxy: false,
    staticDir: null,
    scryptN: 1 << 10,
    ipAttemptsPerMinute: 10_000,
    emailFailuresPer15Minutes: 10_000,
    ...overrides,
  };
}

export interface TestServer {
  readonly server: RunningServer;
  readonly dataDir: string;
  readonly logs: LogEntry[];
  /** A new "browser": its own cookie jar. */
  client(): HttpBackend;
  advance(ms: number): void;
  /** Stops the server and starts a new one on the same data dir (restart). */
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

export async function testServer(overrides: Partial<ServerConfig> = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), "opesvault-server-"));
  let offset = 0;
  const logs: LogEntry[] = [];
  const options = { now: () => Date.now() + offset, log: (entry: LogEntry) => logs.push(entry) };
  let server = await startServer(testConfig(dataDir, overrides), options);
  const self: TestServer = {
    get server() {
      return server;
    },
    dataDir,
    logs,
    client: () => new HttpBackend({ baseUrl: server.url, fetch: cookieJarFetch() }),
    advance: (ms) => {
      offset += ms;
    },
    restart: async () => {
      const port = server.port;
      await server.close();
      server = await startServer(testConfig(dataDir, { ...overrides, port }), options);
    },
    dispose: async () => {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return self;
}
