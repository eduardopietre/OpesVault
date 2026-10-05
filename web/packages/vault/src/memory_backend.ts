/**
 * `SyncBackend` fully in memory: the reference for the contract suite and the backend of app tests.
 *
 * A `MemoryServer` holds the state; each `server.client()` is one browser with its own session,
 * so tests can sign in two people at once. Time is injectable to test lease expiry.
 */
import { equalBytes, importHmacKey, hmac, randomId, toB64, utf8 } from "@opesvault/crypto";
import {
  BackendError,
  LEASE_MS,
  LIMITS,
  type AccountSession,
  type B64,
  type EditLease,
  type Envelope,
  type EnvelopeContent,
  type ProjectMember,
  type ProjectSummary,
  type PullResult,
  type PushRecord,
  type PushResult,
  type SealedRecord,
  type SyncBackend,
} from "./backend.ts";
import {
  checkB64,
  checkEmail,
  checkEnvelope,
  checkHolder,
  checkId,
  checkLoginSecret,
  checkPullLimit,
  checkPushRecords,
  checkRevision,
  invalid,
} from "./validation.ts";

interface Account {
  readonly id: string;
  readonly email: string;
  readonly secret: Uint8Array;
}

interface Lease {
  readonly leaseId: string;
  readonly holder: string;
  readonly accountId: string;
  expiresAt: number;
}

interface Project {
  readonly id: string;
  sealedName: B64;
  readonly createdAt: string;
  revision: number;
  envelope: Envelope;
  readonly members: Map<string, "owner" | "member">;
  readonly records: Map<string, SealedRecord>;
  readonly blobs: Map<string, Uint8Array>;
  lease: Lease | null;
}

export interface MemoryServerOptions {
  /** Milliseconds since the epoch; defaults to `Date.now`. */
  readonly now?: () => number;
}

export class MemoryServer {
  readonly #now: () => number;
  readonly #accounts = new Map<string, Account>();
  readonly #accountsByEmail = new Map<string, Account>();
  readonly #projects = new Map<string, Project>();
  readonly #saltKey: Promise<CryptoKey>;
  #offset = 0;
  /** When true every client call fails with `offline`, as if the network were down. */
  offline = false;

