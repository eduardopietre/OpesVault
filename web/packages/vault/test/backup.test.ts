import { BackupError, blobSource, bytesSource, concatBytes, toHex, utf8, type Bytes } from "@opesvault/crypto";
import { describe, expect, it } from "vitest";
import {
  BackendError,
  MemoryServer,
  VaultError,
  exportBackup,
  restoreBackup,
  verifyBackup,
  type BackupExportOptions,
  type BlobRefs,
  type PlainRecord,
  type ProjectVault,
} from "../src/index.ts";
import { TEST_KDF, account, createProject, device, intercept, until, type Device } from "./helpers.ts";

const PASSWORD = "senha do projeto";
const CHUNK = 4096;

/** The app's rule: a `document` record points to a blob. */
const refsOf: BlobRefs = (record) => {
  if (record.kind !== "document") return [];
  const payload = record.payload as { blob_id: string; sha256?: string };
  return [{ id: payload.blob_id, sha256: payload.sha256 }];
};

async function sha256(data: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data as Bytes)));
}

const op = (id: string, description: string): PlainRecord => ({
  kind: "operation",
  id,
  payload: { description, amount: "10.00" },
});

async function owner(name = "Família Teste") {
  const server = new MemoryServer();
  const dev = await device(server);
  await account(dev.backend, "ana@example.com");
  const { vault, recoveryKey } = await createProject(dev, name, PASSWORD);
  return { server, dev, vault, recoveryKey };
}

async function addDocument(vault: ProjectVault, id: string, bytes: Uint8Array): Promise<string> {
  const blobId = await vault.putBlob(bytes);
  await vault.stage([
    {
      kind: "document",
      id,
      payload: { id, blob_id: blobId, sha256: await sha256(bytes), original_name: `${id}.pdf`, size: bytes.length },
    },
  ]);
  return blobId;
}

async function backupOf(
  vault: ProjectVault,
  options: BackupExportOptions = {},
): Promise<{ file: Bytes; chunks: Bytes[]; summary: Awaited<ReturnType<typeof exportBackup>> }> {
  const chunks: Bytes[] = [];
  const summary = await exportBackup(vault, PASSWORD, (chunk) => void chunks.push(chunk), {
    blobRefsOf: refsOf,
    kdf: TEST_KDF,
    chunkBytes: CHUNK,
    ...options,
  });
  return { file: concatBytes(...chunks), chunks, summary };
}

function restore(dev: Device, file: Bytes, extra: { password?: string; name?: string } = {}) {
  return restoreBackup({
    source: bytesSource(file),
    password: extra.password ?? PASSWORD,
    backend: dev.backend,
    cache: dev.cache,
    blobRefsOf: refsOf,
    kdf: TEST_KDF,
    ...(extra.name ? { name: extra.name } : {}),
    vaultOptions: { timers: dev.timers, pushDelayMs: 0 },
  });
}

async function projectCount(dev: Device): Promise<number> {
  return (await dev.backend.listProjects()).length;
}

async function reopen(dev: Device, projectId: string, password = PASSWORD): Promise<ProjectVault> {
  const vault = dev.vault(projectId, { pushDelayMs: 0 });
  await vault.unlock(password);
  return vault;
}

const pdf = (n: number) => new Uint8Array(3000 + n).map((_, i) => (i * 7 + n) % 256);

