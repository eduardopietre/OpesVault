import { describe, expect, it } from "vitest";
import {
  BackendError,
  MemoryServer,
  recordKey,
  VaultError,
  type PlainRecord,
  type RemoteChange,
  type SyncBackend,
  type VaultSnapshot,
} from "../src/index.ts";
import { account, createProject, device, intercept, login, settle, until } from "./helpers.ts";

const op = (id: string, description: string): PlainRecord => ({
  kind: "operation",
  id,
  payload: { description, amount: "10.00" },
});

async function owner() {
  const server = new MemoryServer();
  const dev = await device(server);
  await account(dev.backend, "ana@example.com");
  const { vault, recoveryKey } = await createProject(dev);
  return { server, dev, vault, recoveryKey };
}

async function member(server: MemoryServer, projectId: string, ownerBackend: SyncBackend) {
  const dev = await device(server);
  await account(dev.backend, "bia@example.com");
  await ownerBackend.addMember(projectId, "bia@example.com");
  return dev;
}

async function expectVaultError(promise: Promise<unknown>, code: VaultError["code"]): Promise<void> {
  await expect(promise).rejects.toEqual(new VaultError(code));
}

describe("creating and opening a project", () => {
  it("creates a project unlocked, as the editor, with a recovery key shown once", async () => {
    const { vault, recoveryKey } = await owner();
    expect(recoveryKey).toMatch(/^([0-9A-Z]{4}-){8}[0-9A-Z]{4}$/);
    const snapshot = vault.getSnapshot();
    expect(snapshot).toMatchObject({ status: "synced", unlocked: true, name: "Família Teste", pending: 0 });
    expect(snapshot.lease?.holder).toBe(vault.holder);
  });

  it("stages changes, shows them at once and syncs them", async () => {
    const { vault } = await owner();
    const staged = vault.stage([op("1", "Mercado"), op("2", "Farmácia")]);
    expect(vault.get("operation", "1")?.payload).toEqual({ description: "Mercado", amount: "10.00" });
    await staged;
    expect(vault.getSnapshot()).toMatchObject({ status: "pending", pending: 2 });
    await vault.syncNow();
    expect(vault.getSnapshot()).toMatchObject({ status: "synced", pending: 0, revision: 1 });
  });

  it("pushes after the delay, batching a burst of edits into one revision", async () => {
    const { vault, dev } = await owner();
    await vault.stage([op("1", "a")]);
    await vault.stage([op("2", "b")]);
    await vault.stage([op("1", "c")]);
    await dev.timers.advance(100);
    await until(() => vault.getSnapshot().status === "synced");
    expect(vault.getSnapshot()).toMatchObject({ status: "synced", revision: 1 });
  });

  it("locks: keys, records and timers are gone; a wrong password never opens or creates anything", async () => {
    const { vault, dev } = await owner();
    await vault.stage([op("1", "Mercado")]);
    await vault.syncNow();
    await vault.lock();
    expect(vault.getSnapshot()).toMatchObject({ status: "locked", unlocked: false, name: null });
    expect(vault.records.size).toBe(0);
    expect(dev.timers.scheduled).toBe(0);
    expect(() => vault.stage([op("2", "x")])).toThrow(new VaultError("locked"));
    await expectVaultError(vault.unlock("senha errada"), "wrong_password");
    await expectVaultError(vault.unlock(""), "wrong_password");
    expect(vault.getSnapshot().status).toBe("locked");
    await vault.unlock("senha do projeto");
    expect(vault.get("operation", "1")).toEqual(op("1", "Mercado"));
    expect(vault.getSnapshot().status).toBe("synced");
  });

  it("keeps the snapshot identity while nothing changes (useSyncExternalStore)", async () => {
    const { vault } = await owner();
    await vault.syncNow();
    const first = vault.getSnapshot();
    expect(vault.getSnapshot()).toBe(first);
    let calls = 0;
    const unsubscribe = vault.subscribe(() => (calls += 1));
    await vault.syncNow();
    const after: VaultSnapshot = vault.getSnapshot();
    expect(after).toEqual(first);
    await vault.stage([op("1", "x")]);
    expect(calls).toBeGreaterThan(0);
    expect(vault.getSnapshot()).not.toBe(first);
    unsubscribe();
  });

  it("idle lock: no activity for the configured time locks the project", async () => {
    const { dev, vault } = await owner();
    const idle = dev.vault(vault.projectId, { idleLockMs: 60_000 });
    await vault.lock();
    await idle.unlock("senha do projeto");
    await dev.timers.advance(30_000);
    idle.touch();
    await dev.timers.advance(45_000);
    expect(idle.unlocked).toBe(true);
    await dev.timers.advance(20_000);
    await until(() => idle.getSnapshot().status === "locked");
    expect(idle.getSnapshot().status).toBe("locked");
  });

  it("renames with a sealed name", async () => {
    const { vault, dev } = await owner();
    await vault.rename("Casa nova");
    expect(vault.getSnapshot().name).toBe("Casa nova");
    const [summary] = await dev.backend.listProjects();
    expect(summary!.sealedName).not.toContain("Casa");
  });
});

