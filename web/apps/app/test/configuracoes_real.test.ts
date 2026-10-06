/**
 * The services behind Configurações, for real: the vault over the in-memory reference server and a fake
 * IndexedDB. Changing the password, regenerating the recovery key, renaming, the idle lock, the backup file
 * (export, verify, restore as a new project, tampering) and forgetting the device.
 */
import "fake-indexeddb/auto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { AccountType, dom, queries, type IsoDate } from "@opesvault/domain";
import { MemoryServer, VaultCache, type Timers } from "@opesvault/vault";
import { describe, expect, it } from "vitest";
import { createRealServices } from "../src/services/real.ts";
import { ServiceError, type AppServices, type OpenProject } from "../src/services/types.ts";

const KDF = { algorithm: "argon2id", memoryKiB: 8192, iterations: 1, parallelism: 1 } as const;
const PASSWORD = "senha do projeto";
const ACCOUNT = "senha da conta";

/** Timers that only fire when the test moves time. */
class ManualTimers implements Timers {
  #now = 1_000_000;
  #next = 1;
  readonly #due = new Map<number, { at: number; callback: () => void }>();
  now() {
    return this.#now;
  }
  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.#next++;
    this.#due.set(handle, { at: this.#now + ms, callback });
    return handle;
  }
  clearTimeout(handle: unknown): void {
    this.#due.delete(handle as number);
  }
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      const next = [...this.#due.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.#due.delete(next[0]);
      this.#now = next[1].at;
      next[1].callback();
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    }
    this.#now = target;
  }
}

function device(server: MemoryServer, holder: string, extra: { timers?: Timers; idleLockMs?: number | null } = {}) {
  const factory = new IDBFactory();
  const services = createRealServices({
    backend: server.client(),
    openCache: () => VaultCache.open({ factory, keyRange: IDBKeyRange }),
    holder,
    kdf: KDF,
    idleLockMs: extra.idleLockMs === undefined ? null : extra.idleLockMs,
    vaultOptions: { pushDelayMs: 0, pollMs: 50, ...(extra.timers ? { timers: extra.timers } : {}) },
  });
  return { services, factory };
}

async function until(condition: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function expectService(work: Promise<unknown>, code: string): Promise<void> {
  const failure = await work.then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ServiceError);
  expect((failure as ServiceError).code).toBe(code);
}

/** A project with a bank account, an expense and a document (a receipt), synced. */
async function project(services: AppServices, name = "Casa") {
  await services.signUp({ name: "Ana Souza", email: "ana@example.com", password: ACCOUNT });
  const created = await services.createProject({ name, password: PASSWORD });
  const open = await services.openProject(created.project.id, PASSWORD);
  const ws = open.workspace;
  const bank = ws.act((l) =>
    l.addAccount({
      id: crypto.randomUUID(),
      name: "Banco",
      type: "asset",
      subtype: "checking",
      currency: "BRL",
      institution: null,
      masked_number: null,
      holders: [],
      parent_id: null,
      archived: false,
    }),
  );
  const food = ws.ledger.categories(AccountType.EXPENSE).find((c) => c.name === "Alimentação")!.id;
  ws.act((l) => l.recordOpeningBalance(bank.id, "1000.00", "2026-01-01" as IsoDate));
  const op = ws.act((l) => l.recordExpense(bank.id, food, "123.45", "2026-01-05" as IsoDate, "Mercado do Zé"));
  const pdf = new TextEncoder().encode("%PDF-1.4\nrecibo do plano de saúde\n%%EOF");
  ws.act((_l, session) => dom.attachments.attach(session, op.id, "recibo.pdf", pdf));
  await ws.settled();
  return { created, open, ws, bank, pdf, op };
}

/** The records as text, in a fixed order (the order they come back from the server is not the creation order). */
function canonical(records: readonly { id: string; kind: string; payload: unknown }[]): string {
  return JSON.stringify([...records].sort((a, b) => `${a.kind}|${a.id}`.localeCompare(`${b.kind}|${b.id}`)));
}

