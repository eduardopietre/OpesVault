/**
 * The only door between the app and the data server (docs/18 §3.4).
 *
 * Every adapter (the self-hosted server, Firebase later) implements this interface and must pass
 * the same contract suite. The server never sees a password, a key or a plaintext record:
 * everything that crosses this boundary is opaque ciphertext or an opaque id.
 */

/** Base64url text of bytes. */
export type B64 = string;

export interface AccountSession {
  readonly accountId: string;
  readonly email: string;
}

export interface ProjectSummary {
  readonly projectId: string;
  /** The project's name is encrypted too: the server lists projects without knowing them. */
  readonly sealedName: B64;
  readonly createdAt: string;
  readonly revision: number;
}

/** The project key wrapped by the password key and by the recovery key (docs/18 §3.2). */
export interface Envelope {
  readonly version: number;
  /** KDF parameters and salt for the password; public by design. */
  readonly kdf: {
    readonly algorithm: "argon2id";
    readonly memoryKiB: number;
    readonly iterations: number;
    readonly parallelism: number;
    readonly salt: B64;
  };
  readonly wrappedByPassword: B64;
  readonly recoverySalt: B64 | null;
  readonly wrappedByRecovery: B64 | null;
  /** Revision of the envelope itself; changing the password or the recovery key bumps it. */
  readonly revision: number;
}

/** One encrypted record. The id is opaque; kind and real id live inside the ciphertext. */
export interface SealedRecord {
  readonly id: string;
  /** Server revision at which this version was written. */
  readonly revision: number;
  /** null when the record was deleted (a tombstone). */
  readonly ciphertext: B64 | null;
}

export interface PushResult {
  readonly ok: boolean;
  /** New project revision when ok; the server's current revision on conflict. */
  readonly revision: number;
  /** Records whose base revision was outdated (someone else wrote them). */
  readonly conflicts: readonly string[];
}

export interface PullResult {
  readonly revision: number;
  readonly records: readonly SealedRecord[];
  /** More pages follow from `revision`. */
  readonly more: boolean;
}

export interface EditLease {
  readonly leaseId: string;
  readonly holder: string;
  readonly expiresAt: string;
}

export type BackendErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "lease_held"
  | "too_large"
  | "rate_limited"
  | "offline"
  | "invalid"
  | "server";

export class BackendError extends Error {
  readonly code: BackendErrorCode;

  constructor(code: BackendErrorCode, message: string = code) {
    super(message);
    this.name = "BackendError";
    this.code = code;
  }
}

/** A person with access to a project: their own account, the shared project password (docs/18 §1). */
export interface ProjectMember {
  readonly accountId: string;
  readonly email: string;
  readonly role: "owner" | "member";
}

export interface PushRecord {
  readonly id: string;
  /** The revision this change was based on (0 for a new record). */
  readonly baseRevision: number;
  readonly ciphertext: B64 | null;
}

export interface SyncBackend {
  // accounts: the login secret is derived from the password in the browser (docs/18 §3.2)
  signUp(email: string, loginSecret: B64): Promise<AccountSession>;
  signIn(email: string, loginSecret: B64): Promise<AccountSession>;
  signOut(): Promise<void>;
  currentSession(): Promise<AccountSession | null>;
  /** Public salt for deriving the login secret of an email (the same for unknown emails). */
  loginSalt(email: string): Promise<B64>;

  // projects
  listProjects(): Promise<readonly ProjectSummary[]>;
  createProject(sealedName: B64, envelope: Envelope): Promise<ProjectSummary>;
  renameProject(projectId: string, sealedName: B64): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  /** Who can reach the project's ciphertext; they still need the project password to read it. */
  listMembers(projectId: string): Promise<readonly ProjectMember[]>;
  /** Owner only: gives an existing account access to the project. */
  addMember(projectId: string, email: string): Promise<ProjectMember>;
  /** Owner only (or the member leaving). The last owner cannot be removed. */
  removeMember(projectId: string, accountId: string): Promise<void>;
  getEnvelope(projectId: string): Promise<Envelope>;
  /** Replaces the envelope if `expectedRevision` still matches (password or recovery change). */
  putEnvelope(projectId: string, envelope: Envelope, expectedRevision: number): Promise<Envelope>;

  // records
  pull(projectId: string, sinceRevision: number, limit?: number): Promise<PullResult>;
  /** All or nothing: either every record is written at a new revision or none is. Needs the edit lease. */
  push(projectId: string, leaseId: string, records: readonly PushRecord[]): Promise<PushResult>;

  // blobs (attachments), encrypted with their own key
  putBlob(projectId: string, leaseId: string, blobId: string, data: Uint8Array): Promise<void>;
  getBlob(projectId: string, blobId: string): Promise<Uint8Array>;
  deleteBlob(projectId: string, leaseId: string, blobId: string): Promise<void>;

  // one editor at a time (docs/18 §3.3)
  acquireEditLease(projectId: string, holder: string, takeOver?: boolean): Promise<EditLease>;
  renewEditLease(projectId: string, leaseId: string): Promise<EditLease>;
  releaseEditLease(projectId: string, leaseId: string): Promise<void>;
  currentLease(projectId: string): Promise<EditLease | null>;
}