describe("password and recovery key", () => {
  it("changing the password: the old one stops working everywhere", async () => {
    const { vault, dev } = await owner();
    await expectVaultError(vault.changePassword("errada", "nova senha"), "wrong_password");
    await expectVaultError(vault.changePassword("senha do projeto", ""), "empty_password");
    await vault.changePassword("senha do projeto", "nova senha");
    await vault.lock();
    await expectVaultError(vault.unlock("senha do projeto"), "wrong_password");
    const other = await dev.reload();
    const again = other.vault(vault.projectId);
    await again.unlock("nova senha");
    expect(again.unlocked).toBe(true);
  });

  it("the recovery key opens the project with a new password; regenerating invalidates it", async () => {
    const { vault, recoveryKey } = await owner();
    await vault.stage([op("1", "Mercado")]);
    await vault.syncNow();
    await vault.lock();
    await expectVaultError(vault.unlockWithRecovery("AAAA-BBBB", "nova"), "invalid_recovery_key");
    await vault.unlockWithRecovery(recoveryKey.toLowerCase(), "nova");
    expect(vault.get("operation", "1")).toBeDefined();
    const fresh = await vault.regenerateRecoveryKey("nova");
    expect(fresh).not.toBe(recoveryKey);
    await vault.lock();
    await expectVaultError(vault.unlockWithRecovery(recoveryKey, "outra"), "wrong_recovery_key");
    await vault.unlockWithRecovery(fresh, "outra");
    await vault.lock();
    await vault.unlock("outra");
  });

  it("a concurrent envelope change is a conflict, not an overwrite", async () => {
    const { vault, dev } = await owner();
    const second = dev.vault(vault.projectId);
    await vault.changePassword("senha do projeto", "primeira");
    await expectVaultError(second.changePassword("senha do projeto", "segunda"), "wrong_password");
    await second.changePassword("primeira", "segunda");
    await vault.lock();
    await vault.unlock("segunda");
  });
});