async function download(services: AppServices, password = PASSWORD) {
  return services.exportBackup(password);
}

describe("project password and recovery key", () => {
  it("changes the password: a wrong current one is refused, and afterwards only the new one opens the project", async () => {
    const server = new MemoryServer();
    const a = device(server, "tab-a").services;
    const { created } = await project(a);
    await expectService(a.changePassword("errada", "uma senha bem nova"), "bad-password");
    await expectService(a.changePassword(PASSWORD, ""), "empty-password");
    await a.changePassword(PASSWORD, "uma senha bem nova");
    await a.closeProject();

    const b = device(server, "tab-b").services;
    await b.signIn("ana@example.com", ACCOUNT);
    await expectService(b.openProject(created.project.id, PASSWORD), "bad-password");
    const open = await b.openProject(created.project.id, "uma senha bem nova");
    expect(open.workspace.ledger.operations.size).toBe(2); // the opening balance and the expense
    await b.closeProject();
  }, 30_000);

  it("regenerates the recovery key: shown once, the old one stops working and the new one resets the password", async () => {
    const server = new MemoryServer();
    const a = device(server, "tab-a").services;
    const { created } = await project(a);
    const first = created.recoveryKey;
    await expectService(a.regenerateRecoveryKey("errada"), "bad-password");
    const second = await a.regenerateRecoveryKey(PASSWORD);
    expect(second).toMatch(/^([0-9A-Z]{4}-){8}[0-9A-Z]{4}$/);
    expect(second).not.toBe(first);
    await a.closeProject();

    const b = device(server, "tab-b").services;
    await b.signIn("ana@example.com", ACCOUNT);
    await expectService(b.recoverProject(created.project.id, first, "senha escolhida agora"), "bad-recovery-key");
    await expectService(b.recoverProject(created.project.id, "AAAA-BBBB", "senha escolhida agora"), "bad-recovery-key");
    // mistyped lower case and spaces still read
    const open = await b.recoverProject(
      created.project.id,
      second.toLowerCase().replaceAll("-", " "),
      "senha escolhida agora",
    );
    expect(open.workspace.ledger.operations.size).toBe(2);
    await b.closeProject();
    // the password the recovery set is the one that opens it now
    await expectService(b.openProject(created.project.id, PASSWORD), "bad-password");
    await b.openProject(created.project.id, "senha escolhida agora");
    await b.closeProject();
  }, 30_000);

  it("renames the project: another device sees the new name once it opens it", async () => {
    const server = new MemoryServer();
    const a = device(server, "tab-a").services;
    const { created } = await project(a);
    await expectService(a.renameProject("   "), "empty-name");
    const renamed = await a.renameProject("Casa da Praia");
    expect(renamed.name).toBe("Casa da Praia");
    const b = device(server, "tab-b").services;
    await b.signIn("ana@example.com", ACCOUNT);
    await until(async () => (await b.openProject(created.project.id, PASSWORD)).project.name === "Casa da Praia");
    expect(JSON.stringify(server)).not.toContain("Praia");
    await a.closeProject();
    await b.closeProject();
  }, 30_000);

  it("needs an open project", async () => {
    const a = device(new MemoryServer(), "tab-a").services;
    await a.signUp({ name: "Ana", email: "ana@example.com", password: ACCOUNT });
    await expectService(a.changePassword(PASSWORD, "outra senha longa"), "not-open");
    await expectService(a.exportBackup(PASSWORD), "not-open");
    await expectService(a.renameProject("x"), "not-open");
  });
});

