/**
 * Attachments kept on this device until the sync uploads them, attachments of removed documents deleted from the
 * server in a later session, and what a lock waits for (docs/19 §6.4, §8).
 */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { BackendError, MemoryServer, VaultCache, VaultError, type PlainRecord } from "../src/index.ts";
import { account, createProject, device, intercept } from "./helpers.ts";

const doc = (id: string, blobId: string): PlainRecord => ({ kind: "document", id, payload: { blob_id: blobId } });
const bytes = new TextEncoder().encode("%PDF-1.4\nrecibo\n%%EOF");

async function owner() {
  const server = new MemoryServer();
  const dev = await device(server);
  await account(dev.backend, "ana@example.com");
  const { vault } = await createProject(dev);
  // The same browser session as the vault's, to look at the server directly.
  return { server, real: dev.backend, dev, vault };
}

describe("attachments stored on this device", () => {
  it("need no network, survive a lock and a reload, and are uploaded before the records that cite them", async () => {
    const { server, real, dev, vault } = await owner();
    server.offline = true;
    const blobId = await vault.storeBlob(bytes);
    await vault.stage([doc("d1", blobId)]);
    expect(vault.getSnapshot()).toMatchObject({ pending: 2 });
    expect(new TextDecoder().decode(await vault.getBlob(blobId))).toContain("recibo");
    await vault.lock();

    // A new page, the network back: the record reaches the server only after its attachment.
    server.offline = false;
    const seen: boolean[] = [];
    const watching = intercept(real, {
      push: async (projectId, leaseId, records) => {
        seen.push(
          await real.getBlob(projectId, blobId).then(
            () => true,
            () => false,
          ),
        );
        return real.push(projectId, leaseId, records);
      },
    });
    const again = await device(server, watching, dev.factory);
    // The same tab reloaded: its lease, never released while offline, comes back to it.
    const reopened = again.vault(vault.projectId, { holder: vault.holder });
    await reopened.unlock("senha do projeto");
    await reopened.syncNow();
    expect(reopened.getSnapshot()).toMatchObject({ status: "synced", pending: 0 });
    expect(seen).toEqual([true]);
    expect(await again.cache.listBlobs(vault.projectId)).toEqual([]);
  });

  it("are uploaded by the push made on locking", async () => {
    const { real, vault } = await owner();
    const blobId = await vault.storeBlob(bytes);
    await vault.stage([doc("d1", blobId)]);
    await vault.lock();
    expect((await real.getBlob(vault.projectId, blobId)).length).toBeGreaterThan(bytes.length);
  });

  it("one larger than the server takes is refused at once", async () => {
    const { vault } = await owner();
    await expect(vault.storeBlob(new Uint8Array(64 * 1_048_576))).rejects.toEqual(new VaultError("too_large"));
    expect(vault.getSnapshot()).toMatchObject({ pending: 0 });
  });
});