describe("two people, one editor", () => {
  it("the second opens read-only, sees changes and can take over; the first becomes read-only", async () => {
    const { server, vault, dev } = await owner();
    const bia = await member(server, vault.projectId, dev.backend);
    const reader = bia.vault(vault.projectId, { pollMs: 1000 });
    await reader.unlock("senha do projeto");
    expect(reader.getSnapshot()).toMatchObject({ status: "readOnly" });
    expect(reader.getSnapshot().heldBy?.email).toBe("ana@example.com");
    expect(() => reader.stage([op("x", "não")])).toThrow(new VaultError("read_only"));

    const changes: RemoteChange[] = [];
    reader.onRemoteChange((change) => changes.push(change));
    await vault.stage([op("1", "Mercado")]);
    await vault.syncNow();
    await bia.timers.advance(1000);
    await until(() => reader.get("operation", "1") !== undefined);
    expect(reader.get("operation", "1")).toEqual(op("1", "Mercado"));
    expect(changes.flatMap((change) => change.upserts.map((r) => r.id))).toEqual(["1"]);

    await reader.takeOver();
    expect(reader.getSnapshot().status).toBe("synced");
    await reader.stage([op("2", "Padaria")]);
    await reader.syncNow();

    await vault.stage([op("3", "perdida?")]);
    await vault.syncNow();
    await settle();
    expect(vault.getSnapshot().status).toBe("readOnly");
    expect(vault.getSnapshot().heldBy?.email).toBe("bia@example.com");
    // The change made just before losing the lease is kept, not dropped.
    expect(vault.getSnapshot().pending).toBe(1);
    expect(vault.get("operation", "2")).toEqual(op("2", "Padaria"));
  });

  it("a read-only tab becomes the editor when the lease is released", async () => {
    const { server, vault, dev } = await owner();
    const bia = await member(server, vault.projectId, dev.backend);
    const reader = bia.vault(vault.projectId, { pollMs: 1000 });
    await reader.unlock("senha do projeto");
    expect(reader.getSnapshot().status).toBe("readOnly");
    await vault.lock();
    await bia.timers.advance(1000);
    await until(() => reader.getSnapshot().status === "synced");
    expect(reader.getSnapshot().status).toBe("synced");
    expect(reader.getSnapshot().lease?.email).toBe("bia@example.com");
  });

  it("deletes travel as tombstones", async () => {
    const { server, vault, dev } = await owner();
    await vault.stage([op("1", "a"), op("2", "b")]);
    await vault.syncNow();
    const bia = await member(server, vault.projectId, dev.backend);
    const reader = bia.vault(vault.projectId);
    await reader.unlock("senha do projeto");
    const changes: RemoteChange[] = [];
    reader.onRemoteChange((change) => changes.push(change));
    await vault.stage([], [{ kind: "operation", id: "1" }]);
    await vault.syncNow();
    await reader.syncNow();
    expect(reader.get("operation", "1")).toBeUndefined();
    expect(reader.get("operation", "2")).toBeDefined();
    expect(changes.flatMap((change) => change.deletes)).toEqual([{ kind: "operation", id: "1" }]);
    // Re-creating a deleted record is based on its tombstone.
    await vault.stage([op("1", "de volta")]);
    await vault.syncNow();
    expect(vault.getSnapshot()).toMatchObject({ status: "synced", conflicts: [] });
  });

  it("deleting a record that never reached the server just forgets it", async () => {
    const { vault } = await owner();
    await vault.stage([op("1", "a")]);
    await vault.stage([], [{ kind: "operation", id: "1" }]);
    expect(vault.getSnapshot().pending).toBe(0);
    expect(vault.get("operation", "1")).toBeUndefined();
  });
});

