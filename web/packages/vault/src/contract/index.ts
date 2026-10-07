/**
 * The `SyncBackend` contract suite (docs/18 §3.4): the same tests run against every adapter.
 * An adapter enters only when the whole suite passes.
 *
 * Usage, inside a Vitest test file:
 *
 *   runSyncBackendContract("MemoryBackend", async () => {
 *     const server = new MemoryServer();
 *     return { a: server.client(), b: server.client(), advanceTime: (ms) => server.advance(ms) };
 *   });
 *
 * `a` and `b` are two independent clients (two browsers, two people) of one fresh, empty server.
 * `advanceTime` moves the server's clock forward (lease expiry).
 */
import { randomId } from "@opesvault/crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BackendError,
  LEASE_MS,
  LIMITS,
  type B64,
  type BackendErrorCode,
  type EnvelopeContent,
  type PushRecord,
  type SyncBackend,
} from "../backend.ts";

export interface ContractEnv {
  readonly a: SyncBackend;
  readonly b: SyncBackend;
  advanceTime(ms: number): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function randomB64(chars: number): B64 {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(chars));
  let out = "";
  for (const byte of bytes) out += B64_ALPHABET[byte & 63]!;
  return out;
}

function envelope(): EnvelopeContent {
  return {
    version: 1,
    kdf: { algorithm: "argon2id", memoryKiB: 65536, iterations: 3, parallelism: 1, salt: randomB64(22) },
    wrappedByPassword: randomB64(82),
    recoverySalt: randomB64(22),
    wrappedByRecovery: randomB64(82),
  };
}

