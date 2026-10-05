/**
 * The server's rules, independent of HTTP: the same rules as the in-memory reference
 * (`@opesvault/vault` MemoryBackend), checked by the same contract suite.
 *
 * Everything here handles ciphertext and opaque ids only. Errors are `BackendError` codes.
 */
import { createHmac, randomBytes } from "node:crypto";
import {
  BackendError,
  LEASE_MS,
  LIMITS,
  checkB64,
  checkEmail,
  checkEnvelope,
  checkHolder,
  checkId,
  checkLoginSecret,
  checkPullLimit,
  checkPushRecords,
  checkRevision,
  type AccountSession,
  type EditLease,
  type Envelope,
  type ProjectMember,
  type ProjectSummary,
  type PullResult,
  type PushResult,
} from "@opesvault/vault";
import type { BlobStore } from "./blob_store.ts";
import { hashLoginSecret, newToken, tokenHash, verifyLoginSecret } from "./passwords.ts";
import { RateLimiter } from "./rate_limit.ts";
import type { LeaseRow, Role, Storage } from "./storage.ts";

export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ServiceOptions {
  readonly storage: Storage;
  readonly blobs: BlobStore;
  readonly secret: Buffer;
  readonly now: () => number;
  readonly scryptN: number;
  readonly ipAttemptsPerMinute: number;
  readonly emailFailuresPer15Minutes: number;
}

export interface Me {
  readonly id: string;
  readonly email: string;
}

function leaseView(row: LeaseRow): EditLease {
  return {
    leaseId: row.leaseId,
    holder: row.holder,
    accountId: row.accountId,
    email: row.email,
    expiresAt: new Date(row.expiresAt).toISOString(),
  };
}

export class Service {
  readonly #storage: Storage;
  readonly #blobs: BlobStore;
  readonly #secret: Buffer;
  readonly #now: () => number;
  readonly #scryptN: number;
  readonly #ipLimiter: RateLimiter;
  readonly #emailLimiter: RateLimiter;

  constructor(options: ServiceOptions) {
    this.#storage = options.storage;
    this.#blobs = options.blobs;
    this.#secret = options.secret;
    this.#now = options.now;
    this.#scryptN = options.scryptN;
    this.#ipLimiter = new RateLimiter(options.ipAttemptsPerMinute, 60_000, options.now);
    this.#emailLimiter = new RateLimiter(options.emailFailuresPer15Minutes, 15 * 60_000, options.now);
  }

  now(): number {
    return this.#now();
  }

  // ------------------------------------------------------------------ accounts

  /** HMAC(server secret, email): stable, and the same answer whether or not the account exists. */
  loginSalt(email: unknown): string {
    const normalized = checkEmail(email);
    return createHmac("sha256", this.#secret)
      .update(`login-salt\n${normalized}`)
      .digest()
      .subarray(0, 16)
      .toString("base64url");
  }

  #limitIp(ip: string): void {
    if (!this.#ipLimiter.hit(ip)) throw new BackendError("rate_limited");
  }

  async #newSession(account: Me): Promise<{ session: AccountSession; token: string; expiresAt: number }> {
    const token = newToken();
    const expiresAt = this.#now() + SESSION_MS;
    await this.#storage.createSession(tokenHash(token), account.id, expiresAt);
    return { session: { accountId: account.id, email: account.email }, token, expiresAt };
  }