describe("offline, reloads and network failures", () => {
  it("works offline and sends the changes when the network comes back", async () => {
    const { server, vault } = await owner();
    server.offline = true;
    await vault.stage([op("1", "offline")]);
    await vault.syncNow();
    expect(vault.getSnapshot()).toMatchObject({ status: "offline", pending: 1, online: false });
    server.offline = false;
    await vault.syncNow();
    expect(vault.getSnapshot()).toMatchObject({ status: "synced", pending: 0, online: true });
  });

  it("retries by itself after a failure", async () => {
    const { server, vault, dev } = await owner();
    server.offline = true;
    await vault.stage([op("1", "offline")]);
    await dev.timers.advance(100);
    await until(() => vault.getSnapshot().status === "offline");
    expect(vault.getSnapshot().status).toBe("offline");
    server.offline = false;
    await dev.timers.advance(5000);
    await until(() => vault.getSnapshot().status === "synced");
    expect(vault.getSnapshot()).toMatchObject({ status: "synced", pending: 0 });
  });

  it("pending changes survive a reload while locked, and the project opens offline", async () => {
    const { server, vault, dev } = await owner();
    await vault.stage([op("1", "enviado")]);
    await vault.syncNow();
    server.offline = true;
    await vault.stage([op("2", "pendente")]);
    await vault.lock();
    const reloaded = await dev.reload();
    // The same tab after a reload: same holder label, so its lease comes back at once.
    const again = reloaded.vault(vault.projectId, { holder: vault.holder });
    await again.unlock("senha do projeto");
    expect(again.get("operation", "1")).toEqual(op("1", "enviado"));
    expect(again.get("operation", "2")).toEqual(op("2", "pendente"));
    expect(again.getSnapshot()).toMatchObject({ status: "offline", pending: 1, name: "Família Teste" });
    server.offline = false;
    await again.syncNow();
    expect(again.getSnapshot()).toMatchObject({ status: "synced", pending: 0 });
    const third = (await dev.reload()).vault(vault.projectId, { holder: vault.holder });
    await again.lock();
    await third.unlock("senha do projeto");
    expect(third.get("operation", "2")).toEqual(op("2", "pendente"));
  });

  it("locking sends what is already sealed and releases the lease", async () => {
    const { vault, dev } = await owner();
    await vault.stage([op("1", "último")]);
    await vault.lock();
    expect(await dev.backend.currentLease(vault.projectId)).toBeNull();
    const pulled = await dev.backend.pull(vault.projectId, 0);
    expect(pulled.records).toHaveLength(1);
    expect(await dev.cache.listPending(vault.projectId)).toEqual([]);
  });

  it("a push whose answer is lost is neither lost nor duplicated", async () => {
    const server = new MemoryServer();
    const real = server.client();
    let drop = true;
    const flaky = intercept(real, {
      push: async (projectId, leaseId, records) => {
        const result = await real.push(projectId, leaseId, records);
        if (drop) {
          drop = false;
          throw new BackendError("offline");
        }
        return result;
      },
    });
    const dev = await device(server, flaky);
    await account(flaky, "ana@example.com");
    const { vault } = await createProject(dev);
    await vault.stage([op("1", "uma vez"), op("2", "também")]);
    await vault.syncNow();
    expect(vault.getSnapshot()).toMatchObject({ status: "offline", pending: 2 });
    await vault.syncNow();
    expect(vault.getSnapshot()).toMatchObject({ status: "synced", pending: 0, conflicts: [] });
    const pulled = await real.pull(vault.projectId, 0);
    expect(pulled.revision).toBe(1);
    expect(pulled.records).toHaveLength(2);
  });

  it("an edit made while a push is in flight stays pending", async () => {
    const server = new MemoryServer();
    const real = server.client();
    let release: () => void = () => undefined;
    let hold = false;
    const slow = intercept(real, {
      push: async (projectId, leaseId, records) => {
        if (hold) await new Promise<void>((resolve) => (release = resolve));
        return real.push(projectId, leaseId, records);
      },
    });
    const dev = await device(server, slow);
    await account(slow, "ana@example.com");
    const { vault } = await createProject(dev);
    await vault.stage([op("1", "primeira")]);
    hold = true;
    const sync = vault.syncNow();
    await settle();
    await vault.stage([op("1", "segunda")]);
    hold = false;
    release();
    await sync;
    await vault.syncNow();
    expect(vault.getSnapshot()).toMatchObject({ status: "synced", pending: 0, revision: 2 });
    const reader = (await dev.reload()).vault(vault.projectId);
    await vault.lock();
    await reader.unlock("senha do projeto");
    expect(reader.get("operation", "1")).toEqual(op("1", "segunda"));
  });
});

