import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { MemoryServer, VaultCache, type PlainRecord, type ProjectVault } from "../src/index.ts";
import { account, createProject, device, settle, type Device } from "./helpers.ts";

const op = (id: string, description: string): PlainRecord => ({
  kind: "operation",
  id,
  payload: { description, amount: "10.00" },
});

/** Small thresholds, so that a handful of records behaves like a big project. */
const RULE = { deviceSnapshot: { minRecords: 2, stale: 3, delayMs: 1000 } };

async function project(): Promise<{ server: MemoryServer; dev: Device; projectId: string; holder: string }> {
  const server = new MemoryServer();
  const dev = await device(server);
  await account(dev.backend, "ana@example.com");
  const { vault } = await createProject(dev);
  await vault.stage([op("1", "um"), op("2", "dois"), op("3", "três")]);
  await vault.syncNow();
  await vault.lock();
  return { server, dev, projectId: vault.projectId, holder: vault.holder };
}

async function open(dev: Device, projectId: string, holder: string): Promise<ProjectVault> {
  const vault = dev.vault(projectId, { holder, ...RULE });
  await vault.unlock("senha do projeto");
  return vault;
}

async function writeSnapshot(dev: Device, projectId: string): Promise<void> {
  await dev.timers.advance(1000);
  for (let i = 0; i < 200 && (await dev.cache.getSnapshot(projectId)) === null; i++) await settle(5);
}

describe("the device snapshot (docs/19 §8)", () => {
  it("is written a moment after a big project opens, sealed for this project and generation", async () => {
    const { dev, projectId, holder } = await project();
    const vault = await open(dev, projectId, holder);
    expect(await dev.cache.getSnapshot(projectId)).toBeNull(); // not at once: after the delay
    await writeSnapshot(dev, projectId);
    const snapshot = await dev.cache.getSnapshot(projectId);
    const row = await dev.cache.getProject(projectId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.generation).toBe(row!.generation);
    // ciphertext only: nothing of the records reads in it
    expect(new TextDecoder().decode(snapshot!.sealed)).not.toMatch(/operation|três|dois/);
    await vault.lock();
  });

  it("reopens from the snapshot plus what was written after it: changes and deletions", async () => {
    const { dev, projectId, holder } = await project();
    const first = await open(dev, projectId, holder);
    await writeSnapshot(dev, projectId);
    const snapshot = await dev.cache.getSnapshot(projectId);
    await first.stage([op("2", "dois, corrigido"), op("4", "quatro")], [{ kind: "operation", id: "3" }]);
    await first.syncNow();
    await first.lock();
    // what the snapshot does not hold is in the rows written after it
    expect((await dev.cache.listRecordsSince(projectId, snapshot!.generation)).length).toBe(3);
    const reloaded = await dev.reload();
    const again = await open(reloaded, projectId, holder);
    expect(again.get("operation", "1")).toEqual(op("1", "um"));
    expect(again.get("operation", "2")).toEqual(op("2", "dois, corrigido"));
    expect(again.get("operation", "3")).toBeUndefined();
    expect(again.get("operation", "4")).toEqual(op("4", "quatro"));
    expect(again.getSnapshot()).toMatchObject({ status: "synced", pending: 0 });
    await again.lock();
  });

  it("is rewritten once enough records changed after it", async () => {
    const { dev, projectId, holder } = await project();
    const vault = await open(dev, projectId, holder);
    await writeSnapshot(dev, projectId);
    const before = (await dev.cache.getSnapshot(projectId))!.generation;
    await vault.stage([op("5", "cinco")]);
    await vault.syncNow();
    await dev.timers.advance(1000);
    expect((await dev.cache.getSnapshot(projectId))!.generation).toBe(before); // one record: not yet
    await vault.stage([op("6", "seis"), op("7", "sete"), op("8", "oito")]);
    await vault.syncNow();
    await dev.timers.advance(1000);
    for (let i = 0; i < 200 && (await dev.cache.getSnapshot(projectId))!.generation === before; i++) await settle();
    expect((await dev.cache.getSnapshot(projectId))!.generation).toBeGreaterThan(before);
    await vault.lock();
  });

  it("is not written while changes wait to be sent (memory and cache must say the same)", async () => {
    const { server, dev, projectId, holder } = await project();
    const vault = await open(dev, projectId, holder);
    server.offline = true;
    await vault.stage([op("9", "pendente")]);
    await dev.timers.advance(1000);
    await settle();
    expect(await dev.cache.getSnapshot(projectId)).toBeNull();
    expect(vault.getSnapshot().pending).toBe(1);
    await vault.lock();
  });

  it("one that does not open is dropped, and the project opens from the records as before", async () => {
    const { dev, projectId, holder } = await project();
    const first = await open(dev, projectId, holder);
    await writeSnapshot(dev, projectId);
    await first.lock();
    const good = (await dev.cache.getSnapshot(projectId))!;
    const tampered = good.sealed.slice();
    tampered[tampered.length - 1]! ^= 1;
    await dev.cache.removeSnapshot(projectId);
    await dev.cache.putSnapshot({ ...good, sealed: tampered });
    const again = await open(dev, projectId, holder);
    expect(again.get("operation", "3")).toEqual(op("3", "três"));
    expect(await dev.cache.getSnapshot(projectId)).toBeNull();
    await again.lock();
  });

  it("is compressed, and one of the earlier, uncompressed format is dropped and written again", async () => {
    const { dev, projectId, holder } = await project();
    const first = await open(dev, projectId, holder);
    await writeSnapshot(dev, projectId);
    await first.lock();
    const good = (await dev.cache.getSnapshot(projectId))!;
    expect(good.sealed[0]).toBe(2); // format 2: gzip inside the seal
    const old = good.sealed.slice();
    old[0] = 1;
    await dev.cache.removeSnapshot(projectId);
    await dev.cache.putSnapshot({ ...good, sealed: old });
    const again = await open(dev, projectId, holder);
    expect(again.get("operation", "3")).toEqual(op("3", "três"));
    expect(await dev.cache.getSnapshot(projectId)).toBeNull();
    await writeSnapshot(dev, projectId);
    expect((await dev.cache.getSnapshot(projectId))!.sealed[0]).toBe(2);
    await again.lock();
  });

  it("a snapshot from a later generation than the cache is never used", async () => {
    const { dev, projectId, holder } = await project();
    const first = await open(dev, projectId, holder);
    await writeSnapshot(dev, projectId);
    await first.lock();
    const snapshot = (await dev.cache.getSnapshot(projectId))!;
    const row = (await dev.cache.getProject(projectId))!;
    // a project row written anew (a new project with the same id) drops it
    await dev.cache.putProject({ ...row, generation: 0 });
    expect(await dev.cache.getSnapshot(projectId)).toBeNull();
    await dev.cache.putSnapshot({ ...snapshot, generation: 5 });
    const again = await open(dev, projectId, holder);
    expect(again.get("operation", "1")).toEqual(op("1", "um"));
    await again.lock();
  });

  it("forgetting the project or the device removes it", async () => {
    const { dev, projectId, holder } = await project();
    const vault = await open(dev, projectId, holder);
    await writeSnapshot(dev, projectId);
    await vault.lock();
    await dev.cache.forgetProject(projectId);
    expect(await dev.cache.getSnapshot(projectId)).toBeNull();
  });
});