async function rejects(promise: Promise<unknown>, code: BackendErrorCode): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected BackendError(${code})`).toBeInstanceOf(BackendError);
  expect((caught as BackendError).code).toBe(code);
}

export function runSyncBackendContract(name: string, makeBackendPair: () => Promise<ContractEnv>): void {
  describe(`SyncBackend contract: ${name}`, () => {
    let env: ContractEnv;
    let a: SyncBackend;
    let b: SyncBackend;
    const secretA = randomB64(43);
    const secretB = randomB64(43);

    beforeEach(async () => {
      env = await makeBackendPair();
      a = env.a;
      b = env.b;
    });

    afterEach(async () => {
      await env.dispose?.();
    });

    async function twoAccounts(): Promise<void> {
      await a.signUp("ana@example.com", secretA);
      await b.signUp("bia@example.com", secretB);
    }

    async function project(owner: SyncBackend = a): Promise<string> {
      const id = randomId();
      await owner.createProject(id, randomB64(40), envelope());
      return id;
    }

    function record(base = 0, id = randomId()): PushRecord {
      return { id, baseRevision: base, ciphertext: randomB64(120) };
    }

    describe("accounts", () => {
      it("signs up, keeps the session and signs out", async () => {
        expect(await a.currentSession()).toBeNull();
        const session = await a.signUp("  Ana@Example.COM ", secretA);
        expect(session.email).toBe("ana@example.com");
        expect(typeof session.accountId).toBe("string");
        expect(await a.currentSession()).toEqual(session);
        await a.signOut();
        expect(await a.currentSession()).toBeNull();
        await rejects(a.listProjects(), "unauthorized");
        expect(await a.signIn("ana@example.com", secretA)).toEqual(session);
        expect(await a.currentSession()).toEqual(session);
      });

      it("refuses a duplicate email, whatever its case", async () => {
        await a.signUp("ana@example.com", secretA);
        await rejects(b.signUp("ANA@example.com", secretB), "conflict");
      });

      it("refuses a wrong secret and an unknown email alike", async () => {
        await a.signUp("ana@example.com", secretA);
        await a.signOut();
        await rejects(a.signIn("ana@example.com", secretB), "unauthorized");
        await rejects(a.signIn("ninguem@example.com", secretA), "unauthorized");
        expect(await a.currentSession()).toBeNull();
      });

      it("refuses malformed emails and secrets", async () => {
        await rejects(a.signUp("sem-arroba", secretA), "invalid");
        await rejects(a.signUp("ana@example.com", "not base64!"), "invalid");
        await rejects(a.signUp("ana@example.com", ""), "invalid");
      });

      it("gives a stable login salt, also for unknown emails", async () => {
        const unknown = await a.loginSalt("ninguem@example.com");
        expect(await b.loginSalt("Ninguem@Example.com")).toBe(unknown);
        expect(unknown).toMatch(/^[A-Za-z0-9_-]{22,}$/);
        expect(await a.loginSalt("outro@example.com")).not.toBe(unknown);
        const before = await a.loginSalt("ana@example.com");
        await a.signUp("ana@example.com", secretA);
        expect(await b.loginSalt("ana@example.com")).toBe(before);
      });

      it("ends only its own session", async () => {
        await twoAccounts();
        await a.signOut();
        expect((await b.currentSession())?.email).toBe("bia@example.com");
      });
    });

    describe("projects", () => {
      it("creates and lists a project for its owner only", async () => {
        await twoAccounts();
        const id = randomId();
        const sealed = randomB64(40);
        const summary = await a.createProject(id, sealed, envelope());
        expect(summary).toMatchObject({ projectId: id, sealedName: sealed, revision: 0, role: "owner" });
        expect(Number.isNaN(Date.parse(summary.createdAt))).toBe(false);
        expect(await a.listProjects()).toEqual([summary]);
        expect(await b.listProjects()).toEqual([]);
        await rejects(b.getEnvelope(id), "forbidden");
        await rejects(b.pull(id, 0), "forbidden");
        await rejects(b.listMembers(id), "forbidden");
      });

      it("refuses an existing or malformed id", async () => {
        await twoAccounts();
        const id = await project();
        await rejects(b.createProject(id, randomB64(40), envelope()), "conflict");
        await rejects(a.createProject("not-an-id", randomB64(40), envelope()), "invalid");
        await rejects(a.createProject(randomId().toUpperCase(), randomB64(40), envelope()), "invalid");
      });

      it("treats a missing and a foreign project the same way", async () => {
        await twoAccounts();
        await rejects(b.getEnvelope(randomId()), "forbidden");
      });

      it("renames for any member", async () => {
        await twoAccounts();
        const id = await project();
        await a.addMember(id, "bia@example.com");
        const sealed = randomB64(50);
        await b.renameProject(id, sealed);
        expect((await a.listProjects())[0]!.sealedName).toBe(sealed);
        await rejects(a.renameProject(id, "x".repeat(LIMITS.maxSealedName + 1)), "too_large");
      });

      it("deletes for the owner only, with everything in it", async () => {
        await twoAccounts();
        const id = await project();
        await a.addMember(id, "bia@example.com");
        await rejects(b.deleteProject(id), "forbidden");
        await a.deleteProject(id);
        expect(await a.listProjects()).toEqual([]);
        expect(await b.listProjects()).toEqual([]);
        await rejects(a.getEnvelope(id), "forbidden");
      });

      it("needs a session", async () => {
        await rejects(a.listProjects(), "unauthorized");
        await rejects(a.createProject(randomId(), randomB64(40), envelope()), "unauthorized");
      });
    });

    describe("members", () => {
      it("the owner adds a member by email and the member reaches the project", async () => {
        await twoAccounts();
        const id = await project();
        const member = await a.addMember(id, " BIA@example.com");
        expect(member).toMatchObject({ email: "bia@example.com", role: "member" });
        expect((await b.listProjects()).map((p) => [p.projectId, p.role])).toEqual([[id, "member"]]);
        expect((await b.getEnvelope(id)).revision).toBe(1);
        const members = await b.listMembers(id);
        expect(members.map((m) => [m.email, m.role])).toEqual([
          ["ana@example.com", "owner"],
          ["bia@example.com", "member"],
        ]);
      });

      it("adding an unknown email is not_found", async () => {
        await twoAccounts();
        const id = await project();
        await rejects(a.addMember(id, "ninguem@example.com"), "not_found");
      });

      it("a member cannot add or remove others", async () => {
        await twoAccounts();
        const id = await project();
        const owner = (await a.currentSession())!;
        await a.addMember(id, "bia@example.com");
        await rejects(b.addMember(id, "ana@example.com"), "forbidden");
        await rejects(b.removeMember(id, owner.accountId), "forbidden");
      });

      it("the last owner cannot be removed", async () => {
        await twoAccounts();
        const id = await project();
        const owner = (await a.currentSession())!;
        await rejects(a.removeMember(id, owner.accountId), "conflict");
      });

      it("a removed member loses access; a member may leave", async () => {
        await twoAccounts();
        const id = await project();
        const bia = (await b.currentSession())!;
        await a.addMember(id, "bia@example.com");
        await a.removeMember(id, bia.accountId);
        await rejects(b.getEnvelope(id), "forbidden");
        expect(await b.listProjects()).toEqual([]);
        await a.addMember(id, "bia@example.com");
        await b.removeMember(id, bia.accountId);
        await rejects(b.pull(id, 0), "forbidden");
        expect((await a.listMembers(id)).length).toBe(1);
      });
    });

    describe("envelope", () => {
      it("gets and replaces it with the expected revision", async () => {
        await twoAccounts();
        const id = randomId();
        const first = envelope();
        await a.createProject(id, randomB64(40), first);
        expect(await a.getEnvelope(id)).toEqual({ ...first, revision: 1 });
        const second = envelope();
        expect(await a.putEnvelope(id, second, 1)).toEqual({ ...second, revision: 2 });
        expect(await a.getEnvelope(id)).toEqual({ ...second, revision: 2 });
      });

      it("refuses a stale revision", async () => {
        await twoAccounts();
        const id = await project();
        await a.putEnvelope(id, envelope(), 1);
        await rejects(a.putEnvelope(id, envelope(), 1), "conflict");
        expect((await a.getEnvelope(id)).revision).toBe(2);
      });

      it("refuses malformed envelopes and non-members", async () => {
        await twoAccounts();
        const id = await project();
        await rejects(a.putEnvelope(id, { ...envelope(), wrappedByPassword: "no spaces allowed" }, 1), "invalid");
        await rejects(a.putEnvelope(id, { ...envelope(), recoverySalt: null }, 1), "invalid");
        await rejects(b.putEnvelope(id, envelope(), 1), "forbidden");
      });
    });

    describe("records", () => {
      it("needs the current edit lease to push", async () => {
        await twoAccounts();
        const id = await project();
        await rejects(a.push(id, randomId(), [record()]), "no_lease");
        const lease = await a.acquireEditLease(id, "tab-a");
        await rejects(a.push(id, randomId(), [record()]), "no_lease");
        expect((await a.push(id, lease.leaseId, [record()])).ok).toBe(true);
      });

      it("writes every record of a push at one new revision, monotonically", async () => {
        await twoAccounts();
        const id = await project();
        const { leaseId } = await a.acquireEditLease(id, "tab-a");
        const first = [record(), record()];
        expect(await a.push(id, leaseId, first)).toEqual({ ok: true, revision: 1, conflicts: [] });
        const second = [record(1, first[0]!.id)];
        expect(await a.push(id, leaseId, second)).toEqual({ ok: true, revision: 2, conflicts: [] });
        const pulled = await a.pull(id, 0);
        expect(pulled.revision).toBe(2);
        expect(pulled.more).toBe(false);
        expect(pulled.records).toHaveLength(2);
        const byId = new Map(pulled.records.map((r) => [r.id, r]));
        expect(byId.get(first[0]!.id)).toEqual({ id: first[0]!.id, revision: 2, ciphertext: second[0]!.ciphertext });
        expect(byId.get(first[1]!.id)).toEqual({ id: first[1]!.id, revision: 1, ciphertext: first[1]!.ciphertext });
        expect((await a.pull(id, 1)).records.map((r) => r.id)).toEqual([first[0]!.id]);
        expect(await a.pull(id, 2)).toEqual({ revision: 2, records: [], more: false });
        expect((await a.listProjects())[0]!.revision).toBe(2);
      });

      it("is all or nothing: one stale base revision rejects the whole push", async () => {
        await twoAccounts();
        const id = await project();
        const { leaseId } = await a.acquireEditLease(id, "tab-a");
        const existing = record();
        await a.push(id, leaseId, [existing]);
        const fresh = record();
        const stale = { ...record(0, existing.id) };
        const result = await a.push(id, leaseId, [fresh, stale]);
        expect(result).toEqual({ ok: false, revision: 1, conflicts: [existing.id] });
        const pulled = await a.pull(id, 0);
        expect(pulled.records.map((r) => r.id)).toEqual([existing.id]);
        expect(pulled.records[0]!.ciphertext).toBe(existing.ciphertext);
        // A base revision from the future is a conflict too.
        expect((await a.push(id, leaseId, [record(5, existing.id)])).conflicts).toEqual([existing.id]);
        expect((await a.push(id, leaseId, [record(3)])).ok).toBe(false);
      });

      it("keeps tombstones for deletes", async () => {
        await twoAccounts();
        const id = await project();
        const { leaseId } = await a.acquireEditLease(id, "tab-a");
        const created = record();
        await a.push(id, leaseId, [created]);
        await a.push(id, leaseId, [{ id: created.id, baseRevision: 1, ciphertext: null }]);
        expect((await a.pull(id, 0)).records).toEqual([{ id: created.id, revision: 2, ciphertext: null }]);
        expect((await a.pull(id, 1)).records).toEqual([{ id: created.id, revision: 2, ciphertext: null }]);
        // A deleted record can come back, based on its tombstone's revision.
        expect((await a.push(id, leaseId, [record(2, created.id)])).ok).toBe(true);
      });

      it("pages a pull without splitting a push", async () => {
        await twoAccounts();
        const id = await project();
        const { leaseId } = await a.acquireEditLease(id, "tab-a");
        for (let i = 0; i < 3; i++) await a.push(id, leaseId, [record(), record(), record(), record()]);
        const exact = await a.pull(id, 0, 4);
        expect(exact.records.every((r) => r.revision === 1)).toBe(true);
        expect(exact).toMatchObject({ revision: 1, more: true });
        expect(exact.records).toHaveLength(4);
        const extended = await a.pull(id, 0, 5);
        expect(extended.records).toHaveLength(8);
        expect(extended).toMatchObject({ revision: 2, more: true });
        const ids = extended.records.map((r) => r.id);
        expect(ids.slice(0, 4)).toEqual([...ids.slice(0, 4)].sort());
        const rest = await a.pull(id, extended.revision, 5);
        expect(rest.records).toHaveLength(4);
        expect(rest).toMatchObject({ revision: 3, more: false });
        let since = 0;
        let seen = 0;
        for (;;) {
          const page = await a.pull(id, since, 1);
          seen += page.records.length;
          since = page.revision;
          if (!page.more) break;
        }
        expect(seen).toBe(12);
        expect(since).toBe(3);
      });

      it("lets members read and refuses everyone else", async () => {
        await twoAccounts();
        const id = await project();
        const { leaseId } = await a.acquireEditLease(id, "tab-a");
        await rejects(b.pull(id, 0), "forbidden");
        await rejects(b.push(id, leaseId, [record()]), "forbidden");
        await a.push(id, leaseId, [record()]);
        await a.addMember(id, "bia@example.com");
        expect((await b.pull(id, 0)).records).toHaveLength(1);
        // A member without the lease cannot write, even knowing its id.
        await rejects(b.push(id, randomId(), [record()]), "no_lease");
      });

      it("enforces size limits and refuses malformed pushes", async () => {
        await twoAccounts();
        const id = await project();
        const { leaseId } = await a.acquireEditLease(id, "tab-a");
        const big = { id: randomId(), baseRevision: 0, ciphertext: "A".repeat(LIMITS.maxRecordCiphertext + 1) };
        await rejects(a.push(id, leaseId, [big]), "too_large");
        const many = Array.from({ length: LIMITS.maxPushRecords + 1 }, () => record());
        await rejects(a.push(id, leaseId, many), "too_large");
        const twice = record();
        await rejects(a.push(id, leaseId, [twice, twice]), "invalid");
        await rejects(a.push(id, leaseId, []), "invalid");
        await rejects(a.push(id, leaseId, [{ id: "x", baseRevision: 0, ciphertext: "AAAA" }]), "invalid");
        await rejects(a.push(id, leaseId, [{ id: randomId(), baseRevision: -1, ciphertext: "AAAA" }]), "invalid");
        expect((await a.pull(id, 0)).records).toEqual([]);
      });
    });

    describe("blobs", () => {
      it("puts, gets and deletes ciphertext bytes", async () => {
        await twoAccounts();
        const id = await project();
        const { leaseId } = await a.acquireEditLease(id, "tab-a");
        const blobId = randomId();
        const data = new Uint8Array(70_000).map((_, i) => (i * 31) & 255);
        await a.putBlob(id, leaseId, blobId, data);
        expect(Array.from(await a.getBlob(id, blobId))).toEqual(Array.from(data));
        const replacement = new Uint8Array([1, 2, 3]);
        await a.putBlob(id, leaseId, blobId, replacement);
        expect(Array.from(await a.getBlob(id, blobId))).toEqual([1, 2, 3]);
        await a.deleteBlob(id, leaseId, blobId);
        await rejects(a.getBlob(id, blobId), "not_found");
        await rejects(a.getBlob(id, randomId()), "not_found");
        await rejects(a.getBlob(id, "../../etc/passwd"), "invalid");
      });

      it("refuses non-members and writes without the lease", async () => {
        await twoAccounts();
        const id = await project();
        const { leaseId } = await a.acquireEditLease(id, "tab-a");
        const blobId = randomId();
        await a.putBlob(id, leaseId, blobId, new Uint8Array([9]));
        await rejects(b.getBlob(id, blobId), "forbidden");
        await rejects(b.putBlob(id, leaseId, randomId(), new Uint8Array([1])), "forbidden");
        await rejects(b.deleteBlob(id, leaseId, blobId), "forbidden");
        await rejects(a.putBlob(id, randomId(), randomId(), new Uint8Array([1])), "no_lease");
        await rejects(a.deleteBlob(id, randomId(), blobId), "no_lease");
        await a.addMember(id, "bia@example.com");
        expect(Array.from(await b.getBlob(id, blobId))).toEqual([9]);
      });

      it("refuses blobs over the size limit", async () => {
        await twoAccounts();
        const id = await project();
        const { leaseId } = await a.acquireEditLease(id, "tab-a");
        await rejects(a.putBlob(id, leaseId, randomId(), new Uint8Array(LIMITS.maxBlobBytes + 1)), "too_large");
      });

      it("deleting the project deletes its blobs", async () => {
        await twoAccounts();
        const id = await project();
        const { leaseId } = await a.acquireEditLease(id, "tab-a");
        const blobId = randomId();
        await a.putBlob(id, leaseId, blobId, new Uint8Array([1]));
        await a.deleteProject(id);
        await rejects(a.getBlob(id, blobId), "forbidden");
      });
    });

    describe("edit lease", () => {
      it("one holder at a time; the other sees who holds it", async () => {
        await twoAccounts();
        const id = await project();
        await a.addMember(id, "bia@example.com");
        expect(await a.currentLease(id)).toBeNull();
        const lease = await a.acquireEditLease(id, "tab-a");
        expect(lease).toMatchObject({ holder: "tab-a", email: "ana@example.com" });
        expect(Date.parse(lease.expiresAt)).toBeGreaterThan(Date.now() - 1000);
        expect(await b.currentLease(id)).toEqual(lease);
        await rejects(b.acquireEditLease(id, "tab-b"), "lease_held");
        // The same account in another tab is another holder too.
        await rejects(a.acquireEditLease(id, "tab-a2"), "lease_held");
        // The same tab (same account, same holder) after a reload gets a new lease at once.
        const again = await a.acquireEditLease(id, "tab-a");
        expect(again.leaseId).not.toBe(lease.leaseId);
        await rejects(a.push(id, lease.leaseId, [record()]), "no_lease");
        // Another account cannot use someone else's holder label to get in.
        await rejects(b.acquireEditLease(id, "tab-a"), "lease_held");
      });

      it("takeover moves the lease and the old holder's writes are rejected", async () => {
        await twoAccounts();
        const id = await project();
        await a.addMember(id, "bia@example.com");
        const old = await a.acquireEditLease(id, "tab-a");
        const taken = await b.acquireEditLease(id, "tab-b", true);
        expect(taken.leaseId).not.toBe(old.leaseId);
        expect((await a.currentLease(id))?.email).toBe("bia@example.com");
        await rejects(a.push(id, old.leaseId, [record()]), "no_lease");
        await rejects(a.renewEditLease(id, old.leaseId), "no_lease");
        await rejects(a.putBlob(id, old.leaseId, randomId(), new Uint8Array([1])), "no_lease");
        // Releasing a lease that is no longer current changes nothing.
        await a.releaseEditLease(id, old.leaseId);
        expect((await a.currentLease(id))?.leaseId).toBe(taken.leaseId);
        expect((await b.push(id, taken.leaseId, [record()])).ok).toBe(true);
      });

      it("renews and releases", async () => {
        await twoAccounts();
        const id = await project();
        const lease = await a.acquireEditLease(id, "tab-a");
        await env.advanceTime(LEASE_MS / 2);
        const renewed = await a.renewEditLease(id, lease.leaseId);
        expect(renewed.leaseId).toBe(lease.leaseId);
        expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(lease.expiresAt));
        await env.advanceTime(LEASE_MS * 0.75);
        expect((await a.currentLease(id))?.leaseId).toBe(lease.leaseId);
        await a.releaseEditLease(id, lease.leaseId);
        expect(await a.currentLease(id)).toBeNull();
        await rejects(a.push(id, lease.leaseId, [record()]), "no_lease");
        await rejects(a.renewEditLease(id, lease.leaseId), "no_lease");
      });

      it("expires without renewal and can then be acquired by someone else", async () => {
        await twoAccounts();
        const id = await project();
        await a.addMember(id, "bia@example.com");
        const lease = await a.acquireEditLease(id, "tab-a");
        await env.advanceTime(LEASE_MS + 1000);
        expect(await a.currentLease(id)).toBeNull();
        await rejects(a.renewEditLease(id, lease.leaseId), "no_lease");
        await rejects(a.push(id, lease.leaseId, [record()]), "no_lease");
        const next = await b.acquireEditLease(id, "tab-b");
        expect(next.email).toBe("bia@example.com");
      });

      it("refuses malformed holders and non-members", async () => {
        await twoAccounts();
        const id = await project();
        await rejects(a.acquireEditLease(id, "has space"), "invalid");
        await rejects(a.acquireEditLease(id, ""), "invalid");
        await rejects(b.acquireEditLease(id, "tab-b"), "forbidden");
        await rejects(b.currentLease(id), "forbidden");
      });

      it("a removed member's lease ends with their access", async () => {
        await twoAccounts();
        const id = await project();
        const bia = (await b.currentSession())!;
        await a.addMember(id, "bia@example.com");
        await b.acquireEditLease(id, "tab-b");
        await a.removeMember(id, bia.accountId);
        expect(await a.currentLease(id)).toBeNull();
        await a.acquireEditLease(id, "tab-a");
      });
    });
  });
}