describe("deleting while the record is being pushed", () => {
  it("a deletion staged while the creating push is in flight still reaches the server", async () => {
    const server = new MemoryServer();
    const real = server.client();
    let release: () => void = () => undefined;
    let hold = false;
    const slow = intercept(real, {
      push: async (projectId, leaseId, records) => {
        if (hold) await new Promise<void>((resolve) => (release = resolve));
        return real.push(projectId, leaseId, records);
      },
    });
    const dev = await device(server, slow);
    await account(slow, "ana@example.com");
    const { vault } = await createProject(dev);
    await vault.stage([op("1", "engano")]);
    hold = true;
    const sync = vault.syncNow();
    await settle();
    // Undone while its push is on the way: the server will have it, so the deletion must follow.
    await vault.stage([], [{ kind: "operation", id: "1" }]);
    hold = false;
    release();
    await sync;
    await vault.syncNow();
    expect(vault.getSnapshot()).toMatchObject({ status: "synced", pending: 0, conflicts: [] });
    const reader = (await dev.reload()).vault(vault.projectId);
    await vault.lock();
    await reader.unlock("senha do projeto");
    expect(reader.get("operation", "1")).toBeUndefined();
  });
});

describe("conflicts are never resolved silently", () => {
  async function conflictScenario() {
    const { server, vault, dev } = await owner();
    await vault.stage([op("1", "original")]);
    await vault.syncNow();
    const bia = await member(server, vault.projectId, dev.backend);
    const other = bia.vault(vault.projectId);
    await other.unlock("senha do projeto");
    // Ana edits offline; Bia takes over and edits the same record.
    server.offline = true;
    await vault.stage([op("1", "da Ana")]);
    await vault.syncNow();
    server.offline = false;
    await other.takeOver();
    await other.stage([op("1", "da Bia")]);
    await other.syncNow();
    await other.lock();
    // Ana comes back.
    await vault.syncNow();
    return { vault, other };
  }

  it("lists the conflict with both versions and keeps the local change pending", async () => {
    const { vault } = await conflictScenario();
    const snapshot = vault.getSnapshot();
    expect(snapshot.status).toBe("conflict");
    expect(snapshot.conflicts).toHaveLength(1);
    const [conflict] = snapshot.conflicts;
    expect(conflict).toMatchObject({ kind: "operation", id: "1", key: recordKey("operation", "1") });
    expect(conflict!.local).toEqual(op("1", "da Ana"));
    expect(conflict!.remote).toEqual(op("1", "da Bia"));
    expect(snapshot.pending).toBe(1);
    expect(vault.get("operation", "1")).toEqual(op("1", "da Ana"));
  });

  it("keepLocal overwrites the server's version", async () => {
    const { vault, other } = await conflictScenario();
    await vault.resolveConflict(recordKey("operation", "1"), "keepLocal");
    await vault.syncNow();
    expect(vault.getSnapshot()).toMatchObject({ status: "synced", conflicts: [], pending: 0 });
    await vault.lock();
    await other.unlock("senha do projeto");
    expect(other.get("operation", "1")).toEqual(op("1", "da Ana"));
  });

  it("keepRemote takes the server's version", async () => {
    const { vault } = await conflictScenario();
    const changes: RemoteChange[] = [];
    vault.onRemoteChange((change) => changes.push(change));
    await vault.resolveConflict(recordKey("operation", "1"), "keepRemote");
    expect(vault.getSnapshot()).toMatchObject({ status: "synced", conflicts: [], pending: 0 });
    expect(vault.get("operation", "1")).toEqual(op("1", "da Bia"));
    expect(changes).toEqual([{ upserts: [op("1", "da Bia")], deletes: [] }]);
  });
});

