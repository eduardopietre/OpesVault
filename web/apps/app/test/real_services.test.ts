/**
 * The real services end to end, without a browser: two devices with their own IndexedDB talk to the
 * in-memory reference server; the project is created, edited, encrypted, synced and read back.
 */
import "fake-indexeddb/auto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { AccountType, queries, type IsoDate } from "@opesvault/domain";
import { MemoryServer, VaultCache } from "@opesvault/vault";
import { describe, expect, it } from "vitest";
import { createRealServices } from "../src/services/real.ts";
import { ServiceError } from "../src/services/types.ts";

const KDF = { algorithm: "argon2id", memoryKiB: 8192, iterations: 1, parallelism: 1 } as const;

function device(server: MemoryServer, holder: string) {
  const factory = new IDBFactory();
  return createRealServices({
    backend: server.client(),
    openCache: () => VaultCache.open({ factory, keyRange: IDBKeyRange }),
    holder,
    kdf: KDF,
    idleLockMs: null,
    vaultOptions: { pushDelayMs: 0, pollMs: 50 },
  });
}

async function until(condition: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("real services", () => {
  it("creates, edits, syncs and opens a project on another device", async () => {
    const server = new MemoryServer();
    const a = device(server, "tab-a");
    await a.signUp({ name: "Ana Souza", email: "ana@example.com", password: "senha da conta" });
    const created = await a.createProject({ name: "Casa", password: "senha do projeto" });
    expect(created.recoveryKey.split("-").length).toBeGreaterThan(4);
    const open = await a.openProject(created.project.id, "senha do projeto");
    expect(open.members.map((m) => m.name)).toEqual(["Ana"]);
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
    ws.act((l) => l.recordExpense(bank.id, food, "123.45", "2026-01-05" as IsoDate, "Mercado"));
    expect(queries.balance(ws.ledger, bank.id).toFixed()).toBe("876.55");
    // Undo is one step per action, and the undo is synced too.
    ws.act((l) => l.recordExpense(bank.id, food, "1.00", "2026-01-06" as IsoDate, "Engano"));
    expect(ws.undo()).toBe("lançamento");
    await ws.settled();

    // A failing action leaves nothing behind.
    const before = ws.ledger.operations.size;
    expect(() => ws.act((l) => l.recordExpense(bank.id, food, "1.001", "2026-01-07" as IsoDate, "x"))).toThrow();
    expect(ws.ledger.operations.size).toBe(before);

    // The server only ever sees ciphertext.
    const dump = JSON.stringify(server);
    expect(dump).not.toContain("Mercado");
    expect(dump).not.toContain("Casa");

    // Same account on another device: wrong password first, then the right one, read-only.
    const b = device(server, "tab-b");
    await b.signIn("ana@example.com", "senha da conta");
    const listed = await b.listProjects();
    expect(listed.map((p) => p.id)).toEqual([created.project.id]);
    await expect(b.openProject(created.project.id, "errada")).rejects.toBeInstanceOf(ServiceError);
    await until(async () => {
      const other = await b.openProject(created.project.id, "senha do projeto");
      return other.workspace.ledger.operations.size === 2;
    });
    const other = await b.openProject(created.project.id, "senha do projeto");
    expect(other.project.name).toBe("Casa");
    expect(other.readOnly).toBe(true);
    expect(queries.balance(other.workspace.ledger, bank.id).toFixed()).toBe("876.55");
    expect([...other.workspace.ledger.operations.values()].some((o) => o.description === "Engano")).toBe(false);

    await a.closeProject();
    await b.closeProject();
  }, 30_000);
});