  async signUp(email: unknown, secret: unknown, ip: string) {
    this.#limitIp(ip);
    const normalized = checkEmail(email);
    const loginSecret = checkLoginSecret(secret);
    const { hash, salt } = await hashLoginSecret(loginSecret, this.#scryptN);
    const account = {
      id: randomBytes(16).toString("hex"),
      email: normalized,
      secretHash: hash,
      secretSalt: salt,
      createdAt: new Date(this.#now()).toISOString(),
    };
    if (!(await this.#storage.createAccount(account))) throw new BackendError("conflict");
    return this.#newSession(account);
  }

  async signIn(email: unknown, secret: unknown, ip: string) {
    this.#limitIp(ip);
    const normalized = checkEmail(email);
    const loginSecret = checkLoginSecret(secret);
    if (this.#emailLimiter.blocked(normalized)) throw new BackendError("rate_limited");
    const account = await this.#storage.accountByEmail(normalized);
    const stored = account === null ? null : { hash: account.secretHash, salt: account.secretSalt };
    const ok = await verifyLoginSecret(loginSecret, stored, this.#scryptN);
    if (!ok || account === null) {
      this.#emailLimiter.hit(normalized);
      throw new BackendError("unauthorized");
    }
    this.#emailLimiter.reset(normalized);
    return this.#newSession(account);
  }

  async signOut(token: string | undefined): Promise<void> {
    if (token) await this.#storage.deleteSession(tokenHash(token));
  }

  async sessionOf(token: string | undefined): Promise<Me | null> {
    if (!token || token.length > 100) return null;
    return this.#storage.sessionAccount(tokenHash(token), this.#now());
  }

  // ------------------------------------------------------------------ projects

  /** The caller's role; `forbidden` for non-members and missing projects alike. */
  async #member(me: Me, projectId: unknown): Promise<{ projectId: string; role: Role }> {
    const id = checkId(projectId);
    const role = await this.#storage.role(id, me.id);
    if (role === null) throw new BackendError("forbidden");
    return { projectId: id, role };
  }

  /** Checks membership before a request body is even read (same order as the reference backend). */
  async requireMember(me: Me, projectId: unknown): Promise<void> {
    await this.#member(me, projectId);
  }

  async listProjects(me: Me): Promise<ProjectSummary[]> {
    return (await this.#storage.projectsOf(me.id)).map((project) => ({
      projectId: project.id,
      sealedName: project.sealedName,
      createdAt: project.createdAt,
      revision: project.revision,
      role: project.role,
    }));
  }

  async createProject(me: Me, projectId: unknown, sealedName: unknown, envelope: unknown): Promise<ProjectSummary> {
    const id = checkId(projectId);
    const name = checkB64(sealedName, LIMITS.maxSealedName);
    const content = checkEnvelope(envelope);
    const createdAt = new Date(this.#now()).toISOString();
    const created = await this.#storage.createProject({ id, sealedName: name, createdAt, revision: 0 }, me.id, content);
    if (!created) throw new BackendError("conflict");
    return { projectId: id, sealedName: name, createdAt, revision: 0, role: "owner" };
  }

  async renameProject(me: Me, projectId: unknown, sealedName: unknown): Promise<void> {
    const { projectId: id } = await this.#member(me, projectId);
    await this.#storage.renameProject(id, checkB64(sealedName, LIMITS.maxSealedName));
  }

  async deleteProject(me: Me, projectId: unknown): Promise<void> {
    const { projectId: id, role } = await this.#member(me, projectId);
    if (role !== "owner") throw new BackendError("forbidden");
    await this.#storage.deleteProject(id);
    await this.#blobs.deleteProject(id);
  }

  async listMembers(me: Me, projectId: unknown): Promise<ProjectMember[]> {
    const { projectId: id } = await this.#member(me, projectId);
    return this.#storage.members(id);
  }

  async addMember(me: Me, projectId: unknown, email: unknown): Promise<ProjectMember> {
    const { projectId: id, role } = await this.#member(me, projectId);
    if (role !== "owner") throw new BackendError("forbidden");
    const account = await this.#storage.accountByEmail(checkEmail(email));
    if (account === null) throw new BackendError("not_found");
    const memberRole = await this.#storage.addMember(id, account.id);
    return { accountId: account.id, email: account.email, role: memberRole };
  }

  async removeMember(me: Me, projectId: unknown, accountId: unknown): Promise<void> {
    const { projectId: id, role } = await this.#member(me, projectId);
    if (typeof accountId !== "string") throw new BackendError("invalid");
    if (accountId !== me.id && role !== "owner") throw new BackendError("forbidden");
    const result = await this.#storage.removeMember(id, accountId);
    if (result === "not_member") throw new BackendError("not_found");
    if (result === "last_owner") throw new BackendError("conflict");
  }

  async getEnvelope(me: Me, projectId: unknown): Promise<Envelope> {
    const { projectId: id } = await this.#member(me, projectId);
    return this.#storage.envelope(id);
  }

  async putEnvelope(me: Me, projectId: unknown, envelope: unknown, expectedRevision: unknown): Promise<Envelope> {
    const { projectId: id } = await this.#member(me, projectId);
    const content = checkEnvelope(envelope);
    const expected = checkRevision(expectedRevision);
    const stored = await this.#storage.putEnvelope(id, content, expected);
    if (stored === null) throw new BackendError("conflict");
    return stored;
  }

  // ------------------------------------------------------------------ records

  async pull(me: Me, projectId: unknown, since: unknown, limit: unknown): Promise<PullResult> {
    const { projectId: id } = await this.#member(me, projectId);
    return this.#storage.pull(id, checkRevision(since), checkPullLimit(limit));
  }

  async push(me: Me, projectId: unknown, leaseId: unknown, records: unknown): Promise<PushResult> {
    const { projectId: id } = await this.#member(me, projectId);
    const checked = checkPushRecords(records);
    if (typeof leaseId !== "string") throw new BackendError("no_lease");
    const result = await this.#storage.push(id, leaseId, this.#now(), checked);
    if (result === "no_lease") throw new BackendError("no_lease");
    return result;
  }

  // ------------------------------------------------------------------ blobs

  async #checkLease(projectId: string, leaseId: unknown): Promise<void> {
    const lease = await this.#storage.activeLease(projectId, this.#now());
    if (typeof leaseId !== "string" || lease === null || lease.leaseId !== leaseId) {
      throw new BackendError("no_lease");
    }
  }

  async putBlob(me: Me, projectId: unknown, leaseId: unknown, blobId: unknown, data: Uint8Array): Promise<void> {
    const { projectId: id } = await this.#member(me, projectId);
    const blob = checkId(blobId);
    if (data.length > LIMITS.maxBlobBytes) throw new BackendError("too_large");
    await this.#checkLease(id, leaseId);
    await this.#blobs.put(id, blob, data);
  }

  async getBlob(me: Me, projectId: unknown, blobId: unknown): Promise<Uint8Array> {
    const { projectId: id } = await this.#member(me, projectId);
    const data = await this.#blobs.get(id, checkId(blobId));
    if (data === null) throw new BackendError("not_found");
    return data;
  }

  async deleteBlob(me: Me, projectId: unknown, leaseId: unknown, blobId: unknown): Promise<void> {
    const { projectId: id } = await this.#member(me, projectId);
    const blob = checkId(blobId);
    await this.#checkLease(id, leaseId);
    await this.#blobs.delete(id, blob);
  }

  // ------------------------------------------------------------------ edit lease

  async acquireLease(me: Me, projectId: unknown, holder: unknown, takeOver: unknown): Promise<EditLease> {
    const { projectId: id } = await this.#member(me, projectId);
    const label = checkHolder(holder);
    if (takeOver !== undefined && typeof takeOver !== "boolean") throw new BackendError("invalid");
    const now = this.#now();
    const result = await this.#storage.acquireLease(
      id,
      me.id,
      label,
      randomBytes(16).toString("hex"),
      now,
      now + LEASE_MS,
      takeOver === true,
    );
    if ("held" in result) throw new BackendError("lease_held");
    return leaseView(result.lease);
  }

  async renewLease(me: Me, projectId: unknown, leaseId: unknown): Promise<EditLease> {
    const { projectId: id } = await this.#member(me, projectId);
    if (typeof leaseId !== "string") throw new BackendError("no_lease");
    const now = this.#now();
    const lease = await this.#storage.renewLease(id, leaseId, now, now + LEASE_MS);
    if (lease === null) throw new BackendError("no_lease");
    return leaseView(lease);
  }

  async releaseLease(me: Me, projectId: unknown, leaseId: unknown): Promise<void> {
    const { projectId: id } = await this.#member(me, projectId);
    if (typeof leaseId === "string") await this.#storage.releaseLease(id, leaseId);
  }

  async currentLease(me: Me, projectId: unknown): Promise<EditLease | null> {
    const { projectId: id } = await this.#member(me, projectId);
    const lease = await this.#storage.activeLease(id, this.#now());
    return lease === null ? null : leaseView(lease);
  }

  async cleanup(): Promise<void> {
    await this.#storage.deleteExpired(this.#now());
  }
}