describe("cache version 2", () => {
  it("upgrades a version 1 cache: old rows stay, and only rows written later count as after a snapshot", async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const req = factory.open("opesvault", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("projects", { keyPath: "projectId" });
        const records = db.createObjectStore("records", { keyPath: ["projectId", "id"] });
        db.createObjectStore("pending", { keyPath: ["projectId", "id"] });
        records.put({ projectId: "p", id: "a".repeat(32), revision: 1, ciphertext: "AAAA" });
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    const cache = await VaultCache.open({ factory, keyRange: IDBKeyRange });
    expect(await cache.listRecords("p")).toHaveLength(1);
    expect(await cache.listRecordsSince("p", 0)).toHaveLength(0);
    await cache.applyPull("p", [{ id: "b".repeat(32), revision: 2, ciphertext: "BBBB" }], 2, []);
    expect((await cache.getProject("p"))!.generation).toBe(1);
    expect((await cache.listRecordsSince("p", 0)).map((r) => r.id)).toEqual(["b".repeat(32)]);
    expect(await cache.listRecordsSince("p", 1)).toHaveLength(0);
    cache.close();
  });
});

describe("a device that never opened the project (first download)", () => {
  it("stores the pages sealed and opens them together; later changes come the usual way", async () => {
    const { server, dev, projectId, holder } = await project();
    const owner = await open(dev, projectId, holder);
    await owner.stage([op("4", "quatro")], [{ kind: "operation", id: "2" }]);
    await owner.syncNow();
    const other = await device(server);
    await account(other.backend, "bia@example.com");
    await dev.backend.addMember(projectId, "bia@example.com");
    const bia = other.vault(projectId, RULE);
    await bia.unlock("senha do projeto");
    expect(bia.get("operation", "1")).toEqual(op("1", "um"));
    expect(bia.get("operation", "2")).toBeUndefined();
    expect(bia.get("operation", "4")).toEqual(op("4", "quatro"));
    expect((await other.cache.listRecords(projectId)).length).toBeGreaterThanOrEqual(4);
    const heard: string[] = [];
    bia.onRemoteChange((change) => heard.push(...change.upserts.map((r) => r.id)));
    await owner.stage([op("5", "cinco")]);
    await owner.syncNow();
    await bia.syncNow();
    expect(bia.get("operation", "5")).toEqual(op("5", "cinco"));
    expect(heard).toEqual(["5"]);
    await bia.lock();
    await owner.lock();
  });
});
