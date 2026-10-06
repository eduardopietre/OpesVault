/** Server security review (docs/19 §12, §14): CSRF on every mutating route, rate limits, sessions, one CSP. */
import { cspHeader } from "@opesvault/vault";
import { afterEach, describe, expect, it } from "vitest";
import { testServer, type TestServer } from "./helpers.ts";

let test: TestServer | null = null;
afterEach(async () => {
  await test?.dispose();
  test = null;
});

const SECRET = "A".repeat(43);
const JSON_HEADERS = { "X-OpesVault": "1", "Content-Type": "application/json" };
const ID = "0123456789abcdef0123456789abcdef";

const call = (path: string, init: RequestInit = {}): Promise<Response> => fetch(`${test!.server.url}${path}`, init);
const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  call(path, { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
const cookieOf = (response: Response): string => /^[^=]+=[^;]+/.exec(response.headers.get("set-cookie") ?? "")![0];

describe("one policy", () => {
  it("the server header is the shared policy, with HTTPS upgrade only when secure", async () => {
    test = await testServer();
    expect((await call("/api/v1/health")).headers.get("content-security-policy")).toBe(cspHeader(false));
    await test.dispose();
    test = await testServer({ secureCookies: true });
    expect((await call("/api/v1/health")).headers.get("content-security-policy")).toBe(cspHeader(true));
  });

  it("allows nothing by default and no blob workers or media", () => {
    const policy = cspHeader(true);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("worker-src 'self';");
    expect(policy).toContain("media-src 'none'");
    expect(policy).toContain("trusted-types default");
    expect(policy).not.toMatch(/'unsafe-(inline|eval)'/);
  });
});

describe("CSRF header", () => {
  const mutating: [string, string][] = [
    ["POST", "/api/v1/auth/salt"],
    ["POST", "/api/v1/auth/signup"],
    ["POST", "/api/v1/auth/signin"],
    ["POST", "/api/v1/auth/signout"],
    ["POST", "/api/v1/projects"],
    ["PATCH", `/api/v1/projects/${ID}`],
    ["DELETE", `/api/v1/projects/${ID}`],
    ["POST", `/api/v1/projects/${ID}/members`],
    ["DELETE", `/api/v1/projects/${ID}/members/${ID}`],
    ["PUT", `/api/v1/projects/${ID}/envelope`],
    ["POST", `/api/v1/projects/${ID}/records`],
    ["PUT", `/api/v1/projects/${ID}/blobs/${ID}`],
    ["DELETE", `/api/v1/projects/${ID}/blobs/${ID}`],
    ["POST", `/api/v1/projects/${ID}/lease`],
    ["POST", `/api/v1/projects/${ID}/lease/renew`],
    ["POST", `/api/v1/projects/${ID}/lease/release`],
  ];

  it.each(mutating)("%s %s without the header is refused before anything else", async (method, path) => {
    test = await testServer();
    for (const headers of [{}, { "X-OpesVault": "0" }, { "X-OpesVault": "true" }]) {
      const response = await call(path, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: "{}",
      });
      expect(response.status, JSON.stringify(headers)).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
  });

  it("reads need no header but never reveal anything without a session", async () => {
    test = await testServer();
    for (const path of [
      "/api/v1/projects",
      `/api/v1/projects/${ID}/envelope`,
      `/api/v1/projects/${ID}/records?since=0`,
    ]) {
      expect((await call(path)).status).toBe(401);
    }
  });

  it("has no CORS: a cross-origin page cannot even preflight", async () => {
    test = await testServer();
    const response = await call("/api/v1/auth/signin", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("sessions", () => {
  it("never adopts a token the client chose (no fixation), and a new sign-in gets a new token", async () => {
    test = await testServer();
    await post("/api/v1/auth/signup", { email: "ana@example.com", loginSecret: SECRET });
    const planted = "opesvault-session=" + "a".repeat(43);
    const response = await post(
      "/api/v1/auth/signin",
      { email: "ana@example.com", loginSecret: SECRET },
      { Cookie: planted },
    );
    expect(response.status).toBe(200);
    expect(cookieOf(response)).not.toBe(planted);
    const before = await call("/api/v1/auth/session", { headers: { Cookie: planted } });
    expect(((await before.json()) as { session: unknown }).session).toBeNull();
    const second = await post("/api/v1/auth/signin", { email: "ana@example.com", loginSecret: SECRET });
    expect(cookieOf(second)).not.toBe(cookieOf(response));
  });

  it("sign-out ends the session on the server, not just in the browser", async () => {
    test = await testServer();
    const up = await post("/api/v1/auth/signup", { email: "ana@example.com", loginSecret: SECRET });
    const cookie = cookieOf(up);
    expect((await call("/api/v1/projects", { headers: { Cookie: cookie } })).status).toBe(200);
    const out = await post("/api/v1/auth/signout", {}, { Cookie: cookie });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0|Expires=/);
    // The stolen token no longer works.
    expect((await call("/api/v1/projects", { headers: { Cookie: cookie } })).status).toBe(401);
  });
});

describe("rate limits beyond sign-in", () => {
  it("limits the login-salt lookup per IP", async () => {
    test = await testServer({ sensitivePerMinute: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await post("/api/v1/auth/salt", { email: `a${i}@example.com` })).status).toBe(200);
    }
    expect((await post("/api/v1/auth/salt", { email: "z@example.com" })).status).toBe(429);
    test.advance(61_000);
    expect((await post("/api/v1/auth/salt", { email: "z@example.com" })).status).toBe(200);
  });

  it("limits every API route per IP, except health", async () => {
    test = await testServer({ requestsPerMinute: 5 });
    for (let i = 0; i < 5; i++) expect((await call("/api/v1/projects")).status).toBe(401);
    expect((await call("/api/v1/projects")).status).toBe(429);
    expect((await call("/api/v1/health")).status).toBe(200);
    test.advance(61_000);
    expect((await call("/api/v1/projects")).status).toBe(401);
  });

  it("limits member additions (an email probe) and project creations per account", async () => {
    test = await testServer({ sensitivePerMinute: 2 });
    const up = await post("/api/v1/auth/signup", { email: "ana@example.com", loginSecret: SECRET });
    const cookie = cookieOf(up);
    const envelope = {
      version: 1,
      kdf: { algorithm: "argon2id", memoryKiB: 65536, iterations: 3, parallelism: 1, salt: "c2FsdHNhbHRzYWx0c2FsdA" },
      wrappedByPassword: "AAAA",
      recoverySalt: null,
      wrappedByRecovery: null,
    };
    const create = (id: string) =>
      post("/api/v1/projects", { projectId: id, sealedName: "AAAA", envelope }, { Cookie: cookie });
    expect((await create(ID)).status).toBe(200);
    expect((await create("1".repeat(32))).status).toBe(200);
    expect((await create("2".repeat(32))).status).toBe(429);
    const add = (email: string) => post(`/api/v1/projects/${ID}/members`, { email }, { Cookie: cookie });
    expect((await add("x1@example.com")).status).toBe(404);
    expect((await add("x2@example.com")).status).toBe(404);
    expect((await add("x3@example.com")).status).toBe(429);
  });
});
