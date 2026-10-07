import { describe, expect, it } from "vitest";
import {
  MemoryServer,
  VaultCache,
  type PlainRecord,
  type ProjectVault,
  type SyncBackend,
  type UnlockProgress,
} from "../src/index.ts";
import { account, createProject, device, intercept, settle, until, type Device } from "./helpers.ts";

const op = (id: string, description = `lançamento ${id}`): PlainRecord => ({
  kind: "operation",
  id,
  payload: { description, amount: "10.00" },
});

const PASSWORD = "senha do projeto";
const COUNT = 12;

/** A project of COUNT records, each in its own push (one revision each): a download in many small pages. */
async function project(): Promise<{ server: MemoryServer; owner: ProjectVault; ownerDev: Device; projectId: string }> {
  const server = new MemoryServer();
  const dev = await device(server);
  await account(dev.backend, "ana@example.com");
  const { vault } = await createProject(dev, "Casa", PASSWORD);
  for (let i = 1; i <= COUNT; i++) {
    await vault.stage([op(String(i))]);
    await vault.syncNow();
  }
  return { server, owner: vault, ownerDev: dev, projectId: vault.projectId };
}

/** Bia's browser: pulls come in small pages; `onPull` hears each one (the limit the vault asked for). */
async function biaDevice(
  server: MemoryServer,
  onPull: (call: number, limit: number | undefined) => void = () => undefined,
): Promise<{ dev: Device; backend: SyncBackend }> {
  const base = server.client();
  let calls = 0;
  const backend = intercept(base, {
    pull: async (projectId, since, limit) => {
      calls += 1;
      const page = await base.pull(projectId, since, 2);
      onPull(calls, limit);
      return page;
    },
  });
  const dev = await device(server, backend);
  return { dev, backend };
}

async function setup(onPull?: (call: number, limit: number | undefined) => void) {
  const { server, owner, ownerDev, projectId } = await project();
  const { dev } = await biaDevice(server, onPull);
  await account(dev.backend, "bia@example.com");
  await ownerDev.backend.addMember(projectId, "bia@example.com");
  return { server, owner, projectId, dev };
}

function expectProject(vault: ProjectVault): void {
  for (let i = 1; i <= COUNT; i++) expect(vault.get("operation", String(i))).toEqual(op(String(i)));
  expect(vault.records.size).toBe(COUNT);
}

describe("first download on a new device", () => {
  it("reports progress: records received, share of the revisions, then records decrypted", async () => {
    const { owner, projectId, dev } = await setup();
    const heard: UnlockProgress[] = [];
    const bia = dev.vault(projectId, { downloadBatch: 4 });
    await bia.unlock(PASSWORD, { onProgress: (p) => heard.push(p) });
    expectProject(bia);
    const downloads = heard.filter((p) => p.phase === "download");
    const opens = heard.filter((p) => p.phase === "open");
    expect(downloads.length).toBeGreaterThan(3);
    expect(downloads.every((p) => p.total === null)).toBe(true);
    const done = downloads.map((p) => p.done);
    expect(done).toEqual([...done].sort((a, b) => a - b));
    expect(done.at(-1)).toBe(COUNT);
    const fractions = downloads.map((p) => p.fraction ?? -1);
    expect(fractions[0]).toBe(0);
    expect(fractions.at(-1)).toBe(1);
    expect(opens.at(-1)).toMatchObject({ done: COUNT, total: COUNT, fraction: 1 });
    await bia.lock();
    await owner.lock();
  });

  it("stores several pages in one transaction", async () => {
    const { owner, projectId, dev } = await setup();
    const writes: number[] = [];
    const applyPull = dev.cache.applyPull.bind(dev.cache);
    dev.cache.applyPull = (...args: Parameters<VaultCache["applyPull"]>) => {
      writes.push(args[1].length);
      return applyPull(...args);
    };
    const bia = dev.vault(projectId);
    await bia.unlock(PASSWORD);
    expectProject(bia);
    // pages of one or two records, all in one write (the default batch is thousands of records)
    expect(writes.filter((n) => n > 0)).toEqual([COUNT]);
    await bia.lock();
    await owner.lock();
  });

  it("can be cancelled: the vault stays locked, and the next open goes on from where it stopped", async () => {
    const controller = new AbortController();
    const limits: (number | undefined)[] = [];
    const { owner, projectId, dev } = await setup((call, limit) => {
      limits.push(limit);
      if (call === 4) controller.abort();
    });
    const bia = dev.vault(projectId, { downloadBatch: 2 });
    await expect(bia.unlock(PASSWORD, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(bia.unlocked).toBe(false);
    expect(bia.records.size).toBe(0);
    expect(bia.getSnapshot().status).toBe("locked");
    await until(() => !bia.unlocked);
    await settle();
    // what was stored is consistent: rows up to the cursor, marked as a download to go on with
    const row = (await dev.cache.getProject(projectId))!;
    expect(row.downloading).toBe(true);
    expect(row.cursor).toBeGreaterThan(0);
    expect(row.cursor).toBeLessThan(owner.getSnapshot().revision);
    const stored = await dev.cache.listRecords(projectId);
    expect(stored).toHaveLength(6); // three pages of two pushes stored before the fourth was cancelled
    expect(stored.every((r) => r.revision <= row.cursor)).toBe(true);
    // meanwhile the owner deletes a record the stopped download had, and changes another one
    await owner.stage([op("2", "dois, corrigido")], [{ kind: "operation", id: "1" }]);
    await owner.syncNow();
    const serverRevision = owner.getSnapshot().revision;

    const reloaded = await dev.reload();
    const again = reloaded.vault(projectId, { downloadBatch: 2 });
    const heard: UnlockProgress[] = [];
    await again.unlock(PASSWORD, { onProgress: (p) => heard.push(p) });
    expect(again.get("operation", "1")).toBeUndefined();
    expect(again.get("operation", "2")).toEqual(op("2", "dois, corrigido"));
    for (let i = 3; i <= COUNT; i++) expect(again.get("operation", String(i))).toEqual(op(String(i)));
    expect(again.records.size).toBe(COUNT - 1);
    expect(again.getSnapshot()).toMatchObject({ status: "readOnly", revision: serverRevision, damaged: [] });
    expect((await reloaded.cache.getProject(projectId))!.downloading).toBe(false);
    // it went on as a download (big pages asked for), counting what it already had
    expect(limits.at(-1)).toBe(1000);
    const downloads = heard.filter((p) => p.phase === "download");
    expect(downloads[0]!.done).toBe(stored.length);
    await again.lock();
    await owner.lock();
  });

  it("cancelled before the password is even checked, nothing opens", async () => {
    const { owner, projectId, dev } = await setup();
    const controller = new AbortController();
    const bia = dev.vault(projectId);
    const opening = bia.unlock(PASSWORD, { signal: controller.signal });
    controller.abort();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    await settle(200);
    expect(bia.unlocked).toBe(false);
    expect(bia.records.size).toBe(0);
    // an aborted signal refuses at once
    await expect(bia.unlock(PASSWORD, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    const again = (await dev.reload()).vault(projectId);
    await again.unlock(PASSWORD);
    expectProject(again);
    await again.lock();
    await owner.lock();
  });
});