describe("attachments of removed documents", () => {
  async function retiredOne() {
    const context = await owner();
    const { vault } = context;
    const blobId = await vault.storeBlob(bytes);
    await vault.stage([doc("d1", blobId)]);
    await vault.syncNow();
    await vault.stage([], [{ kind: "document", id: "d1" }]);
    await vault.retireBlob(blobId);
    await vault.syncNow();
    return { ...context, blobId };
  }

  it("are not deleted in the session that retired them: an undo there may still cite them", async () => {
    const { real, vault, blobId } = await retiredOne();
    expect(vault.hasBlobsToCollect).toBe(false);
    await vault.collectBlobs(() => false);
    expect(await real.getBlob(vault.projectId, blobId)).toBeInstanceOf(Uint8Array);
  });

  it("are deleted from the server in a later session, once no record cites them", async () => {
    const { real, dev, vault, blobId } = await retiredOne();
    await vault.lock();
    const next = dev.vault(vault.projectId);
    await next.unlock("senha do projeto");
    await next.syncNow();
    expect(next.hasBlobsToCollect).toBe(true);
    await next.collectBlobs(() => false);
    await expect(real.getBlob(vault.projectId, blobId)).rejects.toEqual(new BackendError("not_found"));
    expect(next.hasBlobsToCollect).toBe(false);
    expect(await dev.cache.listBlobs(vault.projectId)).toEqual([]);
  });

  it("one cited again (an undo, the server's version of a conflict) is kept and no longer retired", async () => {
    const { real, dev, vault, blobId } = await retiredOne();
    await vault.lock();
    const next = dev.vault(vault.projectId);
    await next.unlock("senha do projeto");
    await next.syncNow();
    await next.collectBlobs((id) => id === blobId);
    expect(await real.getBlob(vault.projectId, blobId)).toBeInstanceOf(Uint8Array);
    expect(await dev.cache.listBlobs(vault.projectId)).toEqual([]);
  });

  it("a deletion that fails is tried again on the next call", async () => {
    const { server, real, dev, vault, blobId } = await retiredOne();
    await vault.lock();
    const next = dev.vault(vault.projectId);
    await next.unlock("senha do projeto");
    await next.syncNow();
    server.offline = true;
    await next.collectBlobs(() => false);
    server.offline = false;
    await next.syncNow();
    expect(next.hasBlobsToCollect).toBe(true);
    await next.collectBlobs(() => false);
    await expect(real.getBlob(vault.projectId, blobId)).rejects.toEqual(new BackendError("not_found"));
  });
});

describe("the lease and the lock", () => {
  it("a change made as the editor is kept after the lease was lost, and pushed once it is back", async () => {
    const { real, vault } = await owner();
    await real.acquireEditLease(vault.projectId, "outra-aba", true);
    // The tab learns it lost the lease when it pushes.
    await vault.stage([doc("d1", "a".repeat(32))]);
    await vault.syncNow();
    expect(vault.getSnapshot().status).toBe("readOnly");
    expect(() => vault.stage([doc("x", "a".repeat(32))])).toThrow(new VaultError("read_only"));
    await vault.stage([doc("d2", "a".repeat(32))], [], { madeAsEditor: true });
    expect(vault.getSnapshot()).toMatchObject({ pending: 2 });
    await vault.takeOver();
    await vault.syncNow();
    expect(vault.getSnapshot()).toMatchObject({ status: "synced", pending: 0 });
    expect((await real.pull(vault.projectId, 0)).records).toHaveLength(2);
  });

  it("locking first waits for what the app still hands over", async () => {
    const { real, vault } = await owner();
    let handOver: () => void = () => undefined;
    vault.setBeforeLock(
      () =>
        new Promise<void>((resolve) => {
          handOver = () => void vault.stage([doc("d1", "a".repeat(32))]).then(resolve);
        }),
    );
    const locking = vault.lock();
    handOver();
    await locking;
    expect((await real.pull(vault.projectId, 0)).records).toHaveLength(1);
  });
});

describe("cache version 3", () => {
  it("upgrades a version 2 cache: its rows stay and the attachments store is added", async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const req = factory.open("opesvault", 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("projects", { keyPath: "projectId" });
        const records = db.createObjectStore("records", { keyPath: ["projectId", "id"] });
        records.createIndex("byGen", ["projectId", "gen"]);
        const pending = db.createObjectStore("pending", { keyPath: ["projectId", "id"] });
        db.createObjectStore("snapshots", { keyPath: "projectId" });
        pending.put({ projectId: "p", id: "a".repeat(32), baseRevision: 0, ciphertext: "AAAA", seq: "s" });
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    const cache = await VaultCache.open({ factory, keyRange: IDBKeyRange });
    expect(await cache.listPending("p")).toHaveLength(1);
    expect(await cache.listBlobs("p")).toEqual([]);
    await cache.putBlob({ projectId: "p", id: "b".repeat(32), sealed: new Uint8Array([1]), retired: false });
    await cache.updateBlob("p", "b".repeat(32), { sealed: null });
    // Uploaded and not retired: nothing left to do, so the row goes.
    expect(await cache.listBlobs("p")).toEqual([]);
    cache.close();
  });
});