  constructor(options: MemoryServerOptions = {}) {
    const base = options.now ?? Date.now;
    this.#now = () => base() + this.#offset;
    this.#saltKey = importHmacKey(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  }

  /** Moves this server's clock forward (lease expiry tests). */
  advance(ms: number): void {
    this.#offset += ms;
  }

  client(): MemoryBackend {
    return new MemoryBackend(this);
  }

  // The methods below are called by MemoryBackend only.

  now(): number {
    return this.#now();
  }

  async loginSalt(email: string): Promise<B64> {
    const mac = await hmac(await this.#saltKey, utf8(`login-salt\n${email}`));
    return toB64(mac.subarray(0, 16));
  }

  signUp(email: string, secret: Uint8Array): Account {
    if (this.#accountsByEmail.has(email)) throw new BackendError("conflict");
    const account = { id: randomId(), email, secret: secret.slice() };
    this.#accounts.set(account.id, account);
    this.#accountsByEmail.set(email, account);
    return account;
  }

  signIn(email: string, secret: Uint8Array): Account {
    const account = this.#accountsByEmail.get(email);
    const ok = account !== undefined && equalBytes(account.secret, secret);
    if (!ok) throw new BackendError("unauthorized");
    return account;
  }

  account(id: string): Account | undefined {
    return this.#accounts.get(id);
  }

  accountByEmail(email: string): Account | undefined {
    return this.#accountsByEmail.get(email);
  }

  projectsOf(accountId: string): Project[] {
    return [...this.#projects.values()].filter((project) => project.members.has(accountId));
  }

  /** The project if `accountId` is a member; `forbidden` otherwise (missing and foreign look the same). */
  project(accountId: string, projectId: unknown): Project {
    const project = this.#projects.get(checkId(projectId));
    if (!project?.members.has(accountId)) throw new BackendError("forbidden");
    return project;
  }

  createProject(accountId: string, projectId: string, sealedName: B64, envelope: EnvelopeContent): Project {
    if (this.#projects.has(projectId)) throw new BackendError("conflict");
    const project: Project = {
      id: projectId,
      sealedName,
      createdAt: new Date(this.now()).toISOString(),
      revision: 0,
      envelope: { ...envelope, revision: 1 },
      members: new Map([[accountId, "owner"]]),
      records: new Map(),
      blobs: new Map(),
      lease: null,
    };
    this.#projects.set(projectId, project);
    return project;
  }

  deleteProject(projectId: string): void {
    this.#projects.delete(projectId);
  }

  activeLease(project: Project): Lease | null {
    return project.lease !== null && project.lease.expiresAt > this.now() ? project.lease : null;
  }

  checkLease(project: Project, leaseId: unknown): void {
    const lease = this.activeLease(project);
    if (typeof leaseId !== "string" || lease === null || lease.leaseId !== leaseId) {
      throw new BackendError("no_lease");
    }
  }

  leaseView(lease: Lease): EditLease {
    return {
      leaseId: lease.leaseId,
      holder: lease.holder,
      accountId: lease.accountId,
      email: this.#accounts.get(lease.accountId)?.email ?? "",
      expiresAt: new Date(lease.expiresAt).toISOString(),
    };
  }
}

function secretBytes(secret: unknown): Uint8Array {
  return utf8(checkLoginSecret(secret));
}

export class MemoryBackend implements SyncBackend {
  readonly #server: MemoryServer;
  #accountId: string | null = null;

  constructor(server: MemoryServer) {
    this.#server = server;
  }

  /** Every call goes through here: simulated network, then the account check. */
  async #call<T>(fn: () => T | Promise<T>): Promise<T> {
    await Promise.resolve();
    if (this.#server.offline) throw new BackendError("offline");
    return fn();
  }

  #account(): string {
    if (this.#accountId === null || this.#server.account(this.#accountId) === undefined) {
      throw new BackendError("unauthorized");
    }
    return this.#accountId;
  }

  #session(account: { id: string; email: string }): AccountSession {
    return { accountId: account.id, email: account.email };
  }

  signUp(email: string, loginSecret: B64): Promise<AccountSession> {
    return this.#call(() => {
      const account = this.#server.signUp(checkEmail(email), secretBytes(loginSecret));
      this.#accountId = account.id;
      return this.#session(account);
    });
  }

  signIn(email: string, loginSecret: B64): Promise<AccountSession> {
    return this.#call(() => {
      const account = this.#server.signIn(checkEmail(email), secretBytes(loginSecret));
      this.#accountId = account.id;
      return this.#session(account);
    });
  }

  signOut(): Promise<void> {
    return this.#call(() => {
      this.#accountId = null;
    });
  }

  currentSession(): Promise<AccountSession | null> {
    return this.#call(() => {
      const account = this.#accountId === null ? undefined : this.#server.account(this.#accountId);
      return account === undefined ? null : this.#session(account);
    });
  }

  loginSalt(email: string): Promise<B64> {
    return this.#call(() => this.#server.loginSalt(checkEmail(email)));
  }

  #summary(project: { id: string; sealedName: B64; createdAt: string; revision: number }, role: "owner" | "member") {
    return {
      projectId: project.id,
      sealedName: project.sealedName,
      createdAt: project.createdAt,
      revision: project.revision,
      role,
    } satisfies ProjectSummary;
  }

  listProjects(): Promise<readonly ProjectSummary[]> {
    return this.#call(() => {
      const me = this.#account();
      return this.#server
        .projectsOf(me)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
        .map((project) => this.#summary(project, project.members.get(me)!));
    });
  }

  createProject(projectId: string, sealedName: B64, envelope: EnvelopeContent): Promise<ProjectSummary> {
    return this.#call(() => {
      const me = this.#account();
      const project = this.#server.createProject(
        me,
        checkId(projectId),
        checkB64(sealedName, LIMITS.maxSealedName),
        checkEnvelope(envelope),
      );
      return this.#summary(project, "owner");
    });
  }

  renameProject(projectId: string, sealedName: B64): Promise<void> {
    return this.#call(() => {
      const project = this.#server.project(this.#account(), projectId);
      project.sealedName = checkB64(sealedName, LIMITS.maxSealedName);
    });
  }

  deleteProject(projectId: string): Promise<void> {
    return this.#call(() => {
      const me = this.#account();
      const project = this.#server.project(me, projectId);
      if (project.members.get(me) !== "owner") throw new BackendError("forbidden");
      this.#server.deleteProject(project.id);
    });
  }

  listMembers(projectId: string): Promise<readonly ProjectMember[]> {
    return this.#call(() => {
      const project = this.#server.project(this.#account(), projectId);
      return [...project.members.entries()]
        .map(([accountId, role]) => ({ accountId, email: this.#server.account(accountId)?.email ?? "", role }))
        .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
    });
  }

  addMember(projectId: string, email: string): Promise<ProjectMember> {
    return this.#call(() => {
      const me = this.#account();
      const project = this.#server.project(me, projectId);
      if (project.members.get(me) !== "owner") throw new BackendError("forbidden");
      const account = this.#server.accountByEmail(checkEmail(email));
      if (account === undefined) throw new BackendError("not_found");
      const role = project.members.get(account.id) ?? "member";
      project.members.set(account.id, role);
      return { accountId: account.id, email: account.email, role };
    });
  }

  removeMember(projectId: string, accountId: string): Promise<void> {
    return this.#call(() => {
      const me = this.#account();
      const project = this.#server.project(me, projectId);
      if (typeof accountId !== "string") invalid();
      if (accountId !== me && project.members.get(me) !== "owner") throw new BackendError("forbidden");
      const role = project.members.get(accountId);
      if (role === undefined) throw new BackendError("not_found");
      const owners = [...project.members.values()].filter((value) => value === "owner").length;
      if (role === "owner" && owners === 1) throw new BackendError("conflict");
      project.members.delete(accountId);
      if (project.lease?.accountId === accountId) project.lease = null;
    });
  }

  getEnvelope(projectId: string): Promise<Envelope> {
    return this.#call(() => this.#server.project(this.#account(), projectId).envelope);
  }

  putEnvelope(projectId: string, envelope: EnvelopeContent, expectedRevision: number): Promise<Envelope> {
    return this.#call(() => {
      const project = this.#server.project(this.#account(), projectId);
      const checked = checkEnvelope(envelope);
      if (checkRevision(expectedRevision) !== project.envelope.revision) throw new BackendError("conflict");
      project.envelope = { ...checked, revision: project.envelope.revision + 1 };
      return project.envelope;
    });
  }

  pull(projectId: string, sinceRevision: number, limit: number = LIMITS.defaultPullLimit): Promise<PullResult> {
    return this.#call(() => {
      const project = this.#server.project(this.#account(), projectId);
      const since = checkRevision(sinceRevision);
      const max = checkPullLimit(limit);
      const newer = [...project.records.values()]
        .filter((record) => record.revision > since)
        .sort((a, b) => a.revision - b.revision || (a.id < b.id ? -1 : 1));
      if (newer.length <= max) return { revision: project.revision, records: newer, more: false };
      // Never split one revision: extend the page to the end of the last revision taken.
      let end = max;
      const lastRevision = newer[max - 1]!.revision;
      while (end < newer.length && newer[end]!.revision === lastRevision) end += 1;
      const records = newer.slice(0, end);
      const more = end < newer.length;
      return { revision: more ? lastRevision : project.revision, records, more };
    });
  }

  push(projectId: string, leaseId: string, records: readonly PushRecord[]): Promise<PushResult> {
    return this.#call(() => {
      const project = this.#server.project(this.#account(), projectId);
      const checked = checkPushRecords(records);
      this.#server.checkLease(project, leaseId);
      const conflicts = checked
        .filter((record) => (project.records.get(record.id)?.revision ?? 0) !== record.baseRevision)
        .map((record) => record.id);
      if (conflicts.length > 0) return { ok: false, revision: project.revision, conflicts };
      const revision = project.revision + 1;
      for (const record of checked) {
        project.records.set(record.id, { id: record.id, revision, ciphertext: record.ciphertext });
      }
      project.revision = revision;
      return { ok: true, revision, conflicts: [] };
    });
  }

  putBlob(projectId: string, leaseId: string, blobId: string, data: Uint8Array): Promise<void> {
    return this.#call(() => {
      const project = this.#server.project(this.#account(), projectId);
      checkId(blobId);
      if (!(data instanceof Uint8Array)) invalid();
      if (data.length > LIMITS.maxBlobBytes) throw new BackendError("too_large");
      this.#server.checkLease(project, leaseId);
      project.blobs.set(blobId, data.slice());
    });
  }

  getBlob(projectId: string, blobId: string): Promise<Uint8Array> {
    return this.#call(() => {
      const project = this.#server.project(this.#account(), projectId);
      const data = project.blobs.get(checkId(blobId));
      if (data === undefined) throw new BackendError("not_found");
      return data.slice();
    });
  }

  deleteBlob(projectId: string, leaseId: string, blobId: string): Promise<void> {
    return this.#call(() => {
      const project = this.#server.project(this.#account(), projectId);
      checkId(blobId);
      this.#server.checkLease(project, leaseId);
      project.blobs.delete(blobId);
    });
  }

  acquireEditLease(projectId: string, holder: string, takeOver = false): Promise<EditLease> {
    return this.#call(() => {
      const me = this.#account();
      const project = this.#server.project(me, projectId);
      checkHolder(holder);
      const current = this.#server.activeLease(project);
      const same = current !== null && current.accountId === me && current.holder === holder;
      if (current !== null && !takeOver && !same) throw new BackendError("lease_held");
      project.lease = { leaseId: randomId(), holder, accountId: me, expiresAt: this.#server.now() + LEASE_MS };
      return this.#server.leaseView(project.lease);
    });
  }

  renewEditLease(projectId: string, leaseId: string): Promise<EditLease> {
    return this.#call(() => {
      const project = this.#server.project(this.#account(), projectId);
      this.#server.checkLease(project, leaseId);
      project.lease!.expiresAt = this.#server.now() + LEASE_MS;
      return this.#server.leaseView(project.lease!);
    });
  }

  releaseEditLease(projectId: string, leaseId: string): Promise<void> {
    return this.#call(() => {
      const project = this.#server.project(this.#account(), projectId);
      if (project.lease?.leaseId === leaseId) project.lease = null;
    });
  }

  currentLease(projectId: string): Promise<EditLease | null> {
    return this.#call(() => {
      const project = this.#server.project(this.#account(), projectId);
      const lease = this.#server.activeLease(project);
      return lease === null ? null : this.#server.leaseView(lease);
    });
  }
}