describe("exporting a backup", () => {
  it("writes every record and attachment, and nothing but reads reaches the server", async () => {
    const { vault, dev, server } = await owner();
    await vault.stage([op("1", "Mercado"), op("2", "Farmácia")]);
    await addDocument(vault, "d1", pdf(1));
    await vault.syncNow();
    const calls: string[] = [];
    const watched = intercept(dev.backend, {
      getBlob: (...args) => {
        calls.push("getBlob");
        return dev.backend.getBlob(...args);
      },
      push: () => {
        calls.push("push");
        throw new Error("a backup must not write");
      },
      putBlob: () => {
        calls.push("putBlob");
        throw new Error("a backup must not write");
      },
    });
    const watchedVault = dev.vault(vault.projectId, { backend: watched, pushDelayMs: 0 });
    await watchedVault.unlock(PASSWORD);
    const chunks: Bytes[] = [];
    // vault under watch has its own memory of records; the blob comes from the (watched) server
    const summary = await exportBackup(watchedVault, PASSWORD, (c) => void chunks.push(c), {
      blobRefsOf: refsOf,
      kdf: TEST_KDF,
      chunkBytes: CHUNK,
      now: () => new Date("2026-10-06T09:00:00Z"),
    });
    expect(summary).toMatchObject({ records: 3, documents: 1, missing: [], createdAt: "2026-10-06T09:00:00.000Z" });
    expect(calls).toEqual(["getBlob"]);
    const file = concatBytes(...chunks);
    expect(summary.fileBytes).toBe(file.length);
    // The server's copy of the project did not change because of the export.
    expect(JSON.stringify(server)).not.toContain("Mercado");
    const text = new TextDecoder("latin1").decode(file);
    for (const secret of ["Mercado", "Farm", "Família", "operation", "document", "original_name"])
      expect(text).not.toContain(secret);
  });

  it("asks for the project password again: a wrong one exports nothing", async () => {
    const { vault } = await owner();
    const chunks: Bytes[] = [];
    await expect(exportBackup(vault, "outra senha", (c) => void chunks.push(c), { kdf: TEST_KDF })).rejects.toEqual(
      new VaultError("wrong_password"),
    );
    await expect(exportBackup(vault, "", (c) => void chunks.push(c), { kdf: TEST_KDF })).rejects.toBeInstanceOf(
      VaultError,
    );
    expect(chunks).toHaveLength(0);
  });

  it("refuses to export a locked project", async () => {
    const { vault } = await owner();
    await vault.lock();
    await expect(exportBackup(vault, PASSWORD, () => undefined, { kdf: TEST_KDF })).rejects.toEqual(
      new VaultError("locked"),
    );
  });

  it("lists attachments the server no longer has as missing, and still writes the backup", async () => {
    const { vault, dev } = await owner();
    const ok = await addDocument(vault, "d1", pdf(1));
    const gone = await addDocument(vault, "d2", pdf(2));
    await vault.syncNow();
    await vault.deleteBlob(gone);
    const reopened = dev.vault(vault.projectId);
    await reopened.unlock(PASSWORD);
    const { summary, file } = await backupOf(reopened);
    expect(summary).toMatchObject({ records: expect.any(Number), documents: 1, missing: [gone] });
    const report = await verifyBackup(bytesSource(file), PASSWORD, { blobRefsOf: refsOf });
    expect(report).toMatchObject({ documents: 1, missing: [gone], dangling: [], hashMismatches: [] });
    expect(ok).not.toBe(gone);
  });

  it("stops (and writes no complete file) when an attachment cannot be read for another reason", async () => {
    const { vault, dev } = await owner();
    await addDocument(vault, "d1", pdf(1));
    await vault.syncNow();
    const flaky = intercept(dev.backend, { getBlob: () => Promise.reject(new BackendError("offline")) });
    const reopened = dev.vault(vault.projectId, { backend: flaky });
    await reopened.unlock(PASSWORD);
    await expect(backupOf(reopened)).rejects.toBeInstanceOf(VaultError);
  });
});

