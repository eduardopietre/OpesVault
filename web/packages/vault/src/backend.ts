/**
 * The only door between the app and the data server (docs/18 §3.4, docs/19 §6).
 *
 * Every adapter (the self-hosted server, Firebase later) implements this interface and must pass
 * the same contract suite (`./contract/`). The server never sees a password, a key or a plaintext
 * record: everything that crosses this boundary is opaque ciphertext or an opaque id.
 *
 * Rules every adapter follows (the contract suite checks each one):
 * - Ids chosen by the client (project, record and blob ids) are 32 lowercase hex characters
 *   (`ID_PATTERN`). Account and lease ids are chosen by the server and are opaque.
 * - A project, its envelope, records, blobs, members and lease are reachable only by its members.
 *   For anyone else, an existing and a missing project look the same: `forbidden`.
 * - Every project has a revision counter that starts at 0. Each accepted push advances it by one
 *   and every record in that push is written at the new revision.
 * - The server keeps only the current version of each record; a deleted record is a tombstone
 *   (`ciphertext: null`) at the revision of the delete. No history (adopted provisionally, docs/19 §6).
 * - `pull` returns records with a revision greater than `sinceRevision`, ordered by revision and
 *   then id. A page never splits one revision (one push), so a reader never sees half a push;
 *   `limit` may therefore be exceeded by the rest of the last push.
 * - Writes to records and blobs need the edit lease. One lease per project; it expires unless
 *   renewed. A push or blob write without the current, unexpired lease fails with `no_lease`.
 */

/** Base64url text of bytes. */
export type B64 = string;

/** Project, record and blob ids: 128 bits as lowercase hex. */
export const ID_PATTERN = /^[0-9a-f]{32}$/;

/** A lease holder label: opaque text chosen by the client (a random tab id), not personal data. */
export const HOLDER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Size limits every adapter enforces; larger requests fail with `too_large`. */
export const LIMITS = {
  /** Base64url characters of one record's ciphertext. */
  maxRecordCiphertext: 1_048_576,
  /** Records in one push. */
  maxPushRecords: 500,
  /** Base64url characters of all ciphertext in one push. */
  maxPushCiphertext: 16 * 1_048_576,
  /** Default and largest page of a pull. */
  defaultPullLimit: 500,
  maxPullLimit: 1000,
  /** Bytes of one encrypted blob (attachment). */
  maxBlobBytes: 64 * 1_048_576,
  /** Base64url characters of the sealed project name. */
  maxSealedName: 4096,
  /** Base64url characters of each envelope field. */
  maxEnvelopeField: 1024,
} as const;

/** How long an edit lease lasts without renewal. Clients renew well before (a third of it). */
export const LEASE_MS = 60_000;

export interface AccountSession {
  readonly accountId: string;
  readonly email: string;
}

export interface ProjectSummary {
  readonly projectId: string;
  /** The project's name is encrypted too: the server lists projects without knowing them. */
  readonly sealedName: B64;
  readonly createdAt: string;
  /** The project's record revision (see the rules above). */
  readonly revision: number;
  /** The caller's role in the project. */
  readonly role: "owner" | "member";
}

/** The project key wrapped by the password key and by the recovery key (docs/19 §4). */
export interface EnvelopeContent {
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
}

export interface Envelope extends EnvelopeContent {
  /** Revision of the envelope itself: 1 at creation; every accepted `putEnvelope` bumps it. */
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
  /** New project revision when ok (every pushed record has it); the current revision on conflict. */
  readonly revision: number;
  /** Records whose base revision was outdated (someone else wrote them). Nothing was written. */
  readonly conflicts: readonly string[];
}

export interface PullResult {
  /** The revision to pull from next: the last record's revision when `more`, else the project's. */
  readonly revision: number;
  readonly records: readonly SealedRecord[];
  /** More pages follow from `revision`. */
  readonly more: boolean;
}