describe("integrity", () => {
  it("a record altered on the server is reported as damaged, never applied", async () => {
    const server = new MemoryServer();
    const real = server.client();
    let tamper = false;
    const evil = intercept(real, {
      pull: async (projectId, since, limit) => {
        const result = await real.pull(projectId, since, limit);
        if (!tamper) return result;
        return {
          ...result,
          records: result.records.map((record) => ({
            ...record,
            ciphertext: record.ciphertext === null ? null : `${record.ciphertext.slice(0, -4)}AAAA`,
          })),
        };
      },
    });
    const dev = await device(server, evil);
    await account(evil, "ana@example.com");
    const { vault } = await createProject(dev);
    await vault.stage([op("1", "certo")]);
    await vault.syncNow();
    await vault.lock();
    await dev.cache.forgetProject(vault.projectId);
    tamper = true;
    await vault.unlock("senha do projeto");
    expect(vault.get("operation", "1")).toBeUndefined();
    expect(vault.getSnapshot().damaged).toHaveLength(1);
  });

  it("a server that goes back in time is reported, and the local copy is kept", async () => {
    const server = new MemoryServer();
    const real = server.client();
    let rollback = false;
    const evil = intercept(real, {
      pull: async (projectId, since, limit) =>
        rollback ? { revision: 0, records: [], more: false } : real.pull(projectId, since, limit),
    });
    const dev = await device(server, evil);
    await account(evil, "ana@example.com");
    const { vault } = await createProject(dev);
    await vault.stage([op("1", "a")]);
    await vault.syncNow();
    rollback = true;
    await vault.syncNow();
    expect(vault.getSnapshot()).toMatchObject({ lastError: "server_behind", revision: 1 });
    expect(vault.get("operation", "1")).toBeDefined();
  });

  it("a removed member is told, and keeps nothing new", async () => {
    const { server, vault, dev } = await owner();
    const bia = await member(server, vault.projectId, dev.backend);
    const other = bia.vault(vault.projectId);
    await other.unlock("senha do projeto");
    const biaSession = await bia.backend.currentSession();
    await dev.backend.removeMember(vault.projectId, biaSession!.accountId);
    await other.syncNow();
    expect(other.getSnapshot().lastError).toBe("forbidden");
  });
});

describe("attachments", () => {
  it("puts and gets encrypted blobs, cached in memory only while unlocked", async () => {
    const { vault, dev } = await owner();
    const pdf = new TextEncoder().encode("%PDF-1.7 extrato da conta 12345");
    const blobId = await vault.putBlob(pdf);
    const stored = await dev.backend.getBlob(vault.projectId, blobId);
    expect(Buffer.from(stored).toString("latin1")).not.toContain("extrato");
    expect(new TextDecoder().decode(await vault.getBlob(blobId))).toContain("extrato");
    expect(vault.blobCacheBytes).toBe(pdf.length);
    await vault.lock();
    expect(vault.blobCacheBytes).toBe(0);
    await expectVaultError(vault.getBlob(blobId), "locked");
    await vault.unlock("senha do projeto");
    expect(new TextDecoder().decode(await vault.getBlob(blobId))).toContain("extrato");
    await vault.deleteBlob(blobId);
    await expect(vault.getBlob(blobId)).rejects.toEqual(new BackendError("not_found"));
  });

  it("read-only tabs can read attachments but not write them", async () => {
    const { server, vault, dev } = await owner();
    const blobId = await vault.putBlob(new Uint8Array([1, 2, 3]));
    const bia = await member(server, vault.projectId, dev.backend);
    const reader = bia.vault(vault.projectId);
    await reader.unlock("senha do projeto");
    expect(Array.from(await reader.getBlob(blobId))).toEqual([1, 2, 3]);
    await expectVaultError(reader.putBlob(new Uint8Array([4])), "read_only");
  });
});

describe("accounts", () => {
  it("signs in with the account password; a wrong one is refused", async () => {
    const server = new MemoryServer();
    const dev = await device(server);
    await account(dev.backend, "ana@example.com");
    expect((await dev.backend.currentSession())?.email).toBe("ana@example.com");
    await dev.backend.signOut();
    await login(dev.backend, "ana@example.com");
    expect((await dev.backend.currentSession())?.email).toBe("ana@example.com");
    await dev.backend.signOut();
    await expect(
      (async () => {
        const { signIn } = await import("../src/index.ts");
        const { TEST_KDF } = await import("./helpers.ts");
        await signIn(dev.backend, "ana@example.com", "outra senha", TEST_KDF);
      })(),
    ).rejects.toEqual(new BackendError("unauthorized"));
  });
});