describe("verifying a backup", () => {
  it("decrypts the whole file and reports what it holds, without touching any project", async () => {
    const { vault, dev } = await owner("Casa da Praia");
    await vault.stage([op("1", "a"), op("2", "b"), op("3", "c")]);
    await addDocument(vault, "d1", pdf(1));
    await addDocument(vault, "d2", pdf(2));
    const { file } = await backupOf(vault);
    const before = await projectCount(dev);
    const progress: string[] = [];
    const report = await verifyBackup(blobSource(new Blob([file])), PASSWORD, {
      blobRefsOf: refsOf,
      onProgress: (p) => void progress.push(p.phase),
    });
    expect(report).toMatchObject({
      version: 1,
      chunkBytes: CHUNK,
      projectName: "Casa da Praia",
      records: 5,
      byKind: { operation: 3, document: 2 },
      documents: 2,
      documentBytes: pdf(1).length + pdf(2).length,
      missing: [],
      dangling: [],
      hashMismatches: [],
      orphans: 0,
      fileBytes: file.length,
    });
    expect(report.kdf).toEqual(TEST_KDF);
    expect(await projectCount(dev)).toBe(before);
  });

  it("reports references to attachments that are not in the file, and hashes that do not match", async () => {
    const { vault } = await owner();
    const blobId = await addDocument(vault, "d1", pdf(1));
    await vault.stage([
      { kind: "document", id: "d9", payload: { id: "d9", blob_id: "f".repeat(32), sha256: "0".repeat(64) } },
    ]);
    // Written without telling the exporter about d9's reference: it is neither a blob nor missing.
    const { file } = await backupOf(vault, { blobRefsOf: (r) => (r.id === "d1" ? refsOf(r) : []) });
    const report = await verifyBackup(bytesSource(file), PASSWORD, { blobRefsOf: refsOf });
    expect(report.dangling).toEqual(["f".repeat(32)]);
    // A reader that expects another hash for the same blob finds the mismatch.
    const strict = await verifyBackup(bytesSource(file), PASSWORD, {
      blobRefsOf: (r) => (r.id === "d1" ? [{ id: blobId, sha256: "1".repeat(64) }] : []),
    });
    expect(strict.hashMismatches).toEqual([blobId]);
    const orphan = await verifyBackup(bytesSource(file), PASSWORD, { blobRefsOf: () => [] });
    expect(orphan.orphans).toBe(1);
  });

  it("refuses a wrong password, a file from another program and another format version", async () => {
    const { vault } = await owner();
    const { file } = await backupOf(vault);
    await expect(verifyBackup(bytesSource(file), "errada")).rejects.toEqual(new BackupError("wrong_password"));
    await expect(
      verifyBackup(bytesSource(utf8("PK\u0003\u0004 zip, not a backup, long enough to read")), PASSWORD),
    ).rejects.toEqual(new BackupError("not_a_backup"));
    const future = file.slice();
    future[4] = 2;
    await expect(verifyBackup(bytesSource(future), PASSWORD)).rejects.toEqual(new BackupError("unsupported_version"));
  });

  it("detects a flipped bit, a cut and an extension anywhere in a real backup", async () => {
    const { vault } = await owner();
    await vault.stage(Array.from({ length: 200 }, (_, i) => op(String(i), `Lançamento ${i} ${"x".repeat(60)}`)));
    await addDocument(vault, "d1", pdf(1));
    const { file, chunks } = await backupOf(vault);
    expect(chunks.length).toBeGreaterThan(4);
    for (const at of [60, file.length >> 1, file.length - 1]) {
      const copy = file.slice();
      copy[at] = copy[at]! ^ 0x80;
      await expect(verifyBackup(bytesSource(copy), PASSWORD, { blobRefsOf: refsOf })).rejects.toBeInstanceOf(
        BackupError,
      );
    }
    await expect(verifyBackup(bytesSource(file.slice(0, file.length - 30)), PASSWORD)).rejects.toEqual(
      new BackupError("corrupted"),
    );
    await expect(verifyBackup(bytesSource(concatBytes(file, new Uint8Array(50))), PASSWORD)).rejects.toEqual(
      new BackupError("corrupted"),
    );
    const cutAtBoundary = concatBytes(...chunks.slice(0, -1));
    await expect(verifyBackup(bytesSource(cutAtBoundary), PASSWORD)).rejects.toEqual(new BackupError("corrupted"));
  });

  it("detects chunks swapped between two backups of different projects", async () => {
    const a = await owner("Projeto A");
    const b = await owner("Projeto B");
    await a.vault.stage(Array.from({ length: 150 }, (_, i) => op(String(i), `A${i} ${"x".repeat(60)}`)));
    await b.vault.stage(Array.from({ length: 150 }, (_, i) => op(String(i), `B${i} ${"x".repeat(60)}`)));
    const fileA = await backupOf(a.vault);
    const fileB = await backupOf(b.vault);
    const mixed = fileA.chunks.slice();
    mixed[2] = fileB.chunks[2]!;
    await expect(verifyBackup(bytesSource(concatBytes(...mixed)), PASSWORD)).rejects.toEqual(
      new BackupError("corrupted"),
    );
  });
});

