/**
 * `Storage` on SQLite through `node:sqlite` (built into Node 22, no native dependency).
 *
 * node:sqlite is synchronous, so each method runs its whole transaction without yielding: no
 * other request can interleave inside it. WAL journal with synchronous=FULL: an acknowledged
 * write survives a crash or power loss.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Envelope, EnvelopeContent, PullResult, PushRecord, PushResult, SealedRecord } from "@opesvault/vault";
import type { AccountRow, AcquireResult, LeaseRow, MemberRow, ProjectRow, Role, Storage } from "./storage.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  secret_hash BLOB NOT NULL,
  secret_salt BLOB NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  sealed_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  envelope TEXT NOT NULL,
  envelope_revision INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (project_id, account_id)
) STRICT;
CREATE INDEX IF NOT EXISTS members_by_account ON members(account_id);
CREATE TABLE IF NOT EXISTS records (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  ciphertext TEXT,
  PRIMARY KEY (project_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS records_by_revision ON records(project_id, revision, id);
CREATE TABLE IF NOT EXISTS leases (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  lease_id TEXT NOT NULL,
  holder TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
) STRICT;
`;

type Row = Record<string, SQLInputValue>;

function envelopeOf(row: Row): Envelope {
  const content = JSON.parse(row.envelope as string) as EnvelopeContent;
  return { ...content, revision: row.envelope_revision as number };
}

function leaseOf(row: Row): LeaseRow {
  return {
    projectId: row.project_id as string,
    leaseId: row.lease_id as string,
    holder: row.holder as string,
    accountId: row.account_id as string,
    email: row.email as string,
    expiresAt: row.expires_at as number,
  };
}

export class SqliteStorage implements Storage {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = FULL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec(SCHEMA);
  }

  #tx<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.#db.prepare(sql).get(...params) as Row | undefined;
  }

  #all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.#db.prepare(sql).all(...params) as Row[];
  }

  #run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.#db.prepare(sql).run(...params).changes);
  }

  async createAccount(account: AccountRow): Promise<boolean> {
    const changes = this.#run(
      "INSERT INTO accounts (id, email, secret_hash, secret_salt, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      account.id,
      account.email,
      account.secretHash,
      account.secretSalt,
      account.createdAt,
    );
    return changes === 1;
  }

  async accountByEmail(email: string): Promise<AccountRow | null> {
    const row = this.#get("SELECT * FROM accounts WHERE email = ?", email);
    if (row === undefined) return null;
    return {
      id: row.id as string,
      email: row.email as string,
      secretHash: Buffer.from(row.secret_hash as Uint8Array),
      secretSalt: Buffer.from(row.secret_salt as Uint8Array),
      createdAt: row.created_at as string,
    };
  }

  async createSession(tokenHash: string, accountId: string, expiresAt: number): Promise<void> {
    this.#run(
      "INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)",
      tokenHash,
      accountId,
      expiresAt,
    );
  }

  async sessionAccount(tokenHash: string, now: number): Promise<{ id: string; email: string } | null> {
    const row = this.#get(
      "SELECT a.id, a.email FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?",
      tokenHash,
      now,
    );
    return row === undefined ? null : { id: row.id as string, email: row.email as string };
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.#run("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
  }

  async deleteExpired(now: number): Promise<void> {
    this.#run("DELETE FROM sessions WHERE expires_at <= ?", now);
    this.#run("DELETE FROM leases WHERE expires_at <= ?", now);
  }

  async createProject(project: ProjectRow, ownerId: string, envelope: EnvelopeContent): Promise<boolean> {
    return this.#tx(() => {
      const inserted = this.#run(
        "INSERT INTO projects (id, sealed_name, created_at, revision, envelope, envelope_revision) VALUES (?, ?, ?, 0, ?, 1) ON CONFLICT DO NOTHING",
        project.id,
        project.sealedName,
        project.createdAt,
        JSON.stringify(envelope),
      );
      if (inserted !== 1) return false;
      this.#run("INSERT INTO members (project_id, account_id, role) VALUES (?, ?, 'owner')", project.id, ownerId);
      return true;
    });
  }

  async projectsOf(accountId: string): Promise<(ProjectRow & { role: Role })[]> {
    return this.#all(
      `SELECT p.id, p.sealed_name, p.created_at, p.revision, m.role FROM projects p
       JOIN members m ON m.project_id = p.id WHERE m.account_id = ? ORDER BY p.created_at, p.id`,
      accountId,
    ).map((row) => ({
      id: row.id as string,
      sealedName: row.sealed_name as string,
      createdAt: row.created_at as string,
      revision: row.revision as number,
      role: row.role as Role,
    }));
  }

  async role(projectId: string, accountId: string): Promise<Role | null> {
    const row = this.#get("SELECT role FROM members WHERE project_id = ? AND account_id = ?", projectId, accountId);
    return row === undefined ? null : (row.role as Role);
  }

  async renameProject(projectId: string, sealedName: string): Promise<void> {
    this.#run("UPDATE projects SET sealed_name = ? WHERE id = ?", sealedName, projectId);
  }

  async deleteProject(projectId: string): Promise<void> {
    this.#run("DELETE FROM projects WHERE id = ?", projectId);
  }

  async members(projectId: string): Promise<MemberRow[]> {
    return this.#all(
      "SELECT a.id, a.email, m.role FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.project_id = ? ORDER BY a.email",
      projectId,
    ).map((row) => ({ accountId: row.id as string, email: row.email as string, role: row.role as Role }));
  }

  async addMember(projectId: string, accountId: string): Promise<Role> {
    return this.#tx(() => {
      this.#run(
        "INSERT INTO members (project_id, account_id, role) VALUES (?, ?, 'member') ON CONFLICT DO NOTHING",
        projectId,
        accountId,
      );
      return this.#get("SELECT role FROM members WHERE project_id = ? AND account_id = ?", projectId, accountId)!
        .role as Role;
    });
  }

  async removeMember(projectId: string, accountId: string): Promise<"removed" | "not_member" | "last_owner"> {
    return this.#tx(() => {
      const row = this.#get("SELECT role FROM members WHERE project_id = ? AND account_id = ?", projectId, accountId);
      if (row === undefined) return "not_member";
      if (row.role === "owner") {
        const owners = this.#get(
          "SELECT COUNT(*) AS n FROM members WHERE project_id = ? AND role = 'owner'",
          projectId,
        )!;
        if ((owners.n as number) <= 1) return "last_owner";
      }
      this.#run("DELETE FROM members WHERE project_id = ? AND account_id = ?", projectId, accountId);
      this.#run("DELETE FROM leases WHERE project_id = ? AND account_id = ?", projectId, accountId);
      return "removed";
    });
  }

  async envelope(projectId: string): Promise<Envelope> {
    return envelopeOf(this.#get("SELECT envelope, envelope_revision FROM projects WHERE id = ?", projectId)!);
  }

  async putEnvelope(projectId: string, envelope: EnvelopeContent, expectedRevision: number): Promise<Envelope | null> {
    return this.#tx(() => {
      const changed = this.#run(
        "UPDATE projects SET envelope = ?, envelope_revision = envelope_revision + 1 WHERE id = ? AND envelope_revision = ?",
        JSON.stringify(envelope),
        projectId,
        expectedRevision,
      );
      if (changed !== 1) return null;
      return envelopeOf(this.#get("SELECT envelope, envelope_revision FROM projects WHERE id = ?", projectId)!);
    });
  }

  async pull(projectId: string, since: number, limit: number): Promise<PullResult> {
    return this.#tx(() => {
      const current = this.#get("SELECT revision FROM projects WHERE id = ?", projectId)!.revision as number;
      const toRecord = (row: Row): SealedRecord => ({
        id: row.id as string,
        revision: row.revision as number,
        ciphertext: (row.ciphertext as string | null) ?? null,
      });
      const records = this.#all(
        "SELECT id, revision, ciphertext FROM records WHERE project_id = ? AND revision > ? ORDER BY revision, id LIMIT ?",
        projectId,
        since,
        limit,
      ).map(toRecord);
      if (records.length < limit) return { revision: current, records, more: false };
      // Never split one revision: take the rest of the last revision's records too.
      const last = records[records.length - 1]!;
      const rest = this.#all(
        "SELECT id, revision, ciphertext FROM records WHERE project_id = ? AND revision = ? AND id > ? ORDER BY id",
        projectId,
        last.revision,
        last.id,
      ).map(toRecord);
      records.push(...rest);
      const more =
        this.#get(
          "SELECT 1 AS x FROM records WHERE project_id = ? AND revision > ? LIMIT 1",
          projectId,
          last.revision,
        ) !== undefined;
      return { revision: more ? last.revision : current, records, more };
    });
  }

  async push(
    projectId: string,
    leaseId: string,
    now: number,
    records: readonly PushRecord[],
  ): Promise<PushResult | "no_lease"> {
    return this.#tx(() => {
      const lease = this.#get(
        "SELECT 1 AS x FROM leases WHERE project_id = ? AND lease_id = ? AND expires_at > ?",
        projectId,
        leaseId,
        now,
      );
      if (lease === undefined) return "no_lease";
      const current = this.#get("SELECT revision FROM projects WHERE id = ?", projectId)!.revision as number;
      const revisionOf = this.#db.prepare("SELECT revision FROM records WHERE project_id = ? AND id = ?");
      const conflicts = records
        .filter((record) => {
          const row = revisionOf.get(projectId, record.id) as Row | undefined;
          return ((row?.revision as number | undefined) ?? 0) !== record.baseRevision;
        })
        .map((record) => record.id);
      if (conflicts.length > 0) return { ok: false, revision: current, conflicts };
      const revision = current + 1;
      const upsert = this.#db.prepare(
        `INSERT INTO records (project_id, id, revision, ciphertext) VALUES (?, ?, ?, ?)
         ON CONFLICT (project_id, id) DO UPDATE SET revision = excluded.revision, ciphertext = excluded.ciphertext`,
      );
      for (const record of records) upsert.run(projectId, record.id, revision, record.ciphertext);
      this.#run("UPDATE projects SET revision = ? WHERE id = ?", revision, projectId);
      return { ok: true, revision, conflicts: [] };
    });
  }

  #lease(projectId: string, now: number): LeaseRow | null {
    const row = this.#get(
      "SELECT l.*, a.email FROM leases l JOIN accounts a ON a.id = l.account_id WHERE l.project_id = ? AND l.expires_at > ?",
      projectId,
      now,
    );
    return row === undefined ? null : leaseOf(row);
  }

  async activeLease(projectId: string, now: number): Promise<LeaseRow | null> {
    return this.#lease(projectId, now);
  }

  async acquireLease(
    projectId: string,
    accountId: string,
    holder: string,
    leaseId: string,
    now: number,
    expiresAt: number,
    takeOver: boolean,
  ): Promise<AcquireResult> {
    return this.#tx(() => {
      const current = this.#lease(projectId, now);
      const same = current !== null && current.accountId === accountId && current.holder === holder;
      if (current !== null && !takeOver && !same) return { held: true };
      this.#run(
        `INSERT INTO leases (project_id, lease_id, holder, account_id, expires_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET lease_id = excluded.lease_id, holder = excluded.holder,
           account_id = excluded.account_id, expires_at = excluded.expires_at`,
        projectId,
        leaseId,
        holder,
        accountId,
        expiresAt,
      );
      return { lease: this.#lease(projectId, now)! };
    });
  }

  async renewLease(projectId: string, leaseId: string, now: number, expiresAt: number): Promise<LeaseRow | null> {
    return this.#tx(() => {
      const changed = this.#run(
        "UPDATE leases SET expires_at = ? WHERE project_id = ? AND lease_id = ? AND expires_at > ?",
        expiresAt,
        projectId,
        leaseId,
        now,
      );
      return changed === 1 ? this.#lease(projectId, now) : null;
    });
  }

  async releaseLease(projectId: string, leaseId: string): Promise<void> {
    this.#run("DELETE FROM leases WHERE project_id = ? AND lease_id = ?", projectId, leaseId);
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
