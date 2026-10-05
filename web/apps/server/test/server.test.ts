import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, loadSecret } from "../src/config.ts";
import { testServer, type TestServer } from "./helpers.ts";

let test: TestServer | null = null;
afterEach(async () => {
  await test?.dispose();
  test = null;
});

const SECRET = "A".repeat(43);
const CSRF = { "X-OpesVault": "1", "Content-Type": "application/json" };

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${test!.server.url}${path}`, init);
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return api(path, { method: "POST", headers: { ...CSRF, ...headers }, body: JSON.stringify(body) });
}

function expectSecurityHeaders(response: Response): void {
  const csp = response.headers.get("content-security-policy")!;
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("require-trusted-types-for 'script'");
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toMatch(/'unsafe-eval'/);
  expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("permissions-policy")).toContain("camera=()");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
}

describe("HTTP surface", () => {
  it("answers health with strict headers and no caching", async () => {
    test = await testServer();
    const response = await api("/api/v1/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expectSecurityHeaders(response);
    expect(response.headers.get("strict-transport-security")).toBeNull();
  });

  it("requires the CSRF header on every mutating request", async () => {
    test = await testServer();
    const without = await api("/api/v1/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ana@example.com", loginSecret: SECRET }),
    });
    expect(without.status).toBe(403);
    expect(await without.json()).toEqual({ error: "forbidden" });
    expectSecurityHeaders(without);
    const wrong = await post(
      "/api/v1/auth/signup",
      { email: "ana@example.com", loginSecret: SECRET },
      { "X-OpesVault": "0" },
    );
    expect(wrong.status).toBe(403);
    expect((await post("/api/v1/auth/signup", { email: "ana@example.com", loginSecret: SECRET })).status).toBe(200);
  });

  it("refuses malformed and oversized bodies", async () => {
    test = await testServer();
    const malformed = await api("/api/v1/auth/signin", { method: "POST", headers: CSRF, body: "{not json" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid" });
    const extra = await post("/api/v1/auth/signin", { email: "a@b.c", loginSecret: SECRET, password: "x" });
    expect(await extra.json()).toEqual({ error: "invalid" });
    const huge = await post("/api/v1/auth/signin", { email: "a@b.c", loginSecret: "A".repeat(300 * 1024) });
    expect(huge.status).toBe(413);
    expect(await huge.json()).toEqual({ error: "too_large" });
  });

  it("answers unknown API routes with a JSON 404", async () => {
    test = await testServer();
    const response = await api("/api/v1/nothing");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});

describe("sessions and cookies", () => {
  it("sets an HttpOnly, SameSite=Strict cookie, Secure with the __Host- prefix when configured", async () => {
    test = await testServer({ secureCookies: true });
    const response = await post("/api/v1/auth/signup", { email: "ana@example.com", loginSecret: SECRET });
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-opesvault-session=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(response.headers.get("content-security-policy")).toContain("upgrade-insecure-requests");
  });

  it("can drop Secure for local development over http", async () => {
    test = await testServer({ secureCookies: false });
    const response = await post("/api/v1/auth/signup", { email: "ana@example.com", loginSecret: SECRET });
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^opesvault-session=/);
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("HttpOnly");
  });

  it("stores only hashes of session tokens and login secrets", async () => {
    test = await testServer();
    const loginSecret = "SegredoDeLogin_" + "x".repeat(30);
    const response = await post("/api/v1/auth/signup", { email: "ana@example.com", loginSecret });
    const token = /opesvault-session=([^;]+)/.exec(response.headers.get("set-cookie")!)![1]!;
    await test.server.close();
    const db = readdirSync(test.dataDir)
      .filter((name) => name.startsWith("opesvault.db"))
      .map((name) => readFileSync(join(test!.dataDir, name)).toString("latin1"))
      .join("");
    expect(db).toContain("ana@example.com");
    expect(db).not.toContain(token);
    expect(db).not.toContain(loginSecret);
    await test.restart();
  });

  it("sessions expire after 30 days", async () => {
    test = await testServer();
    const client = test.client();
    await client.signUp("ana@example.com", SECRET);
    test.advance(29 * 24 * 3600 * 1000);
    expect(await client.currentSession()).not.toBeNull();
    test.advance(2 * 24 * 3600 * 1000);
    expect(await client.currentSession()).toBeNull();
  });
});

describe("rate limits", () => {
  it("limits sign-in attempts per IP", async () => {
    test = await testServer({ ipAttemptsPerMinute: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await post("/api/v1/auth/signin", { email: "x@example.com", loginSecret: SECRET })).status).toBe(401);
    }
    const blocked = await post("/api/v1/auth/signin", { email: "x@example.com", loginSecret: SECRET });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "rate_limited" });
    test.advance(61_000);
    expect((await post("/api/v1/auth/signin", { email: "x@example.com", loginSecret: SECRET })).status).toBe(401);
  });

  it("limits failed sign-ins per email, even the right secret, until the window passes", async () => {
    test = await testServer({ emailFailuresPer15Minutes: 2 });
    await post("/api/v1/auth/signup", { email: "ana@example.com", loginSecret: SECRET });
    const wrong = "B".repeat(43);
    expect((await post("/api/v1/auth/signin", { email: "ana@example.com", loginSecret: wrong })).status).toBe(401);
    expect((await post("/api/v1/auth/signin", { email: "Ana@example.com", loginSecret: wrong })).status).toBe(401);
    expect((await post("/api/v1/auth/signin", { email: "ana@example.com", loginSecret: SECRET })).status).toBe(429);
    // Another email is not affected.
    expect((await post("/api/v1/auth/signin", { email: "bia@example.com", loginSecret: SECRET })).status).toBe(401);
    test.advance(15 * 60_000 + 1000);
    expect((await post("/api/v1/auth/signin", { email: "ana@example.com", loginSecret: SECRET })).status).toBe(200);
  });

  it("behind a trusted proxy, counts by the forwarded client IP", async () => {
    test = await testServer({ ipAttemptsPerMinute: 1, trustProxy: true });
    const from = (ip: string) =>
      post(
        "/api/v1/auth/signin",
        { email: "x@example.com", loginSecret: SECRET },
        { "X-Forwarded-For": `1.1.1.1, ${ip}` },
      );
    expect((await from("10.0.0.1")).status).toBe(401);
    expect((await from("10.0.0.1")).status).toBe(429);
    expect((await from("10.0.0.2")).status).toBe(401);
  });
});

describe("logs", () => {
  it("carry only method, route template, status, duration and the opaque project id", async () => {
    test = await testServer();
    const client = test.client();
    const secret = "LoginSecretQueNaoPodeAparecer_" + "z".repeat(20);
    await client.loginSalt("segredo.email@example.com");
    await client.signUp("segredo.email@example.com", secret);
    const projectId = "0123456789abcdef0123456789abcdef";
    const sealedName = "NomeSeladoQueNaoPodeAparecer";
    await client.createProject(projectId, sealedName, {
      version: 1,
      kdf: { algorithm: "argon2id", memoryKiB: 65536, iterations: 3, parallelism: 1, salt: "c2FsdHNhbHRzYWx0c2FsdA" },
      wrappedByPassword: "EnvelopeQueNaoPodeAparecer",
      recoverySalt: null,
      wrappedByRecovery: null,
    });
    const lease = await client.acquireEditLease(projectId, "tab-1");
    await client.push(projectId, lease.leaseId, [
      { id: "f".repeat(32), baseRevision: 0, ciphertext: "CifraQueNaoPodeAparecer" },
    ]);
    await client.signIn("segredo.email@example.com", "C".repeat(43)).catch(() => undefined);
    const text = JSON.stringify(test.logs);
    for (const forbidden of [
      "segredo.email",
      "example.com",
      secret,
      sealedName,
      "EnvelopeQueNaoPodeAparecer",
      "CifraQueNaoPodeAparecer",
      lease.leaseId,
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(test.logs.map((entry) => entry.route)).toContain("/api/v1/projects/:projectId/records");
    const push = test.logs.find((entry) => entry.route === "/api/v1/projects/:projectId/records")!;
    expect(push).toMatchObject({ method: "POST", status: 200, project: projectId });
    expect(Object.keys(push).sort()).toEqual(["method", "ms", "project", "route", "status", "time"]);
    expect(test.logs.find((entry) => entry.route === "/api/v1/auth/signin")?.status).toBe(401);
    expect(test.logs.find((entry) => entry.route === "/api/v1/auth/salt")?.method).toBe("POST");
  });
});

describe("static app", () => {
  function site(): string {
    const dir = mkdtempSync(join(tmpdir(), "opesvault-site-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>OpesVault</title>");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "app-1234.js"), "console.log(1)");
    writeFileSync(join(dir, "manifest.webmanifest"), "{}");
    return dir;
  }

  it("serves files, falls back to index.html for app routes and never leaves the folder", async () => {
    const dir = site();
    test = await testServer({ staticDir: dir });
    const index = await api("/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expectSecurityHeaders(index);
    expect(await (await api("/livro/2026-10")).text()).toContain("OpesVault");
    const asset = await api("/assets/app-1234.js");
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await api("/manifest.webmanifest")).headers.get("content-type")).toBe("application/manifest+json");
    expect((await api("/assets/missing.js")).status).toBe(404);
    for (const attack of ["/..%2f..%2f..%2fetc%2fpasswd", "/%2e%2e/%2e%2e/etc/passwd", "/assets/..%2f..%2fsecret"]) {
      const response = await api(attack);
      expect(await response.text()).not.toContain("root:");
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("without an app, only the API answers", async () => {
    test = await testServer();
    expect((await api("/")).status).toBe(404);
    expect((await api("/api/v1/health")).status).toBe(200);
  });
});

describe("configuration", () => {
  it("generates a secret once in the data dir, readable only by the owner", () => {
    const dir = mkdtempSync(join(tmpdir(), "opesvault-config-"));
    const first = loadSecret({}, dir);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(statSync(join(dir, "secret")).mode & 0o777).toBe(0o600);
    expect(loadSecret({}, dir).equals(first)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("takes the secret as a value or a file, and refuses a short one", () => {
    const dir = mkdtempSync(join(tmpdir(), "opesvault-config-"));
    const value = "v".repeat(40);
    expect(loadSecret({ OPESVAULT_SECRET: value }, dir).toString()).toBe(value);
    const file = join(dir, "from-file");
    writeFileSync(file, `${"f".repeat(40)}\n`);
    expect(loadSecret({ OPESVAULT_SECRET: file }, dir).toString()).toBe("f".repeat(40));
    expect(loadSecret({ OPESVAULT_SECRET_FILE: file }, dir).toString()).toBe("f".repeat(40));
    expect(() => loadSecret({ OPESVAULT_SECRET: "curto" }, dir)).toThrow(/at least/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads flags from the environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "opesvault-config-"));
    const config = loadConfig({
      OPESVAULT_DATA_DIR: dir,
      PORT: "9999",
      OPESVAULT_SECURE_COOKIES: "false",
      OPESVAULT_TRUST_PROXY: "1",
    });
    expect(config).toMatchObject({ port: 9999, secureCookies: false, trustProxy: true, staticDir: null });
    expect(loadConfig({ OPESVAULT_DATA_DIR: dir }).secureCookies).toBe(true);
    expect(() => loadConfig({ OPESVAULT_DATA_DIR: dir, PORT: "x" })).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});
