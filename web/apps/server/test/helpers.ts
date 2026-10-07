import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cookieJarFetch, HttpBackend } from "@opesvault/backend-http";
import { afterEach } from "vitest";
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
    requestsPerMinute: 1_000_000,
    sensitivePerMinute: 1_000_000,
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

/** The headers every mutating request of the app carries (the CSRF header and JSON). */
export const JSON_HEADERS = { "X-OpesVault": "1", "Content-Type": "application/json" } as const;

export interface ServerFixture {
  /** Starts a server for the running test; it is stopped (and its data removed) after the test. */
  start(overrides?: Partial<ServerConfig>): Promise<TestServer>;
  /** The server the running test started last. */
  readonly current: TestServer;
  /** A plain request to the current server. */
  call(path: string, init?: RequestInit): Promise<Response>;
  /** A JSON POST with the app's headers (plus `headers`). */
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
}

/** A test server per test of the file that calls this at its top (it registers an `afterEach` that stops it). */
export function useTestServer(): ServerFixture {
  let current: TestServer | null = null;
  afterEach(async () => {
    await current?.dispose();
    current = null;
  });
  const fixture: ServerFixture = {
    start: async (overrides = {}) => (current = await testServer(overrides)),
    get current() {
      if (!current) throw new Error("no test server started");
      return current;
    },
    call: (path, init = {}) => fetch(`${fixture.current.server.url}${path}`, init),
    post: (path, body, headers = {}) =>
      fixture.call(path, { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) }),
  };
  return fixture;
}
