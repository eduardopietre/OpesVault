/**
 * The HTTP API (`/api/v1`) and the static app, on Hono.
 *
 * - Every mutating request needs the `X-OpesVault: 1` header (CSRF: a cross-site form or a
 *   simple cross-origin request cannot set it, and there is no CORS).
 * - Sessions are random tokens in an HttpOnly, SameSite=Strict cookie (Secure unless disabled
 *   for local development); the database keeps only their SHA-256.
 * - Bodies are size-limited per route and validated with zod, then by the shared rules.
 * - Logs carry method, route template, status, duration and the opaque project id only.
 */
import { getConnInfo } from "@hono/node-server/conninfo";
import { BackendError, LIMITS, type BackendErrorCode } from "@opesvault/vault";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { matchedRoutes } from "hono/route";
import { z } from "zod";
import { RateLimiter } from "./rate_limit.ts";
import { securityHeaders } from "./security.ts";
import { SESSION_MS, type Me, type Service } from "./service.ts";
import type { StaticSite } from "./static.ts";

export const CSRF_HEADER = "x-opesvault";
export const LEASE_HEADER = "x-opesvault-lease";

export interface LogEntry {
  readonly time: string;
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly ms: number;
  readonly project?: string;
}

export interface AppOptions {
  readonly service: Service;
  readonly secureCookies: boolean;
  readonly trustProxy: boolean;
  /** Every API request per IP per minute (excluding /health). */
  readonly requestsPerMinute?: number;
  /** Lookups per IP per minute (login salt), and project creations and member additions per account per minute. */
  readonly sensitivePerMinute?: number;
  readonly site?: StaticSite | null;
  readonly log?: (entry: LogEntry) => void;
}

export const STATUS: Record<BackendErrorCode, 400 | 401 | 403 | 404 | 409 | 413 | 423 | 429 | 500 | 503> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  no_lease: 409,
  lease_held: 423,
  too_large: 413,
  rate_limited: 429,
  server: 500,
  offline: 503,
};

const JSON_LIMIT = 256 * 1024;
const PUSH_LIMIT = LIMITS.maxPushCiphertext + 4 * 1024 * 1024;
const BLOB_LIMIT = LIMITS.maxBlobBytes + 64 * 1024;

const Text = z.string();
const EnvelopeSchema = z.strictObject({
  version: z.number(),
  kdf: z.strictObject({
    algorithm: z.literal("argon2id"),
    memoryKiB: z.number(),
    iterations: z.number(),
    parallelism: z.number(),
    salt: Text,
  }),
  wrappedByPassword: Text,
  recoverySalt: Text.nullable(),
  wrappedByRecovery: Text.nullable(),
});
const Schemas = {
  auth: z.strictObject({ email: Text, loginSecret: Text }),
  createProject: z.strictObject({ projectId: Text, sealedName: Text, envelope: EnvelopeSchema }),
  rename: z.strictObject({ sealedName: Text }),
  member: z.strictObject({ email: Text }),
  envelope: z.strictObject({ envelope: EnvelopeSchema, expectedRevision: z.number() }),
  push: z.strictObject({
    leaseId: Text,
    records: z.array(z.strictObject({ id: Text, baseRevision: z.number(), ciphertext: Text.nullable() })),
  }),
  acquire: z.strictObject({ holder: Text, takeOver: z.boolean().optional() }),
  lease: z.strictObject({ leaseId: Text }),
  pullQuery: z.strictObject({
    since: z
      .string()
      .regex(/^\d{1,15}$/)
      .transform(Number),
    limit: z
      .string()
      .regex(/^\d{1,6}$/)
      .transform(Number)
      .optional(),
  }),
  salt: z.strictObject({ email: Text }),
};

async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw new BackendError("invalid");
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new BackendError("invalid");
  return result.data;
}

function parseQuery<T extends z.ZodType>(c: Context, schema: T): z.output<T> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw new BackendError("invalid");
  return result.data;
}

function bodyLimitFor(method: string, path: string): number {
  if (method === "PUT" && /\/blobs\/[^/]+$/.test(path)) return BLOB_LIMIT;
  if (method === "POST" && path.endsWith("/records")) return PUSH_LIMIT;
  return JSON_LIMIT;
}

/** The route template of the handler that answered (middleware is registered for every method). */
function routeTemplate(c: Context): string {
  return matchedRoutes(c).find((route) => route.method !== "ALL")?.path ?? "(none)";
}

const PROJECT_IN_PATH = /\/projects\/([0-9a-f]{32})(?:\/|$)/;