describe("the idle lock", () => {
  it("locks after the chosen time without use, restarts on activity and follows a change of the setting", async () => {
    const timers = new ManualTimers();
    const server = new MemoryServer();
    const { services } = device(server, "tab-a", { timers, idleLockMs: 15 * 60_000 });
    const states: string[] = [];
    const { created } = await project(services);
    await services.closeProject();
    await services.openProject(created.project.id, PASSWORD);
    services.watchSync((status) => void states.push(status));
    states.length = 0;

    services.setIdleLock(1);
    await timers.advance(50_000);
    window.dispatchEvent(new Event("keydown")); // activity: counts from here
    await timers.advance(50_000);
    expect(states).not.toContain("locked");
    await timers.advance(11_000);
    await until(() => states.includes("locked"));
    expect(states.at(-1)).toBe("locked");
    // locked: the key left the tab, so the project needs its password again
    await expectService(services.exportBackup(PASSWORD), "not-open");
    await expect(services.unlock(PASSWORD)).resolves.toBeTruthy();
    // a longer time is respected too
    services.setIdleLock(5);
    states.length = 0;
    await timers.advance(4 * 60_000);
    expect(states).not.toContain("locked");
    await timers.advance(61_000);
    await until(() => states.includes("locked"));
    await services.closeProject();
  }, 30_000);
});

describe("backup file", () => {
  it("exports a sealed file, verifies it, and restores it as a separate project identical to the original", async () => {
    const server = new MemoryServer();
    const { services } = device(server, "tab-a");
    const { created, ws, pdf } = await project(services);
    const progress: string[] = [];
    const file = await services.exportBackup(PASSWORD, (p) => void progress.push(p.phase));
    expect(file.fileName).toMatch(/^opesvault-backup-\d{4}-\d{2}-\d{2}\.ovbackup$/);
    expect(file.documents).toBe(1);
    expect(file.missing).toBe(0);
    expect(progress).toContain("records");
    expect(progress).toContain("documents");
    const text = new TextDecoder("latin1").decode(await file.blob.arrayBuffer());
    for (const secret of ["Casa", "Mercado do Zé", "recibo", "plano de saúde", "operation"]) {
      expect(text).not.toContain(secret);
    }

    const check = await services.verifyBackup(file.blob, PASSWORD);
    expect(check).toMatchObject({
      version: 1,
      projectName: "Casa",
      documents: 1,
      documentBytes: pdf.length,
      missing: 0,
      dangling: 0,
      hashMismatches: 0,
    });
    expect(check.records).toBe(file.records);
    expect(check.byKind["document"]).toBe(1);

    const before = canonical(ws.ledger.toRecords());
    const restored = await services.restoreBackup(file.blob, PASSWORD, "");
    expect(restored.project.id).not.toBe(created.project.id);
    expect(restored.project.name).toBe("Casa (restaurado)");
    expect(restored.recoveryKey).toMatch(/^([0-9A-Z]{4}-){8}[0-9A-Z]{4}$/);
    expect(restored.recoveryKey).not.toBe(created.recoveryKey);
    expect(await services.listProjects()).toHaveLength(2);
    // the original is untouched
    expect(canonical(ws.ledger.toRecords())).toBe(before);

    // the restored project opens with the password, holds the same records and the same document
    const copy = await services.openProject(restored.project.id, PASSWORD);
    expect(canonical(copy.workspace.ledger.toRecords())).toBe(before);
    expect(
      queries
        .balance(
          copy.workspace.ledger,
          [...copy.workspace.ledger.accounts.values()].find((a) => a.name === "Banco")!.id,
        )
        .toFixed(),
    ).toBe("876.55");
    const document = copy.workspace.session.documents[0]!;
    expect(new TextDecoder().decode(await copy.workspace.loadDocument(document.meta.id))).toContain(
      "recibo do plano de saúde",
    );
    await services.closeProject();
  }, 60_000);

  it("refuses a wrong password, a changed file and a cut file, and creates no project", async () => {
    const server = new MemoryServer();
    const { services } = device(server, "tab-a");
    await project(services);
    const file = await download(services);
    await expectService(services.exportBackup("errada"), "bad-password");
    await expectService(services.verifyBackup(file.blob, "errada"), "backup-wrong_password");
    await expectService(services.restoreBackup(file.blob, "errada", ""), "backup-wrong_password");
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    const flipped = bytes.slice();
    flipped[flipped.length - 10] = flipped[flipped.length - 10]! ^ 1;
    await expectService(services.verifyBackup(new Blob([flipped]), PASSWORD), "backup-corrupted");
    await expectService(services.restoreBackup(new Blob([flipped]), PASSWORD, ""), "backup-corrupted");
    await expectService(
      services.restoreBackup(new Blob([bytes.slice(0, bytes.length - 40)]), PASSWORD, ""),
      "backup-corrupted",
    );
    const future = bytes.slice();
    future[4] = 2;
    await expectService(services.restoreBackup(new Blob([future]), PASSWORD, ""), "backup-unsupported_version");
    await expectService(
      services.restoreBackup(
        new Blob([new TextEncoder().encode("não é um backup de verdade, é só texto")]),
        PASSWORD,
        "",
      ),
      "backup-not_a_backup",
    );
    expect(await services.listProjects()).toHaveLength(1);
    await services.closeProject();
  }, 60_000);

  it("restores a backup made before a password change with the old password", async () => {
    const server = new MemoryServer();
    const { services } = device(server, "tab-a");
    await project(services);
    const file = await download(services);
    await services.changePassword(PASSWORD, "uma senha bem nova");
    await expectService(services.restoreBackup(file.blob, "uma senha bem nova", ""), "backup-wrong_password");
    const restored = await services.restoreBackup(file.blob, PASSWORD, "Volta no tempo");
    expect(restored.project.name).toBe("Volta no tempo");
    await services.openProject(restored.project.id, PASSWORD);
    await services.closeProject();
  }, 60_000);

  it("restores onto another device of the same account, without any of the original's cache", async () => {
    const server = new MemoryServer();
    const a = device(server, "tab-a").services;
    await project(a);
    const file = await download(a);
    await a.closeProject();
    const b = device(server, "tab-b").services;
    await b.signIn("ana@example.com", ACCOUNT);
    const restored = await b.restoreBackup(file.blob, PASSWORD, "Outro aparelho");
    const open: OpenProject = await b.openProject(restored.project.id, PASSWORD);
    expect(open.workspace.ledger.operations.size).toBe(2);
    await b.closeProject();
  }, 60_000);
});

