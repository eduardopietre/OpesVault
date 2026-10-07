/**
 * docs/18 W2 exit criteria, end to end through HTTP and SQLite:
 * two browsers (one edits, the other reads and takes over), a network drop in the middle of a push
 * that neither loses nor duplicates, and a restarted server that keeps everything.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cookieJarFetch, HttpBackend } from "@opesvault/backend-http";
import {
  BackendError,
  ProjectVault,
  signIn,
  signUp,
  VaultCache,
  type PlainRecord,
  type SyncBackend,
} from "@opesvault/vault";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { useTestServer } from "./helpers.ts";
import { TEST_KDF } from "@opesvault/vault/testing";

const op = (id: string, description: string): PlainRecord => ({ kind: "operation", id, payload: { description } });

const fixture = useTestServer();

async function browser(backend: SyncBackend = fixture.current.client()) {
  const cache = await VaultCache.open({ factory: new IDBFactory(), keyRange: IDBKeyRange });
  return {
    backend,
    cache,
    vault: (projectId: string) =>
      new ProjectVault({ backend, cache, projectId, kdf: TEST_KDF, pushDelayMs: 10, pollMs: 50, retryMs: 50 }),
  };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("two browsers through the server", () => {
  it("one edits, the other reads, takes over and edits; the first turns read-only", async () => {
    await fixture.start();
    const ana = await browser();
    await signUp(ana.backend, "ana@example.com", "conta da ana", TEST_KDF);
    const { vault: editor } = await ProjectVault.create({
      backend: ana.backend,
      cache: ana.cache,
      kdf: TEST_KDF,
      name: "Casa",
      password: "senha do projeto",
      pushDelayMs: 10,
      pollMs: 50,
    });
    const bia = await browser();
    await signUp(bia.backend, "bia@example.com", "conta da bia", TEST_KDF);
    await ana.backend.addMember(editor.projectId, "bia@example.com");

    const reader = bia.vault(editor.projectId);
    await reader.unlock("senha do projeto");
    expect(reader.getSnapshot()).toMatchObject({ status: "readOnly", name: "Casa" });
    expect(reader.getSnapshot().heldBy?.email).toBe("ana@example.com");

    await editor.stage([op("1", "Mercado")]);
    await editor.syncNow();
    await reader.syncNow();
    expect(reader.get("operation", "1")).toEqual(op("1", "Mercado"));

    await reader.takeOver();
    expect(reader.getSnapshot().status).toBe("synced");
    await reader.stage([op("2", "Padaria")]);
    await reader.syncNow();

    await editor.stage([op("3", "depois de perder")]);
    await editor.syncNow();
    expect(editor.getSnapshot().status).toBe("readOnly");
    expect(editor.getSnapshot().pending).toBe(1);
    expect(editor.get("operation", "2")).toEqual(op("2", "Padaria"));

    await reader.lock();
    await editor.lock();
    await editor.unlock("senha do projeto");
    await editor.syncNow();
    expect(editor.getSnapshot()).toMatchObject({ status: "synced", pending: 0 });
    expect(editor.get("operation", "3")).toEqual(op("3", "depois de perder"));
    await editor.lock();
  });
});

describe("network failures", () => {
  it("a dropped response in the middle of a push neither loses nor duplicates", async () => {
    const test = await fixture.start();
    let drop = false;
    const jar = cookieJarFetch();
    const flaky: typeof fetch = async (input, init) => {
      const response = await jar(input, init);
      if (drop && init?.method === "POST" && String(input).endsWith("/records")) {
        drop = false;
        throw new TypeError("network connection lost");
      }
      return response;
    };
    const ana = await browser(new HttpBackend({ baseUrl: test.server.url, fetch: flaky }));
    await signUp(ana.backend, "ana@example.com", "conta da ana", TEST_KDF);
    const { vault } = await ProjectVault.create({
      backend: ana.backend,
      cache: ana.cache,
      kdf: TEST_KDF,
      name: "Casa",
      password: "senha",
    });
    drop = true;
    await vault.stage([op("1", "uma vez"), op("2", "também uma vez")]);
    await vault.syncNow();
    expect(vault.getSnapshot()).toMatchObject({ status: "offline", pending: 2 });
    await vault.syncNow();
    expect(vault.getSnapshot()).toMatchObject({ status: "synced", pending: 0, conflicts: [] });
    const pulled = await ana.backend.pull(vault.projectId, 0);
    expect(pulled.revision).toBe(1);
    expect(pulled.records).toHaveLength(2);
    await vault.lock();
  });

  it("an unreachable server is offline, and changes wait", async () => {
    const test = await fixture.start();
    const ana = await browser();
    await signUp(ana.backend, "ana@example.com", "conta da ana", TEST_KDF);
    const { vault } = await ProjectVault.create({
      backend: ana.backend,
      cache: ana.cache,
      kdf: TEST_KDF,
      name: "Casa",
      password: "senha",
      retryMs: 60_000,
    });
    const port = test.server.port;
    await test.server.close();
    await vault.stage([op("1", "sem servidor")]);
    await vault.syncNow();
    expect(vault.getSnapshot()).toMatchObject({ status: "offline", pending: 1 });
    await test.restart();
    expect(test.server.port).toBe(port);
    await vault.syncNow();
    expect(vault.getSnapshot()).toMatchObject({ status: "synced", pending: 0 });
    await vault.lock();
  });
});

describe("restart", () => {
  it("a restarted server keeps accounts, sessions, projects, records, blobs and the lease", async () => {
    const test = await fixture.start();
    const ana = await browser();
    await signUp(ana.backend, "ana@example.com", "conta da ana", TEST_KDF);
    const { vault } = await ProjectVault.create({
      backend: ana.backend,
      cache: ana.cache,
      kdf: TEST_KDF,
      name: "Casa",
      password: "senha",
    });
    await vault.stage([op("1", "persistente")]);
    await vault.syncNow();
    const blobId = await vault.putBlob(new TextEncoder().encode("comprovante"));
    await test.restart();
    // The same browser keeps its session cookie across the restart.
    expect((await ana.backend.currentSession())?.email).toBe("ana@example.com");
    await vault.stage([op("2", "depois do reinício")]);
    await vault.syncNow();
    expect(vault.getSnapshot()).toMatchObject({ status: "synced", pending: 0 });
    await vault.lock();

    const other = await browser();
    await signIn(other.backend, "ana@example.com", "conta da ana", TEST_KDF);
    const fresh = other.vault(vault.projectId);
    await fresh.unlock("senha");
    expect(fresh.get("operation", "1")).toEqual(op("1", "persistente"));
    expect(fresh.get("operation", "2")).toEqual(op("2", "depois do reinício"));
    expect(new TextDecoder().decode(await fresh.getBlob(blobId))).toBe("comprovante");
    expect(fresh.getSnapshot().name).toBe("Casa");
    await fresh.lock();
  });

  it("nothing on the server's disk is plaintext", async () => {
    const test = await fixture.start();
    const ana = await browser();
    await signUp(ana.backend, "ana@example.com", "senha-da-conta-secreta", TEST_KDF);
    const { vault, recoveryKey } = await ProjectVault.create({
      backend: ana.backend,
      cache: ana.cache,
      kdf: TEST_KDF,
      name: "Família Secreta",
      password: "senha-do-projeto-secreta",
    });
    await vault.stage([{ kind: "operation_secret", id: "x", payload: { description: "Supermercado Secreto" } }]);
    await vault.syncNow();
    await vault.putBlob(new TextEncoder().encode("EXTRATO SECRETO"));
    await vault.lock();
    await test.server.close();
    const disk = filesUnder(test.dataDir)
      .map((path) => readFileSync(path).toString("latin1"))
      .join("\n");
    for (const secret of [
      "Família",
      "Secreta",
      "senha-da-conta-secreta",
      "senha-do-projeto-secreta",
      "Supermercado",
      "operation_secret",
      "EXTRATO",
      recoveryKey,
    ]) {
      expect(disk, secret).not.toContain(secret);
    }
    await test.restart();
  });
});

describe("errors map to codes", () => {
  it("unauthorized without a session; offline for a server that is gone", async () => {
    const test = await fixture.start();
    const client = test.client();
    await expect(client.listProjects()).rejects.toEqual(new BackendError("unauthorized"));
    const nowhere = new HttpBackend({ baseUrl: "http://127.0.0.1:9", fetch: cookieJarFetch() });
    await expect(nowhere.listProjects()).rejects.toEqual(new BackendError("offline"));
  });
});
