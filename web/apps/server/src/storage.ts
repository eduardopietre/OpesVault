/**
 * What the server persists, behind an interface so that Postgres can come later (docs/18 §3.4).
 *
 * Each method is one atomic operation: an implementation runs it in a single transaction. Methods
 * receive validated input (the service checks it first) and never see plaintext: sealed names,
 * envelopes and records are opaque ciphertext.
 */
import type { Envelope, EnvelopeContent, PullResult, PushRecord, PushResult, SealedRecord } from "@opesvault/vault";

export type Role = "owner" | "member";

export interface AccountRow {
  readonly id: string;
  readonly email: string;
  readonly secretHash: Buffer;
  readonly secretSalt: Buffer;
  readonly createdAt: string;
}

export interface ProjectRow {
  readonly id: string;
  readonly sealedName: string;
  readonly createdAt: string;
  readonly revision: number;
}

export interface MemberRow {
  readonly accountId: string;
  readonly email: string;
  readonly role: Role;
}

export interface LeaseRow {
  readonly projectId: string;
  readonly leaseId: string;
  readonly holder: string;
  readonly accountId: string;
  readonly email: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
}

export type AcquireResult = { readonly lease: LeaseRow } | { readonly held: true };

export interface Storage {
  // accounts and sessions
  /** false if the email is taken. */
  createAccount(account: AccountRow): Promise<boolean>;
  accountByEmail(email: string): Promise<AccountRow | null>;
  createSession(tokenHash: string, accountId: string, expiresAt: number): Promise<void>;
  /** The session's account, if the session exists and has not expired. */
  sessionAccount(tokenHash: string, now: number): Promise<{ id: string; email: string } | null>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteExpired(now: number): Promise<void>;

  // projects and members
  /** false if the id is taken. The creator becomes the owner; the envelope gets revision 1. */
  createProject(project: ProjectRow, ownerId: string, envelope: EnvelopeContent): Promise<boolean>;
  projectsOf(accountId: string): Promise<(ProjectRow & { role: Role })[]>;
  role(projectId: string, accountId: string): Promise<Role | null>;
  renameProject(projectId: string, sealedName: string): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  members(projectId: string): Promise<MemberRow[]>;
  /** Adds the account as a member (keeps the current role if already in). */
  addMember(projectId: string, accountId: string): Promise<Role>;
  /** Removes a member and their lease; refuses to remove the last owner. */
  removeMember(projectId: string, accountId: string): Promise<"removed" | "not_member" | "last_owner">;

  // envelope
  envelope(projectId: string): Promise<Envelope>;
  /** null if the expected revision is stale. */
  putEnvelope(projectId: string, envelope: EnvelopeContent, expectedRevision: number): Promise<Envelope | null>;

  // records
  pull(projectId: string, since: number, limit: number): Promise<PullResult>;
  /** Checks the lease (`"no_lease"`), then base revisions, then writes everything at one new revision. */
  push(
    projectId: string,
    leaseId: string,
    now: number,
    records: readonly PushRecord[],
  ): Promise<PushResult | "no_lease">;

  // edit lease
  activeLease(projectId: string, now: number): Promise<LeaseRow | null>;
  /** A new lease unless someone else (another account or holder) holds an active one and not `takeOver`. */
  acquireLease(
    projectId: string,
    accountId: string,
    holder: string,
    leaseId: string,
    now: number,
    expiresAt: number,
    takeOver: boolean,
  ): Promise<AcquireResult>;
  /** null if `leaseId` is not the active lease. */
  renewLease(projectId: string, leaseId: string, now: number, expiresAt: number): Promise<LeaseRow | null>;
  releaseLease(projectId: string, leaseId: string): Promise<void>;

  close(): void;
}

export type { SealedRecord };