export interface EditLease {
  readonly leaseId: string;
  /** The client label passed to `acquireEditLease`. */
  readonly holder: string;
  /** Who holds it, so that readers can show "being edited by …". */
  readonly accountId: string;
  readonly email: string;
  readonly expiresAt: string;
}

export type BackendErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  /** Someone else holds an unexpired edit lease. */
  | "lease_held"
  /** The lease given is not the project's current, unexpired lease (expired, released or taken over). */
  | "no_lease"
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
  /** The revision this change was based on (0 for a record the client never saw on the server). */
  readonly baseRevision: number;
  readonly ciphertext: B64 | null;
}

export interface SyncBackend {
  // accounts: the login secret is derived from the password in the browser (docs/19 §5)
  /** Creates the account and signs in. `conflict` if the email is taken. */
  signUp(email: string, loginSecret: B64): Promise<AccountSession>;
  /** `unauthorized` for a wrong secret or an unknown email (indistinguishable). */
  signIn(email: string, loginSecret: B64): Promise<AccountSession>;
  signOut(): Promise<void>;
  currentSession(): Promise<AccountSession | null>;
  /** Public salt for deriving the login secret of an email (stable, and also given for unknown emails). */
  loginSalt(email: string): Promise<B64>;

  // projects (every call below needs a signed-in account; `unauthorized` otherwise)
  listProjects(): Promise<readonly ProjectSummary[]>;
  /** The client picks the id (it is bound into the envelope and the name). `conflict` if it exists. */
  createProject(projectId: string, sealedName: B64, envelope: EnvelopeContent): Promise<ProjectSummary>;
  /** Any member (they all know the shared password). */
  renameProject(projectId: string, sealedName: B64): Promise<void>;
  /** Owner only: deletes the envelope, records, blobs, members and lease. */
  deleteProject(projectId: string): Promise<void>;
  /** Who can reach the project's ciphertext; they still need the project password to read it. */
  listMembers(projectId: string): Promise<readonly ProjectMember[]>;
  /** Owner only: gives an existing account access (`not_found` if there is no such account). */
  addMember(projectId: string, email: string): Promise<ProjectMember>;
  /** Owner only (or the member leaving). The last owner cannot be removed (`conflict`). */
  removeMember(projectId: string, accountId: string): Promise<void>;
  getEnvelope(projectId: string): Promise<Envelope>;
  /** Replaces the envelope if `expectedRevision` still matches (`conflict` otherwise). */
  putEnvelope(projectId: string, envelope: EnvelopeContent, expectedRevision: number): Promise<Envelope>;

  // records
  pull(projectId: string, sinceRevision: number, limit?: number): Promise<PullResult>;
  /** All or nothing: either every record is written at a new revision or none is. Needs the edit lease. */
  push(projectId: string, leaseId: string, records: readonly PushRecord[]): Promise<PushResult>;

  // blobs (attachments), encrypted with their own key; writes need the edit lease
  putBlob(projectId: string, leaseId: string, blobId: string, data: Uint8Array): Promise<void>;
  /** `not_found` for a blob that does not exist. */
  getBlob(projectId: string, blobId: string): Promise<Uint8Array>;
  deleteBlob(projectId: string, leaseId: string, blobId: string): Promise<void>;

  // one editor at a time (docs/18 §3.3)
  /**
   * `lease_held` if someone else holds an unexpired lease, unless `takeOver`. The same account with
   * the same holder label (the same tab after a reload) gets a new lease without taking over.
   */
  acquireEditLease(projectId: string, holder: string, takeOver?: boolean): Promise<EditLease>;
  /** Extends the current, unexpired lease; `no_lease` otherwise. */
  renewEditLease(projectId: string, leaseId: string): Promise<EditLease>;
  /** Releases the lease if it is still current; otherwise does nothing. */
  releaseEditLease(projectId: string, leaseId: string): Promise<void>;
  /** The unexpired lease, if any. */
  currentLease(projectId: string): Promise<EditLease | null>;
}
