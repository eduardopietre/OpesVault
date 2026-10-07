/**
 * docs/18 W1 exit criterion: scan everything written to IndexedDB and every request sent to the
 * backend, and find no plaintext (record contents, kinds and ids, project name, passwords,
 * recovery key, attachment contents).
 */
import { describe, expect, it } from "vitest";
import { MemoryServer, ProjectVault, signIn, signUp, type SyncBackend } from "../src/index.ts";
import { device, dumpIndexedDb, TEST_KDF } from "./helpers.ts";
import { untilAsync } from "./support.ts";

const SECRETS = {
  projectName: "Família Secreta Oliveira",
  projectPassword: "cavalo-correto-bateria-grampo",
  newProjectPassword: "outra-senha-muito-secreta",
  accountPassword: "senha-da-conta-que-nao-sai",
  description: "Supermercado Zé da Esquina",
  amount: "98765.43",
  member: "Joaquim Pereira",
  kind: "operation_kind_secret",
  recordId: "id-do-registro-secreto",
  attachment: "EXTRATO BANCARIO CONTA 0001-9",
};

function bytesAsText(value: Uint8Array): string {
  return Buffer.from(value).toString("latin1") + Buffer.from(value).toString("utf8");
}

/** Wraps a backend and records every argument of every call, as text. */
function recording(backend: SyncBackend): { backend: SyncBackend; log: string[] } {
  const log: string[] = [];
  const proxy = new Proxy(backend, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        log.push(
          `${String(property)} ${JSON.stringify(args, (_key, arg: unknown) =>
            arg instanceof Uint8Array ? bytesAsText(arg) : arg,
          )}`,
        );
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { backend: proxy, log };
}

describe("no plaintext leaves the tab", () => {
  it("IndexedDB and every backend request hold ciphertext only", async () => {
    const server = new MemoryServer();
    const { backend, log } = recording(server.client());
    const dev = await device(server, backend);
    await signUp(backend, "ana@example.com", SECRETS.accountPassword, TEST_KDF);
    await backend.signOut();
    await signIn(backend, "ana@example.com", SECRETS.accountPassword, TEST_KDF);
    const { vault, recoveryKey } = await ProjectVault.create({
      backend,
      cache: dev.cache,
      timers: dev.timers,
      kdf: TEST_KDF,
      name: SECRETS.projectName,
      password: SECRETS.projectPassword,
      // The device snapshot is written for this small project too, so it is scanned like the rest.
      deviceSnapshot: { minRecords: 1, stale: 1, delayMs: 10 },
    });
    await vault.stage([
      {
        kind: SECRETS.kind,
        id: SECRETS.recordId,
        payload: { description: SECRETS.description, amount: SECRETS.amount, member: SECRETS.member },
      },
      { kind: "member", id: "m1", payload: { name: SECRETS.member } },
    ]);
    await vault.syncNow();
    // Something left pending in IndexedDB too.
    server.offline = true;
    await vault.stage([{ kind: SECRETS.kind, id: "2", payload: { description: SECRETS.description } }]);
    await vault.syncNow();
    server.offline = false;
    await vault.syncNow();
    await dev.timers.advance(10);
    await untilAsync(async () => (await dev.cache.getSnapshot(vault.projectId)) !== null);
    expect(await dev.cache.getSnapshot(vault.projectId)).not.toBeNull();
    await vault.putBlob(new TextEncoder().encode(SECRETS.attachment));
    await vault.rename(`${SECRETS.projectName} 2`);
    await vault.changePassword(SECRETS.projectPassword, SECRETS.newProjectPassword);
    const newRecoveryKey = await vault.regenerateRecoveryKey(SECRETS.newProjectPassword);
    server.offline = true;
    await vault.stage([{ kind: SECRETS.kind, id: "3", payload: { description: SECRETS.description } }]);
    await vault.lock();
    server.offline = false;

    const stored = await dumpIndexedDb(dev.factory);
    const sent = log.join("\n");
    expect(stored).toContain("pending");
    expect(JSON.parse(stored).snapshots).toHaveLength(1);
    expect(sent).toContain("push");
    const forbidden = [
      ...Object.values(SECRETS),
      recoveryKey,
      recoveryKey.replace(/-/g, ""),
      newRecoveryKey,
      newRecoveryKey.replace(/-/g, ""),
      "Supermercado",
      "Oliveira",
      "description",
      "payload",
    ];
    for (const secret of forbidden) {
      expect(stored, `IndexedDB contains "${secret}"`).not.toContain(secret);
      expect(sent, `a request contains "${secret}"`).not.toContain(secret);
    }
    // The pending change made while offline is sealed in IndexedDB, not lost.
    expect(JSON.parse(stored).pending).toHaveLength(1);
  });
});
