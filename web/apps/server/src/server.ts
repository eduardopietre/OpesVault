/**
 * Builds and starts the server: storage, blobs, service, HTTP app, periodic cleanup and graceful
 * shutdown. Tests start it in-process on a random port.
 */
import { createAdaptorServer } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createApp, type LogEntry } from "./app.ts";
import { BlobStore } from "./blob_store.ts";
import type { ServerConfig } from "./config.ts";
import { Service } from "./service.ts";
import { SqliteStorage } from "./sqlite_storage.ts";
import { StaticSite } from "./static.ts";

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  readonly service: Service;
  close(): Promise<void>;
}

export interface StartOptions {
  readonly now?: () => number;
  readonly log?: (entry: LogEntry) => void;
}

export async function startServer(config: ServerConfig, options: StartOptions = {}): Promise<RunningServer> {
  const storage = new SqliteStorage(join(config.dataDir, "opesvault.db"));
  const service = new Service({
    storage,
    blobs: new BlobStore(config.dataDir),
    secret: config.secret,
    now: options.now ?? Date.now,
    scryptN: config.scryptN,
    ipAttemptsPerMinute: config.ipAttemptsPerMinute,
    emailFailuresPer15Minutes: config.emailFailuresPer15Minutes,
  });
  const app = createApp({
    service,
    secureCookies: config.secureCookies,
    trustProxy: config.trustProxy,
    site: config.staticDir ? new StaticSite(config.staticDir) : null,
    ...(options.log ? { log: options.log } : {}),
  });
  const server = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const cleanup = setInterval(() => void service.cleanup().catch(() => undefined), 60 * 60 * 1000);
  cleanup.unref();
  const { port } = server.address() as AddressInfo;
  const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  let closing: Promise<void> | null = null;
  return {
    url: `http://${host}:${port}`,
    port,
    service,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        clearInterval(cleanup);
        server.close(() => {
          storage.close();
          resolve();
        });
        // Idle keep-alive connections would hold close() open.
        (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
      });
      return closing;
    },
  };
}