describe("forgetting the device", () => {
  it("sends what is waiting, erases the local copy of every project and ends the session", async () => {
    const server = new MemoryServer();
    const { services, factory } = device(server, "tab-a");
    const { created, ws, bank, op } = await project(services);
    const food = ws.ledger.categories(AccountType.EXPENSE)[0]!.id;
    ws.act((l) => l.recordExpense(bank.id, food, "9.90", "2026-01-06" as IsoDate, "Padaria"));
    expect(await services.pendingChanges()).toBe(0); // sent before asking
    expect(op).toBeTruthy();
    const cache = await VaultCache.open({ factory, keyRange: IDBKeyRange });
    expect((await cache.listRecords(created.project.id)).length).toBeGreaterThan(0);
    expect(await cache.getProject(created.project.id)).not.toBeNull();

    await services.forgetDevice();
    expect(await cache.listRecords(created.project.id)).toEqual([]);
    expect(await cache.listPending(created.project.id)).toEqual([]);
    expect(await cache.getProject(created.project.id)).toBeNull();
    await expect(services.listProjects()).rejects.toBeInstanceOf(ServiceError);
    // what was sent is still on the server: the project opens again on a signed-in device
    await services.signIn("ana@example.com", ACCOUNT);
    const open = await services.openProject(created.project.id, PASSWORD);
    expect(open.workspace.ledger.operations.size).toBe(3);
    await services.closeProject();
  }, 60_000);
});
