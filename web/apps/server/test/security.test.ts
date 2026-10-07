/** Server security review (docs/19 §12, §14): CSRF on every mutating route, rate limits, sessions, one CSP. */
import { cspHeader } from "@opesvault/vault";
import { describe, expect, it } from "vitest";
import { useTestServer } from "./helpers.ts";

const fixture = useTestServer();

const SECRET = "A".repeat(43);
const ID = "0123456789abcdef0123456789abcdef";

const cookieOf = (response: Response): string => /^[^=]+=[^;]+/.exec(response.headers.get("set-cookie") ?? "")![0];

describe("one policy", () => {
  it("the server header is the shared policy, with HTTPS upgrade only when secure", async () => {
    const test = await fixture.start();
    expect((await fixture.call("/api/v1/health")).headers.get("content-security-policy")).toBe(cspHeader(false));
    await test.dispose();
    await fixture.start({ secureCookies: true });
    expect((await fixture.call("/api/v1/health")).headers.get("content-security-policy")).toBe(cspHeader(true));
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
    await fixture.start();
    for (const headers of [{}, { "X-OpesVault": "0" }, { "X-OpesVault": "true" }]) {
      const response = await fixture.call(path, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: "{}",
      });
      expect(response.status, JSON.stringify(headers)).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
  });

  it("reads need no header but never reveal anything without a session", async () => {
    await fixture.start();
    for (const path of [
      "/api/v1/projects",
      `/api/v1/projects/${ID}/envelope`,
      `/api/v1/projects/${ID}/records?since=0`,
    ]) {
      expect((await fixture.call(path)).status).toBe(401);
    }
  });

  it("has no CORS: a cross-origin page cannot even preflight", async () => {
    await fixture.start();
    const response = await fixture.call("/api/v1/auth/signin", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("sessions", () => {
  it("never adopts a token the client chose (no fixation), and a new sign-in gets a new token", async () => {
    await fixture.start();
    await fixture.post("/api/v1/auth/signup", { email: "ana@example.com", loginSecret: SECRET });
    const planted = "opesvault-session=" + "a".repeat(43);
    const response = await fixture.post(
      "/api/v1/auth/signin",
      { email: "ana@example.com", loginSecret: SECRET },
      { Cookie: planted },
    );
    expect(response.status).toBe(200);
    expect(cookieOf(response)).not.toBe(planted);
    const before = await fixture.call("/api/v1/auth/session", { headers: { Cookie: planted } });
    expect(((await before.json()) as { session: unknown }).session).toBeNull();
    const second = await fixture.post("/api/v1/auth/signin", { email: "ana@example.com", loginSecret: SECRET });
    expect(cookieOf(second)).not.toBe(cookieOf(response));
  });

  it("sign-out ends the session on the server, not just in the browser", async () => {
    await fixture.start();
    const up = await fixture.post("/api/v1/auth/signup", { email: "ana@example.com", loginSecret: SECRET });
    const cookie = cookieOf(up);
    expect((await fixture.call("/api/v1/projects", { headers: { Cookie: cookie } })).status).toBe(200);
    const out = await fixture.post("/api/v1/auth/signout", {}, { Cookie: cookie });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0|Expires=/);
    // The stolen token no longer works.
    expect((await fixture.call("/api/v1/projects", { headers: { Cookie: cookie } })).status).toBe(401);
  });
});

describe("rate limits beyond sign-in", () => {
  it("limits the login-salt lookup per IP", async () => {
    const test = await fixture.start({ sensitivePerMinute: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await fixture.post("/api/v1/auth/salt", { email: `a${i}@example.com` })).status).toBe(200);
    }
    expect((await fixture.post("/api/v1/auth/salt", { email: "z@example.com" })).status).toBe(429);
    test.advance(61_000);
    expect((await fixture.post("/api/v1/auth/salt", { email: "z@example.com" })).status).toBe(200);
  });

  it("limits every API route per IP, except health", async () => {
    const test = await fixture.start({ requestsPerMinute: 5 });
    for (let i = 0; i < 5; i++) expect((await fixture.call("/api/v1/projects")).status).toBe(401);
    expect((await fixture.call("/api/v1/projects")).status).toBe(429);
    expect((await fixture.call("/api/v1/health")).status).toBe(200);
    test.advance(61_000);
    expect((await fixture.call("/api/v1/projects")).status).toBe(401);
  });

  it("limits member additions (an email probe) and project creations per account", async () => {
    await fixture.start({ sensitivePerMinute: 2 });
    const up = await fixture.post("/api/v1/auth/signup", { email: "ana@example.com", loginSecret: SECRET });
    const cookie = cookieOf(up);
    const envelope = {
      version: 1,
      kdf: { algorithm: "argon2id", memoryKiB: 65536, iterations: 3, parallelism: 1, salt: "c2FsdHNhbHRzYWx0c2FsdA" },
      wrappedByPassword: "AAAA",
      recoverySalt: null,
      wrappedByRecovery: null,
    };
    const create = (id: string) =>
      fixture.post("/api/v1/projects", { projectId: id, sealedName: "AAAA", envelope }, { Cookie: cookie });
    expect((await create(ID)).status).toBe(200);
    expect((await create("1".repeat(32))).status).toBe(200);
    expect((await create("2".repeat(32))).status).toBe(429);
    const add = (email: string) => fixture.post(`/api/v1/projects/${ID}/members`, { email }, { Cookie: cookie });
    expect((await add("x1@example.com")).status).toBe(404);
    expect((await add("x2@example.com")).status).toBe(404);
    expect((await add("x3@example.com")).status).toBe(429);
  });
});