export function createApp(options: AppOptions): Hono {
  const { service } = options;
  const cookieName = options.secureCookies ? "__Host-opesvault-session" : "opesvault-session";
  const log = options.log ?? ((entry: LogEntry) => console.log(JSON.stringify(entry)));
  const headers = securityHeaders(options.secureCookies);
  const app = new Hono();

  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    const project = PROJECT_IN_PATH.exec(c.req.path)?.[1];
    log({
      time: new Date().toISOString(),
      method: c.req.method,
      route: routeTemplate(c),
      status: c.res.status,
      ms: Math.round((performance.now() - start) * 10) / 10,
      ...(project ? { project } : {}),
    });
  });

  app.use("*", async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
  });

  app.use("/api/*", async (c, next) => {
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    if (mutating && c.req.header(CSRF_HEADER) !== "1") throw new BackendError("forbidden");
    await next();
    c.res.headers.set("Cache-Control", "no-store");
  });

  app.use("/api/*", (c, next) =>
    bodyLimit({
      maxSize: bodyLimitFor(c.req.method, c.req.path),
      onError: () => {
        throw new BackendError("too_large");
      },
    })(c, next),
  );

  app.onError((error, c) => {
    const code: BackendErrorCode = error instanceof BackendError ? error.code : "server";
    if (code === "server") {
      // Only the error's type: messages may carry data.
      console.error(JSON.stringify({ time: new Date().toISOString(), error: error.name, route: routeTemplate(c) }));
    }
    return c.json({ error: code }, STATUS[code]);
  });

  const clientIp = (c: Context): string => {
    if (options.trustProxy) {
      const forwarded = c.req.header("x-forwarded-for");
      const last = forwarded?.split(",").at(-1)?.trim();
      if (last) return last;
    }
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  };

  const now = (): number => service.now();
  const everyRequest = new RateLimiter(options.requestsPerMinute ?? 600, 60_000, now);
  const lookups = new RateLimiter(options.sensitivePerMinute ?? 60, 60_000, now);
  const accountActions = new RateLimiter(options.sensitivePerMinute ?? 60, 60_000, now);

  // A generous ceiling for the whole API (a household behind one address syncs several tabs), so that
  // no route is an open door for scraping or flooding; sign-in and sign-up have tighter limits in the service.
  app.use("/api/*", async (c, next) => {
    if (c.req.path !== "/api/v1/health" && !everyRequest.hit(clientIp(c))) throw new BackendError("rate_limited");
    await next();
  });

  const limitAccountAction = (account: Me, action: string): void => {
    if (!accountActions.hit(`${action}\n${account.id}`)) throw new BackendError("rate_limited");
  };

  const me = async (c: Context): Promise<Me> => {
    const account = await service.sessionOf(getCookie(c, cookieName));
    if (account === null) throw new BackendError("unauthorized");
    return account;
  };

  const startSession = (c: Context, token: string): void => {
    setCookie(c, cookieName, token, {
      httpOnly: true,
      secure: options.secureCookies,
      sameSite: "Strict",
      path: "/",
      maxAge: Math.floor(SESSION_MS / 1000),
    });
  };

  const api = new Hono();

  api.get("/health", (c) => c.json({ ok: true }));

  // accounts
  // POST so that the email never appears in a URL (proxy logs, history).
  api.post("/auth/salt", async (c) => {
    // The answer is the same whether or not the account exists, but each call still costs an HMAC and
    // a probe of many emails is not a normal use: limit per IP.
    if (!lookups.hit(clientIp(c))) throw new BackendError("rate_limited");
    return c.json({ salt: service.loginSalt((await parseBody(c, Schemas.salt)).email) });
  });
  api.post("/auth/signup", async (c) => {
    const body = await parseBody(c, Schemas.auth);
    const { session, token } = await service.signUp(body.email, body.loginSecret, clientIp(c));
    startSession(c, token);
    return c.json(session);
  });
  api.post("/auth/signin", async (c) => {
    const body = await parseBody(c, Schemas.auth);
    const { session, token } = await service.signIn(body.email, body.loginSecret, clientIp(c));
    startSession(c, token);
    return c.json(session);
  });
  api.post("/auth/signout", async (c) => {
    await service.signOut(getCookie(c, cookieName));
    deleteCookie(c, cookieName, { path: "/", secure: options.secureCookies });
    return c.body(null, 204);
  });
  api.get("/auth/session", async (c) => {
    const account = await service.sessionOf(getCookie(c, cookieName));
    return c.json({ session: account === null ? null : { accountId: account.id, email: account.email } });
  });

  // projects
  api.get("/projects", async (c) => c.json({ projects: await service.listProjects(await me(c)) }));
  api.post("/projects", async (c) => {
    const account = await me(c);
    limitAccountAction(account, "create-project");
    const body = await parseBody(c, Schemas.createProject);
    return c.json(await service.createProject(account, body.projectId, body.sealedName, body.envelope));
  });
  api.patch("/projects/:projectId", async (c) => {
    const account = await me(c);
    await service.requireMember(account, c.req.param("projectId"));
    const body = await parseBody(c, Schemas.rename);
    await service.renameProject(account, c.req.param("projectId"), body.sealedName);
    return c.body(null, 204);
  });
  api.delete("/projects/:projectId", async (c) => {
    await service.deleteProject(await me(c), c.req.param("projectId"));
    return c.body(null, 204);
  });

  // members
  api.get("/projects/:projectId/members", async (c) =>
    c.json({ members: await service.listMembers(await me(c), c.req.param("projectId")) }),
  );
  api.post("/projects/:projectId/members", async (c) => {
    const account = await me(c);
    await service.requireMember(account, c.req.param("projectId"));
    // "no such account" is an answer about other people's accounts: slow down a probe of many emails.
    limitAccountAction(account, "add-member");
    const body = await parseBody(c, Schemas.member);
    return c.json(await service.addMember(account, c.req.param("projectId"), body.email));
  });
  api.delete("/projects/:projectId/members/:accountId", async (c) => {
    await service.removeMember(await me(c), c.req.param("projectId"), c.req.param("accountId"));
    return c.body(null, 204);
  });

  // envelope
  api.get("/projects/:projectId/envelope", async (c) =>
    c.json(await service.getEnvelope(await me(c), c.req.param("projectId"))),
  );
  api.put("/projects/:projectId/envelope", async (c) => {
    const account = await me(c);
    await service.requireMember(account, c.req.param("projectId"));
    const body = await parseBody(c, Schemas.envelope);
    return c.json(await service.putEnvelope(account, c.req.param("projectId"), body.envelope, body.expectedRevision));
  });

  // records
  api.get("/projects/:projectId/records", async (c) => {
    const account = await me(c);
    await service.requireMember(account, c.req.param("projectId"));
    const query = parseQuery(c, Schemas.pullQuery);
    return c.json(
      await service.pull(account, c.req.param("projectId"), query.since, query.limit ?? LIMITS.defaultPullLimit),
    );
  });
  api.post("/projects/:projectId/records", async (c) => {
    const account = await me(c);
    await service.requireMember(account, c.req.param("projectId"));
    const body = await parseBody(c, Schemas.push);
    return c.json(await service.push(account, c.req.param("projectId"), body.leaseId, body.records));
  });

  // blobs
  api.put("/projects/:projectId/blobs/:blobId", async (c) => {
    const account = await me(c);
    await service.requireMember(account, c.req.param("projectId"));
    const data = new Uint8Array(await c.req.arrayBuffer());
    await service.putBlob(account, c.req.param("projectId"), c.req.header(LEASE_HEADER), c.req.param("blobId"), data);
    return c.body(null, 204);
  });
  api.get("/projects/:projectId/blobs/:blobId", async (c) => {
    const data = await service.getBlob(await me(c), c.req.param("projectId"), c.req.param("blobId"));
    return c.body(data as Uint8Array<ArrayBuffer>, 200, { "Content-Type": "application/octet-stream" });
  });
  api.delete("/projects/:projectId/blobs/:blobId", async (c) => {
    await service.deleteBlob(await me(c), c.req.param("projectId"), c.req.header(LEASE_HEADER), c.req.param("blobId"));
    return c.body(null, 204);
  });

  // edit lease
  api.get("/projects/:projectId/lease", async (c) =>
    c.json({ lease: await service.currentLease(await me(c), c.req.param("projectId")) }),
  );
  api.post("/projects/:projectId/lease", async (c) => {
    const account = await me(c);
    await service.requireMember(account, c.req.param("projectId"));
    const body = await parseBody(c, Schemas.acquire);
    return c.json(await service.acquireLease(account, c.req.param("projectId"), body.holder, body.takeOver));
  });
  api.post("/projects/:projectId/lease/renew", async (c) => {
    const account = await me(c);
    await service.requireMember(account, c.req.param("projectId"));
    const body = await parseBody(c, Schemas.lease);
    return c.json(await service.renewLease(account, c.req.param("projectId"), body.leaseId));
  });
  api.post("/projects/:projectId/lease/release", async (c) => {
    const account = await me(c);
    await service.requireMember(account, c.req.param("projectId"));
    const body = await parseBody(c, Schemas.lease);
    await service.releaseLease(account, c.req.param("projectId"), body.leaseId);
    return c.body(null, 204);
  });

  app.route("/api/v1", api);
  app.all("/api/*", () => {
    throw new BackendError("not_found");
  });

  app.on(["GET", "HEAD"], "*", async (c) => {
    const file = await options.site?.serve(c.req.path);
    if (!file) return c.text("Not found", 404);
    return c.body(file.body as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": file.type,
      "Cache-Control": file.cacheControl,
    });
  });

  return app;
}