describe("restoring a backup", () => {
  it("creates a NEW project with the same records and attachments and leaves the original untouched", async () => {
    const { vault, dev, recoveryKey } = await owner("Casa");
    await vault.stage([op("1", "Mercado"), op("2", "Farmácia")]);
    const first = pdf(1);
    const blobId = await addDocument(vault, "d1", first);
    await vault.syncNow();
    const originalRevision = vault.getSnapshot().revision;
    const { file } = await backupOf(vault);
    const progress: string[] = [];

    const restored = await restoreBackup({
      source: bytesSource(file),
      password: PASSWORD,
      backend: dev.backend,
      cache: dev.cache,
      blobRefsOf: refsOf,
      kdf: TEST_KDF,
      name: "Casa (restaurado)",
      vaultOptions: { timers: dev.timers, pushDelayMs: 0 },
      onProgress: (p) => void progress.push(p.phase),
    });
    expect(restored.projectId).not.toBe(vault.projectId);
    expect(restored.name).toBe("Casa (restaurado)");
    expect(restored.recoveryKey).toMatch(/^([0-9A-Z]{4}-){8}[0-9A-Z]{4}$/);
    expect(restored.report).toMatchObject({ records: 3, documents: 1, projectName: "Casa" });
    expect(progress).toContain("restoring");
    expect(await projectCount(dev)).toBe(2);

    // The original: same revision, same records.
    expect(vault.getSnapshot().revision).toBe(originalRevision);
    await vault.syncNow();
    expect(vault.getSnapshot().revision).toBe(originalRevision);

    // The new one opens with the password, holds identical records and the attachment under the same id.
    const copy = await reopen(dev, restored.projectId);
    expect(copy.getSnapshot().name).toBe("Casa (restaurado)");
    const plain = (v: ProjectVault) =>
      [...v.records.values()].sort((x, y) => (x.kind + x.id).localeCompare(y.kind + y.id));
    expect(plain(copy)).toEqual(plain(vault));
    expect(await copy.getBlob(blobId)).toEqual(first);
    // ...and it is a different project: its own key, so the old recovery key does not open it.
    await expect(dev.vault(restored.projectId).unlockWithRecovery(recoveryKey, "nova senha")).rejects.toEqual(
      new VaultError("wrong_recovery_key"),
    );
  });

  it("restores with the file's own name by default and with the file's password (not the project's current one)", async () => {
    const { vault, dev } = await owner("Casa");
    await vault.stage([op("1", "Mercado")]);
    const { file } = await backupOf(vault);
    await vault.changePassword(PASSWORD, "senha nova do projeto");
    // The old backup still opens with the old password (docs/03 §7); the restored project takes that one.
    const restored = await restore(dev, file);
    expect(restored.name).toBe("Casa");
    const copy = await reopen(dev, restored.projectId, PASSWORD);
    expect(copy.get("operation", "1")).toBeDefined();
    await expect(reopen(dev, restored.projectId, "senha nova do projeto")).rejects.toEqual(
      new VaultError("wrong_password"),
    );
  });

  it("a wrong password, a damaged file or another version creates no project at all", async () => {
    const { vault, dev } = await owner();
    await vault.stage(Array.from({ length: 80 }, (_, i) => op(String(i), `L${i}`)));
    await addDocument(vault, "d1", pdf(1));
    const { file } = await backupOf(vault);
    const before = await projectCount(dev);
    await expect(restore(dev, file, { password: "errada" })).rejects.toEqual(new BackupError("wrong_password"));
    const damaged = file.slice();
    damaged[file.length - 5] = damaged[file.length - 5]! ^ 1;
    await expect(restore(dev, damaged)).rejects.toEqual(new BackupError("corrupted"));
    const future = file.slice();
    future[4] = 9;
    await expect(restore(dev, future)).rejects.toEqual(new BackupError("unsupported_version"));
    await expect(restore(dev, file.slice(0, file.length - 40))).rejects.toEqual(new BackupError("corrupted"));
    expect(await projectCount(dev)).toBe(before);
  });

  it("removes the half-made project when something fails while filling it", async () => {
    const { vault, dev } = await owner();
    await addDocument(vault, "d1", pdf(1));
    await vault.syncNow();
    const { file } = await backupOf(vault);
    const before = await projectCount(dev);
    const failing = intercept(dev.backend, { putBlob: () => Promise.reject(new BackendError("too_large")) });
    await expect(
      restoreBackup({
        source: bytesSource(file),
        password: PASSWORD,
        backend: failing,
        cache: dev.cache,
        blobRefsOf: refsOf,
        kdf: TEST_KDF,
        vaultOptions: { timers: dev.timers, pushDelayMs: 0 },
      }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(await projectCount(dev)).toBe(before);
  });

  it("restoring twice makes two separate projects (never over an existing one)", async () => {
    const { vault, dev } = await owner();
    await vault.stage([op("1", "a")]);
    const { file } = await backupOf(vault);
    const one = await restore(dev, file);
    const two = await restore(dev, file);
    expect(new Set([vault.projectId, one.projectId, two.projectId]).size).toBe(3);
    expect(await projectCount(dev)).toBe(3);
  });

  it("restores a large project in chunks: records in batches, big attachments one at a time", async () => {
    const { vault, dev } = await owner("Grande");
    const records = Array.from({ length: 3000 }, (_, i) => op(String(i), `Lançamento ${i} ${"x".repeat(80)}`));
    for (let i = 0; i < records.length; i += 500) await vault.stage(records.slice(i, i + 500));
    const big = new Uint8Array(2 * 1024 * 1024).map((_, i) => (i * 31) % 253);
    const bigId = await addDocument(vault, "grande", big);
    await vault.syncNow();
    const sizes: number[] = [];
    const summary = await exportBackup(vault, PASSWORD, (c) => void sizes.push(c.length), {
      blobRefsOf: refsOf,
      kdf: TEST_KDF,
      chunkBytes: 64 * 1024,
    });
    expect(summary).toMatchObject({ records: 3001, documents: 1 });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024 + 16);
    expect(sizes.length).toBeGreaterThan(40);
    // Rebuild the file from the sizes' source: export again, keeping the bytes
    const chunks: Bytes[] = [];
    await exportBackup(vault, PASSWORD, (c) => void chunks.push(c), {
      blobRefsOf: refsOf,
      kdf: TEST_KDF,
      chunkBytes: 64 * 1024,
    });
    const restored = await restore(dev, concatBytes(...chunks));
    const copy = await reopen(dev, restored.projectId);
    expect(copy.records.size).toBe(3001);
    expect(copy.get("operation", "2999")).toEqual(vault.get("operation", "2999"));
    expect(await copy.getBlob(bigId)).toEqual(big);
  }, 60_000);
});

describe("the project password and the idle lock", () => {
  it("checkPassword only checks", async () => {
    const { vault } = await owner();
    await vault.checkPassword(PASSWORD);
    await expect(vault.checkPassword("errada")).rejects.toEqual(new VaultError("wrong_password"));
    expect(vault.unlocked).toBe(true);
  });

  it("the idle lock time can change while the project is open", async () => {
    const server = new MemoryServer();
    const dev = await device(server);
    await account(dev.backend, "ana@example.com");
    const { vault } = await createProject(dev, "Casa", PASSWORD);
    // created without an idle lock: none runs
    await dev.timers.advance(3_600_000);
    expect(vault.unlocked).toBe(true);
    vault.setIdleLock(60_000);
    await dev.timers.advance(59_000);
    expect(vault.unlocked).toBe(true);
    vault.touch();
    await dev.timers.advance(59_000);
    expect(vault.unlocked).toBe(true);
    await dev.timers.advance(2_000);
    await until(() => !vault.unlocked);
    expect(vault.unlocked).toBe(false);
    // turned off again: staying unlocked
    await vault.unlock(PASSWORD);
    vault.setIdleLock(null);
    await dev.timers.advance(3_600_000);
    expect(vault.unlocked).toBe(true);
  });

  it("an attachment can be stored under a chosen id, and only a well-formed one", async () => {
    const { vault } = await owner();
    const id = "c".repeat(32);
    expect(await vault.putBlob(pdf(1), id)).toBe(id);
    expect(await vault.getBlob(id)).toEqual(pdf(1));
    await expect(vault.putBlob(pdf(1), "../etc/passwd")).rejects.toBeInstanceOf(TypeError);
  });
});
