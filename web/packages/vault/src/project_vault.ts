/**
 * One project in the browser: unlock, plain records in memory, automatic sync, lock (docs/19 §8–§9).
 *
 * The app (and later the domain's Ledger) sees plain records `{kind, id, payload}`; everything
 * below this object is ciphertext. While unlocked, the project's working keys live in this object
 * as non-extractable CryptoKeys; `lock()` drops them together with every plaintext record, the
 * decrypted attachments and the timers. Changes not yet accepted by the server stay sealed in
 * IndexedDB and survive a reload while locked.
 *
 * Sync, in short:
 * - `stage()` updates the in-memory view at once, seals the change and writes it to the pending
 *   queue in IndexedDB; a push follows after a short delay, in batches, under the edit lease.
 * - Pulls bring other people's changes. A pending change whose record changed on the server is a
 *   conflict: it is listed in `conflicts` and stays pending until `resolveConflict` decides.
 * - A push whose answer is lost (network drop) is never sent blindly again: the next sync pulls
 *   first, and a pulled record identical to the pending ciphertext proves the push was accepted.
 * - One editor at a time: without the lease, the project opens read-only (`readOnly`), polls for
 *   changes, and can `takeOver()` explicitly. Offline, edits are allowed and wait in the queue.
 *
 * `subscribe` + `getSnapshot` follow React's `useSyncExternalStore` contract: the snapshot object
 * changes identity only when something in it changed.
 */
import {
  changeEnvelopePassword,
  createProjectSecrets,
  CryptoError,
  fromUtf8,
  openWithPassword,
  openWithRecoveryKey,
  randomId,
  regenerateEnvelopeRecoveryKey,
  systemRandom,
  utf8,
  wipe,
  type KdfParams,
  type PlainRecord,
  type ProjectKeys,
  type RandomSource,
} from "@opesvault/crypto";
import {
  BackendError,
  ID_PATTERN,
  LEASE_MS,
  LIMITS,
  type EditLease,
  type Envelope,
  type EnvelopeContent,
  type PullResult,
  type PushResult,
  type SyncBackend,
} from "./backend.ts";
import { BlobCache } from "./blob_cache.ts";
import type { CachedSnapshot, PendingChange, VaultCache } from "./cache.ts";
import { IdleTimer, systemTimers, type Timers } from "./timers.ts";

export type { PlainRecord } from "@opesvault/crypto";

export type SyncStatus = "synced" | "pending" | "syncing" | "offline" | "conflict" | "readOnly" | "locked";

export type VaultErrorCode =
  | "locked"
  | "read_only"
  | "wrong_password"
  | "wrong_recovery_key"
  | "invalid_recovery_key"
  | "empty_password"
  | "offline"
  | "conflict"
  | "no_lease";

/** Errors of the vault's own state. Network failures surface as `BackendError`. */
export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode) {
    super(code);
    this.name = "VaultError";
    this.code = code;
  }
}

export interface RecordRef {
  readonly kind: string;
  readonly id: string;
}

/** The key of a record in `records`: kind and id, the same text the opaque id is computed from. */
export function recordKey(kind: string, id: string): string {
  return `${kind}\n${id}`;
}

export interface Conflict {
  readonly key: string;
  readonly kind: string;
  readonly id: string;
  readonly opaqueId: string;
  /** This tab's pending version (null: deleted here). */
  readonly local: PlainRecord | null;
  /** The server's version (null: deleted there, or unreadable). */
  readonly remote: PlainRecord | null;
  readonly remoteRevision: number;
}

/** Records changed by someone else, applied to `records` by a pull. */
export interface RemoteChange {
  readonly upserts: readonly PlainRecord[];
  readonly deletes: readonly RecordRef[];
}

export interface VaultSnapshot {
  readonly status: SyncStatus;
  readonly unlocked: boolean;
  /** The project's name, known only while unlocked. */
  readonly name: string | null;
  /** Local changes not yet accepted by the server. */
  readonly pending: number;
  readonly conflicts: readonly Conflict[];
  /** This tab's lease, when it is the editor. */
  readonly lease: EditLease | null;
  /** Who is editing, when this tab is read-only. */
  readonly heldBy: EditLease | null;
  readonly online: boolean;
  /** The server revision the local copy has reached. */
  readonly revision: number;
  /** Opaque ids of records that failed authentication (altered or misplaced ciphertext). */
  readonly damaged: readonly string[];
  /** Code of the last sync error that was not a network drop (`forbidden`, `unauthorized`, …). */
  readonly lastError: string | null;
}

export interface ProjectVaultOptions {
  readonly backend: SyncBackend;
  readonly cache: VaultCache;
  readonly projectId: string;
  /**
   * Lease holder label for this tab; random by default. The app keeps it for the life of the tab
   * (sessionStorage, through preferences), so that a reload gets its own lease back at once.
   */
  readonly holder?: string;
  /** Argon2id parameters for new wraps (password change, recovery); production uses the default. */
  readonly kdf?: KdfParams;
  /** Tests only. */
  readonly random?: RandomSource;
  readonly timers?: Timers;
  /** Wait after a change before pushing, to batch a burst of edits. */
  readonly pushDelayMs?: number;
  /** Wait before retrying after a network or server failure. */
  readonly retryMs?: number;
  /** How often a read-only tab pulls and checks whether the lease became free. */
  readonly pollMs?: number;
  /** Lock after this long without `touch()`; null disables. */
  readonly idleLockMs?: number | null;
  /** Decrypted attachments kept in memory while unlocked. */
  readonly blobCacheBytes?: number;
  readonly pullPageSize?: number;
  /** When the device snapshot is written (defaults: `SNAPSHOT_MIN`, `SNAPSHOT_STALE`, `SNAPSHOT_DELAY_MS`). */
  readonly deviceSnapshot?: { readonly minRecords?: number; readonly stale?: number; readonly delayMs?: number };
}

export interface CreateProjectOptions extends Omit<ProjectVaultOptions, "projectId"> {
  readonly name: string;
  readonly password: string;
  readonly projectId?: string;
}

type Mode = "none" | "edit" | "readOnly";

function isOffline(error: unknown): boolean {
  return (error instanceof BackendError && error.code === "offline") || error instanceof TypeError;
}

function isLeaseError(error: unknown): boolean {
  return error instanceof BackendError && (error.code === "no_lease" || error.code === "lease_held");
}

function vaultErrorFromCrypto(error: unknown): unknown {
  if (error instanceof CryptoError) {
    switch (error.code) {
      case "wrong_password":
      case "wrong_recovery_key":
      case "invalid_recovery_key":
      case "empty_password":
        return new VaultError(error.code);
      default:
        return error;
    }
  }
  return error;
}

function envelopeContent(envelope: EnvelopeContent): EnvelopeContent {
  return {
    version: envelope.version,
    kdf: { ...envelope.kdf },
    wrappedByPassword: envelope.wrappedByPassword,
    recoverySalt: envelope.recoverySalt,
    wrappedByRecovery: envelope.wrappedByRecovery,
  };
}

const LOCKED_SNAPSHOT: VaultSnapshot = Object.freeze({
  status: "locked",
  unlocked: false,
  name: null,
  pending: 0,
  conflicts: Object.freeze([]) as readonly Conflict[],
  lease: null,
  heldBy: null,
  online: true,
  revision: 0,
  damaged: Object.freeze([]) as readonly string[],
  lastError: null,
});

/** A sealed record as the vault holds it before opening. */
interface SealedItem {
  readonly id: string;
  readonly ciphertext: string;
}

/** One cached record, opened (or found to be a tombstone or damaged): also the device snapshot's format. */
type OpenedEntry =
  | readonly [id: string, revision: number, state: "tombstone"]
  | readonly [id: string, revision: number, state: "damaged"]
  | readonly [id: string, revision: number, state: "open", record: PlainRecord];

/** Records decrypted at once: enough to keep the browser's crypto threads busy without a huge promise list. */
const OPEN_BATCH = 256;
/** A project with fewer records than this opens fast without a device snapshot: none is written. */
const SNAPSHOT_MIN = 2000;
/** The device snapshot is rewritten once this many records were written after it… */
const SNAPSHOT_STALE = 500;
/** …a moment after the last of them, when nothing is pending (writing it costs a fraction of a second). */
const SNAPSHOT_DELAY_MS = 5000;

/** Decrypts many records, a batch at a time; a record that fails to open is `null` (damaged). */
async function openMany(keys: ProjectKeys, items: readonly SealedItem[]): Promise<Map<string, PlainRecord | null>> {
  const out = new Map<string, PlainRecord | null>();
  for (let i = 0; i < items.length; i += OPEN_BATCH) {
    const batch = items.slice(i, i + OPEN_BATCH);
    const opened = await Promise.all(batch.map((item) => keys.openRecord(item.id, item.ciphertext).catch(() => null)));
    batch.forEach((item, k) => out.set(item.id, opened[k]!));
  }
  return out;
}

/** Records the time since `since` as a `performance.measure` (docs/18 W12 measurements); returns now. */
function span(label: string, since: number): number {
  const now = performance.now();
  try {
    performance.measure(`opv:${label}`, { start: since, end: now });
  } catch {
    // no Performance API: nothing to record
  }
  return now;
}

export class ProjectVault {
  readonly projectId: string;
  readonly holder: string;
  readonly #backend: SyncBackend;
  readonly #cache: VaultCache;
  readonly #kdf: KdfParams | undefined;
  readonly #random: RandomSource;
  readonly #timers: Timers;
  readonly #pushDelayMs: number;
  readonly #retryMs: number;
  readonly #pollMs: number;
  readonly #pageSize: number;
  #idle: IdleTimer | null;
  readonly #blobs: BlobCache;

  #keys: ProjectKeys | null = null;
  #locking = false;
  /** Bumped on every lock and unlock; async work started earlier checks it before touching state. */
  #generation = 0;
  #name: string | null = null;
  #sealedName: string | null = null;
  readonly #plain = new Map<string, PlainRecord>();
  /** opaque id → kind and id, for tombstones and conflicts. */
  readonly #refs = new Map<string, RecordRef>();
  /** opaque id → the server revision of the record (tombstones included). */
  readonly #known = new Map<string, number>();
  /** Opaque ids whose current server version is a tombstone. */
  readonly #tombstones = new Set<string>();
  readonly #pending = new Map<string, PendingChange>();
  /** Opaque ids in a push whose answer has not arrived yet. */
  readonly #inFlight = new Set<string>();
  readonly #conflicts = new Map<string, Conflict>();
  readonly #damaged = new Set<string>();
  #cursor = 0;
  #mode: Mode = "none";
  #lease: EditLease | null = null;
  #heldBy: EditLease | null = null;
  #online = true;
  #syncing = false;
  /** Changes whose in-memory part is done but not yet sealed into `#pending` (see `stage`). */
  #unstaged = 0;
  /** The generation of the device snapshot this device has (null: none), and rows written after it. */
  #snapshotGeneration: number | null = null;
  #snapshotStale = 0;
  #snapshotTimer: unknown = null;
  readonly #snapshotRule: { readonly minRecords: number; readonly stale: number; readonly delayMs: number };
  #lastError: string | null = null;

  #wantPull = false;
  #wantPush = false;
  /** A push may have been accepted without our knowing: pull before pushing again. */
  #needPull = false;
  #syncRun: Promise<void> | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  #pushTimer: unknown = null;
  #renewTimer: unknown = null;
  #pollTimer: unknown = null;
  #retryTimer: unknown = null;

  #snapshot: VaultSnapshot = LOCKED_SNAPSHOT;
  #conflictList: readonly Conflict[] = [];
  #damagedList: readonly string[] = [];
  readonly #listeners = new Set<() => void>();
  readonly #remoteListeners = new Set<(change: RemoteChange) => void>();

  constructor(options: ProjectVaultOptions) {
    this.projectId = options.projectId;
    this.#backend = options.backend;
    this.#cache = options.cache;
    this.#snapshotRule = {
      minRecords: options.deviceSnapshot?.minRecords ?? SNAPSHOT_MIN,
      stale: options.deviceSnapshot?.stale ?? SNAPSHOT_STALE,
      delayMs: options.deviceSnapshot?.delayMs ?? SNAPSHOT_DELAY_MS,
    };
    this.#kdf = options.kdf;
    this.#random = options.random ?? systemRandom;
    this.holder = options.holder ?? `tab-${randomId(this.#random)}`;
    this.#timers = options.timers ?? systemTimers;
    this.#pushDelayMs = options.pushDelayMs ?? 1000;
    this.#retryMs = options.retryMs ?? 5000;
    this.#pollMs = options.pollMs ?? 15_000;
    this.#pageSize = options.pullPageSize ?? LIMITS.defaultPullLimit;
    this.#blobs = new BlobCache(options.blobCacheBytes ?? 64 * 1024 * 1024);
    const idle = options.idleLockMs ?? null;
    this.#idle = idle === null ? null : new IdleTimer(idle, () => void this.lock(), this.#timers);
  }

  /**
   * Creates a project on the server: new project key, envelope, recovery key and sealed name.
   * Returns the vault, unlocked and holding the edit lease, and the recovery key to show once.
   */
  static async create(options: CreateProjectOptions): Promise<{ vault: ProjectVault; recoveryKey: string }> {
    const random = options.random ?? systemRandom;
    const projectId = options.projectId ?? randomId(random);
    if (options.password.length === 0) throw new VaultError("empty_password");
    const secrets = await createProjectSecrets(projectId, options.password, {
      ...(options.kdf ? { kdf: options.kdf } : {}),
      random,
    });
    const sealedName = await secrets.keys.sealName(options.name, random);
    await options.backend.createProject(projectId, sealedName, secrets.envelope);
    await options.cache.putProject({
      projectId,
      cursor: 0,
      envelope: { ...secrets.envelope, revision: 1 },
      sealedName,
    });
    const vault = new ProjectVault({ ...options, projectId });
    await vault.#open(secrets.keys);
    return { vault, recoveryKey: secrets.recoveryKey };
  }

  // ---------------------------------------------------------------- observable state

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getSnapshot(): VaultSnapshot {
    return this.#snapshot;
  }

  /** Called after a pull applied someone else's changes to `records`. */
  onRemoteChange(listener: (change: RemoteChange) => void): () => void {
    this.#remoteListeners.add(listener);
    return () => this.#remoteListeners.delete(listener);
  }

  get unlocked(): boolean {
    return this.#keys !== null && !this.#locking;
  }

  /** Plain records by `recordKey(kind, id)`; empty while locked. */
  get records(): ReadonlyMap<string, PlainRecord> {
    return this.#plain;
  }

  get(kind: string, id: string): PlainRecord | undefined {
    return this.#plain.get(recordKey(kind, id));
  }

  /**
   * Changes the idle lock time (null turns it off), for a setting the user changed while the project is
   * open. Counts from now.
   */
  setIdleLock(ms: number | null): void {
    this.#idle?.stop();
    this.#idle = ms === null ? null : new IdleTimer(ms, () => void this.lock(), this.#timers);
    if (this.unlocked) this.#idle?.touch();
  }

  /** Marks user activity for the idle lock. */
  touch(): void {
    if (this.unlocked) this.#idle?.touch();
  }

  #update(): void {
    const unlocked = this.unlocked;
    if (!unlocked) {
      if (this.#snapshot !== LOCKED_SNAPSHOT) {
        this.#snapshot = LOCKED_SNAPSHOT;
        this.#notify();
      }
      return;
    }
    let status: SyncStatus;
    if (this.#conflicts.size > 0) status = "conflict";
    else if (this.#mode === "readOnly") status = "readOnly";
    else if (!this.#online) status = "offline";
    else if (this.#syncing) status = "syncing";
    else if (this.#pending.size > 0) status = "pending";
    else status = "synced";
    const next: VaultSnapshot = {
      status,
      unlocked,
      name: this.#name,
      pending: this.#pending.size,
      conflicts: this.#conflictList,
      lease: this.#lease,
      heldBy: this.#heldBy,
      online: this.#online,
      revision: this.#cursor,
      damaged: this.#damagedList,
      lastError: this.#lastError,
    };
    const prev = this.#snapshot;
    const same = (Object.keys(next) as (keyof VaultSnapshot)[]).every((key) => next[key] === prev[key]);
    if (!same) {
      this.#snapshot = Object.freeze(next);
      this.#notify();
    }
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  #conflictsChanged(): void {
    this.#conflictList = Object.freeze([...this.#conflicts.values()]);
  }

  #damagedChanged(): void {
    this.#damagedList = Object.freeze([...this.#damaged]);
  }

  // ---------------------------------------------------------------- unlock and lock

  /** Opens the project with the shared project password. A wrong password is `wrong_password`. */
  async unlock(password: string): Promise<void> {
    if (this.#keys !== null) return;
    let t = performance.now();
    // Read while the password is checked: it is ciphertext, and only the key opens it.
    const snapshot = this.#cache.getSnapshot(this.projectId).catch(() => null);
    const envelope = await this.#envelope();
    t = span("envelope", t);
    let keys: ProjectKeys;
    try {
      keys = await openWithPassword(this.projectId, envelope, password);
    } catch (error) {
      throw vaultErrorFromCrypto(error);
    }
    span("kdf", t);
    await this.#open(keys, snapshot);
  }

  /**
   * Opens the project with the recovery key and sets a new project password (needs the server:
   * the new envelope is stored there). The recovery key keeps working until regenerated.
   */
  async unlockWithRecovery(recoveryKey: string, newPassword: string): Promise<void> {
    if (this.#keys !== null) return;
    if (newPassword.length === 0) throw new VaultError("empty_password");
    const envelope = await this.#serverEnvelope();
    let opened: { keys: ProjectKeys; envelope: EnvelopeContent };
    try {
      opened = await openWithRecoveryKey(this.projectId, envelope, recoveryKey, newPassword, this.#envelopeOptions());
    } catch (error) {
      throw vaultErrorFromCrypto(error);
    }
    try {
      await this.#storeEnvelope(opened.envelope, envelope.revision);
    } catch (error) {
      opened.keys.destroy();
      throw error;
    }
    await this.#open(opened.keys);
  }

  /**
   * Checks the project password against the envelope without opening anything (the backup asks for it
   * again, so that a file is never protected by a mistyped password). `wrong_password` when it differs.
   */
  async checkPassword(password: string): Promise<void> {
    const envelope = await this.#envelope();
    let keys: ProjectKeys;
    try {
      keys = await openWithPassword(this.projectId, envelope, password);
    } catch (error) {
      throw vaultErrorFromCrypto(error);
    }
    keys.destroy();
  }

  /** Re-wraps the project key under a new password. Members must use the new password from then on. */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    if (newPassword.length === 0) throw new VaultError("empty_password");
    const envelope = await this.#serverEnvelope();
    let updated: EnvelopeContent;
    try {
      updated = await changeEnvelopePassword(
        this.projectId,
        envelope,
        currentPassword,
        newPassword,
        this.#envelopeOptions(),
      );
    } catch (error) {
      throw vaultErrorFromCrypto(error);
    }
    await this.#storeEnvelope(updated, envelope.revision);
  }

  /** A new recovery key (returned once); the previous one stops opening the envelope. */
  async regenerateRecoveryKey(password: string): Promise<string> {
    const envelope = await this.#serverEnvelope();
    let result: { envelope: EnvelopeContent; recoveryKey: string };
    try {
      result = await regenerateEnvelopeRecoveryKey(this.projectId, envelope, password, this.#envelopeOptions());
    } catch (error) {
      throw vaultErrorFromCrypto(error);
    }
    await this.#storeEnvelope(result.envelope, envelope.revision);
    return result.recoveryKey;
  }

  /**
   * Drops the keys, every plaintext record, decrypted attachments, conflicts and timers. Changes
   * not yet sent stay sealed in IndexedDB; the returned promise also covers a last attempt to send
   * them (ciphertext only, no key needed) and releasing the edit lease.
   */
  async lock(): Promise<void> {
    if (this.#keys === null || this.#locking) return;
    this.#locking = true;
    this.#generation += 1;
    this.#clearTimers();
    if (this.#snapshotTimer !== null) this.#timers.clearTimeout(this.#snapshotTimer);
    this.#snapshotTimer = null;
    this.#snapshotGeneration = null;
    this.#snapshotStale = 0;
    this.#idle?.stop();
    this.#update();
    // Changes being sealed right now finish first, so that no staged change is lost.
    await this.#queue.catch(() => undefined);
    this.#keys.destroy();
    this.#keys = null;
    this.#plain.clear();
    this.#refs.clear();
    this.#known.clear();
    this.#tombstones.clear();
    this.#pending.clear();
    this.#conflicts.clear();
    this.#conflictsChanged();
    this.#damaged.clear();
    this.#damagedChanged();
    this.#blobs.clear();
    this.#name = null;
    this.#heldBy = null;
    this.#mode = "none";
    this.#lastError = null;
    const lease = this.#lease;
    this.#lease = null;
    this.#locking = false;
    this.#update();
    await this.#syncRun?.catch(() => undefined);
    if (lease !== null) await this.#flushLocked(lease);
  }

  #envelopeOptions(): { kdf?: KdfParams; random: RandomSource } {
    return this.#kdf ? { kdf: this.#kdf, random: this.#random } : { random: this.#random };
  }

  /** The envelope from the server, or the cached one when offline (opening works offline). */
  async #envelope(): Promise<Envelope> {
    try {
      return await this.#serverEnvelope();
    } catch (error) {
      if (!(error instanceof VaultError && error.code === "offline")) throw error;
      const cached = await this.#cache.getProject(this.projectId);
      if (cached?.envelope) return cached.envelope;
      throw error;
    }
  }

  async #serverEnvelope(): Promise<Envelope> {
    try {
      const envelope = await this.#backend.getEnvelope(this.projectId);
      this.#online = true;
      await this.#cache.updateProject(this.projectId, { envelope });
      return envelope;
    } catch (error) {
      if (isOffline(error)) {
        this.#online = false;
        throw new VaultError("offline");
      }
      throw error;
    }
  }

  async #storeEnvelope(envelope: EnvelopeContent, expectedRevision: number): Promise<void> {
    let stored: Envelope;
    try {
      stored = await this.#backend.putEnvelope(this.projectId, envelopeContent(envelope), expectedRevision);
    } catch (error) {
      if (isOffline(error)) throw new VaultError("offline");
      if (error instanceof BackendError && error.code === "conflict") throw new VaultError("conflict");
      throw error;
    }
    await this.#cache.updateProject(this.projectId, { envelope: stored });
  }

  async #open(keys: ProjectKeys, snapshot?: Promise<CachedSnapshot | null>): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    const cached = await this.#cache.getProject(this.projectId);
    const pending = await this.#cache.listPending(this.projectId);
    this.#cursor = cached?.cursor ?? 0;
    this.#sealedName = cached?.sealedName ?? null;
    const entries = await this.#readCachedEntries(keys, cached?.generation, snapshot);
    let t = performance.now();
    this.#loadEntries(entries, new Set());
    t = span("load", t);
    for (const change of pending) {
      this.#pending.set(change.id, change);
      if (change.ciphertext === null) {
        const ref = this.#refs.get(change.id);
        if (ref) this.#plain.delete(recordKey(ref.kind, ref.id));
        continue;
      }
      try {
        const plain = await keys.openRecord(change.id, change.ciphertext);
        this.#refs.set(change.id, { kind: plain.kind, id: plain.id });
        this.#plain.set(recordKey(plain.kind, plain.id), plain);
      } catch {
        this.#damaged.add(change.id);
      }
    }
    if (this.#sealedName !== null) {
      try {
        this.#name = await keys.openName(this.#sealedName);
      } catch {
        this.#name = null;
      }
    }
    if (generation !== this.#generation) {
      keys.destroy();
      return;
    }
    this.#damagedChanged();
    this.#keys = keys;
    this.#mode = "none";
    this.#idle?.touch();
    this.#update();
    await this.#connect();
    span("connect", t);
    this.#scheduleSnapshot();
  }

  /**
   * Every record this device has cached for the project, opened: from the device snapshot (and the rows written
   * after it) when there is one, else every record one by one. `generation` is the cache's (undefined: do not
   * look for a snapshot).
   */
  async #readCachedEntries(
    keys: ProjectKeys,
    generation: number | undefined,
    snapshot?: Promise<CachedSnapshot | null>,
  ): Promise<OpenedEntry[]> {
    let t = performance.now();
    const fromSnapshot = await this.#openFromSnapshot(keys, generation, snapshot);
    if (fromSnapshot !== null) {
      span("snapshot", t);
      return fromSnapshot;
    }
    const records = await this.#cache.listRecords(this.projectId);
    t = span("cache-read", t);
    const opened = await openMany(
      keys,
      records.flatMap((r) => (r.ciphertext === null ? [] : [{ id: r.id, ciphertext: r.ciphertext }])),
    );
    span("decrypt", t);
    return records.map((r): OpenedEntry => {
      if (r.ciphertext === null) return [r.id, r.revision, "tombstone"];
      const plain = opened.get(r.id) ?? null;
      return plain === null ? [r.id, r.revision, "damaged"] : [r.id, r.revision, "open", plain];
    });
  }

  /**
   * Puts opened entries in memory. Records in `keep` (with a local change waiting) only get their revision: their
   * in-memory version is the local one. Returns the records that were opened, for `#emitRemote`.
   */
  #loadEntries(entries: readonly OpenedEntry[], keep: ReadonlySet<string>): PlainRecord[] {
    const opened: PlainRecord[] = [];
    for (const entry of entries) {
      const [id, revision, state] = entry;
      this.#known.set(id, revision);
      if (keep.has(id)) continue;
      if (state === "tombstone") {
        this.#tombstones.add(id);
        this.#damaged.delete(id);
      } else if (state === "damaged") this.#damaged.add(id);
      else {
        const plain = entry[3];
        this.#tombstones.delete(id);
        this.#damaged.delete(id);
        this.#refs.set(id, { kind: plain.kind, id: plain.id });
        this.#plain.set(recordKey(plain.kind, plain.id), plain);
        opened.push(plain);
      }
    }
    return opened;
  }

  /**
   * The project as this device's snapshot holds it, plus the records written after the snapshot (opened one by
   * one). Null when there is no usable snapshot: none yet, an older cache, or one that does not open (then it is
   * dropped and the records are opened as before).
   */
  async #openFromSnapshot(
    keys: ProjectKeys,
    generation: number | undefined,
    prefetched?: Promise<CachedSnapshot | null>,
  ): Promise<OpenedEntry[] | null> {
    this.#snapshotGeneration = null;
    this.#snapshotStale = 0;
    if (generation === undefined) return null;
    let t = performance.now();
    const snapshot = await (prefetched ?? this.#cache.getSnapshot(this.projectId).catch(() => null));
    if (snapshot === null || snapshot.generation > generation) return null;
    t = span("snapshot:read", t);
    let entries: OpenedEntry[];
    try {
      const plaintext = await keys.openSnapshot(snapshot.sealed, snapshot.generation);
      t = span("snapshot:decrypt", t);
      try {
        const text = fromUtf8(plaintext);
        t = span("snapshot:decode", t);
        entries = JSON.parse(text) as OpenedEntry[];
        t = span("snapshot:parse", t);
      } finally {
        wipe(plaintext);
      }
      if (!Array.isArray(entries)) throw new Error("not a snapshot");
    } catch {
      await this.#cache.removeSnapshot(this.projectId).catch(() => undefined);
      return null;
    }
    // The usual case: nothing was written after the snapshot, and the cache says so without a query.
    const after =
      snapshot.generation === generation ? [] : await this.#cache.listRecordsSince(this.projectId, snapshot.generation);
    span("snapshot:after", t);
    if (after.length > 0) {
      const byId = new Map<string, OpenedEntry>(entries.map((entry) => [entry[0], entry]));
      const sealed = after.flatMap((r) => (r.ciphertext === null ? [] : [{ id: r.id, ciphertext: r.ciphertext }]));
      const opened = await openMany(keys, sealed);
      for (const row of after) {
        if (row.ciphertext === null) byId.set(row.id, [row.id, row.revision, "tombstone"]);
        else {
          const plain = opened.get(row.id) ?? null;
          byId.set(row.id, plain === null ? [row.id, row.revision, "damaged"] : [row.id, row.revision, "open", plain]);
        }
      }
      entries = [...byId.values()];
    }
    this.#snapshotGeneration = snapshot.generation;
    this.#snapshotStale = after.length;
    return entries;
  }

  /** Rewrites the device snapshot a moment after enough records changed (or when a big project has none). */
  #scheduleSnapshot(): void {
    const rule = this.#snapshotRule;
    if (this.#keys === null || this.#known.size < rule.minRecords || this.#snapshotTimer !== null) return;
    if (this.#snapshotGeneration !== null && this.#snapshotStale < rule.stale) return;
    const generation = this.#generation;
    this.#snapshotTimer = this.#timers.setTimeout(() => {
      this.#snapshotTimer = null;
      if (generation === this.#generation) void this.#writeSnapshot(generation).catch(() => undefined);
    }, rule.delayMs);
  }

  /**
   * Seals what this tab holds as the device snapshot. Only while memory and the cache say the same: nothing
   * pending, being staged or in conflict, and no page or push being applied (the queue is held meanwhile).
   * Otherwise it waits for the next chance.
   */
  async #writeSnapshot(generation: number): Promise<void> {
    const keys = this.#keys;
    if (keys === null) return;
    const built = await this.#exclusive(async () => {
      const row = await this.#cache.getProject(this.projectId);
      if (generation !== this.#generation || this.#keys !== keys) return null;
      if (this.#pending.size > 0 || this.#unstaged > 0 || this.#conflicts.size > 0) return null;
      const entries: OpenedEntry[] = [];
      for (const [id, revision] of this.#known) {
        if (this.#tombstones.has(id)) entries.push([id, revision, "tombstone"]);
        else if (this.#damaged.has(id)) entries.push([id, revision, "damaged"]);
        else {
          const ref = this.#refs.get(id);
          const plain = ref ? this.#plain.get(recordKey(ref.kind, ref.id)) : undefined;
          if (plain === undefined) return null; // not what the cache holds: leave it for later
          entries.push([id, revision, "open", plain]);
        }
      }
      return { generation: row?.generation ?? 0, text: JSON.stringify(entries) };
    });
    if (built === null) {
      this.#scheduleSnapshot();
      return;
    }
    const plaintext = utf8(built.text);
    let sealed: Uint8Array;
    try {
      sealed = await keys.sealSnapshot(plaintext, built.generation, this.#random);
    } finally {
      wipe(plaintext);
    }
    if (generation !== this.#generation) return;
    if (await this.#cache.putSnapshot({ projectId: this.projectId, generation: built.generation, sealed })) {
      this.#snapshotGeneration = built.generation;
      this.#snapshotStale = 0;
    }
  }

  /** After unlocking: refresh the name, pull, then try to become the editor. */
  async #connect(): Promise<void> {
    const generation = this.#generation;
    try {
      await this.#refreshName();
      if (generation !== this.#generation) return;
      this.#wantPull = true;
      await this.#runSync();
      if (generation !== this.#generation || this.#mode === "edit") return;
      await this.#acquire(false);
      await this.#syncRun;
    } catch (error) {
      this.#failed(error);
    }
  }

  async #refreshName(): Promise<void> {
    const summaries = await this.#backend.listProjects();
    this.#online = true;
    const summary = summaries.find((project) => project.projectId === this.projectId);
    if (summary === undefined) throw new BackendError("forbidden");
    if (summary.sealedName !== this.#sealedName && this.#keys !== null) {
      this.#sealedName = summary.sealedName;
      await this.#cache.updateProject(this.projectId, { sealedName: summary.sealedName });
      try {
        this.#name = await this.#keys.openName(summary.sealedName);
      } catch {
        this.#name = null;
      }
    }
  }

  async rename(name: string): Promise<void> {
    const keys = this.#requireUnlocked();
    const sealed = await keys.sealName(name, this.#random);
    try {
      await this.#backend.renameProject(this.projectId, sealed);
    } catch (error) {
      if (isOffline(error)) throw new VaultError("offline");
      throw error;
    }
    await this.#cache.updateProject(this.projectId, { sealedName: sealed });
    this.#sealedName = sealed;
    this.#name = name;
    this.#update();
  }

  #isEditor(): boolean {
    return this.#mode === "edit";
  }

  #requireUnlocked(): ProjectKeys {
    if (this.#keys === null || this.#locking) throw new VaultError("locked");
    return this.#keys;
  }

  #requireEditable(): ProjectKeys {
    const keys = this.#requireUnlocked();
    if (this.#mode === "readOnly") throw new VaultError("read_only");
    return keys;
  }

  // ---------------------------------------------------------------- local changes

  /** Runs `work` after every earlier queued step: cache writes happen in order. */
  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Records local changes. The in-memory view changes at once; the sealed changes are in
   * IndexedDB when the promise resolves, and are pushed shortly after.
   */
  stage(upserts: readonly PlainRecord[], deletes: readonly RecordRef[] = []): Promise<void> {
    const keys = this.#requireEditable();
    const generation = this.#generation;
    for (const record of upserts) this.#plain.set(recordKey(record.kind, record.id), record);
    for (const ref of deletes) this.#plain.delete(recordKey(ref.kind, ref.id));
    // Memory already has the change and `#pending` does not yet: no device snapshot may be taken meanwhile.
    this.#unstaged += 1;
    const work = this.#exclusive(async () => {
      const changes = new Map<string, PendingChange>();
      const dropped: string[] = [];
      const base = (id: string): number => this.#pending.get(id)?.baseRevision ?? this.#known.get(id) ?? 0;
      // Sealed a batch at a time (a big import or the first sync stages thousands of records).
      for (let at = 0; at < upserts.length; at += OPEN_BATCH) {
        const batch = upserts.slice(at, at + OPEN_BATCH);
        const sealedBatch = await Promise.all(batch.map((record) => keys.sealRecord(record, this.#random)));
        batch.forEach((record, k) => {
          const sealed = sealedBatch[k]!;
          this.#refs.set(sealed.id, { kind: record.kind, id: record.id });
          changes.set(sealed.id, {
            projectId: this.projectId,
            id: sealed.id,
            baseRevision: base(sealed.id),
            ciphertext: sealed.ciphertext,
            seq: randomId(this.#random),
          });
        });
      }
      for (const ref of deletes) {
        const id = await keys.opaqueId(ref.kind, ref.id);
        this.#refs.set(id, { kind: ref.kind, id: ref.id });
        const known = this.#known.get(id);
        if ((known === undefined || this.#tombstones.has(id)) && !this.#inFlight.has(id)) {
          // Never reached the server (or already deleted there): just forget the local change.
          // A record being pushed right now does reach it, so its deletion must follow.
          changes.delete(id);
          if (this.#pending.has(id)) {
            dropped.push(id);
            // Out of the queue now, not after the cache write: a push starting meanwhile must not send it.
            this.#pending.delete(id);
          }
          continue;
        }
        changes.set(id, {
          projectId: this.projectId,
          id,
          baseRevision: base(id),
          ciphertext: null,
          seq: randomId(this.#random),
        });
      }
      await this.#cache.stage([...changes.values()]);
      if (dropped.length > 0) await this.#cache.removePending(this.projectId, dropped);
      if (generation !== this.#generation) return;
      for (const change of changes.values()) {
        this.#pending.set(change.id, change);
        const conflict = this.#conflicts.get(change.id);
        if (conflict) {
          const local = change.ciphertext === null ? null : (this.#plain.get(conflict.key) ?? null);
          this.#conflicts.set(change.id, { ...conflict, local });
          this.#conflictsChanged();
        }
      }
      for (const id of dropped) this.#pending.delete(id);
    }).finally(() => {
      this.#unstaged -= 1;
    });
    return work.then(() => {
      if (generation !== this.#generation) return;
      this.#update();
      this.#schedulePush();
    });
  }

  /** Decides a conflict: keep this tab's version (overwrite the server's) or take the server's. */
  async resolveConflict(key: string, choice: "keepLocal" | "keepRemote"): Promise<void> {
    this.#requireEditable();
    const conflict = [...this.#conflicts.values()].find((item) => item.key === key);
    if (conflict === undefined) return;
    const generation = this.#generation;
    await this.#exclusive(async () => {
      const pending = this.#pending.get(conflict.opaqueId);
      if (choice === "keepLocal" && pending) {
        const rebased = { ...pending, baseRevision: conflict.remoteRevision, seq: randomId(this.#random) };
        await this.#cache.stage([rebased]);
        if (generation !== this.#generation) return;
        this.#pending.set(conflict.opaqueId, rebased);
      } else {
        await this.#cache.removePending(this.projectId, [conflict.opaqueId]);
        if (generation !== this.#generation) return;
        this.#pending.delete(conflict.opaqueId);
        if (conflict.remote === null) this.#plain.delete(conflict.key);
        else this.#plain.set(conflict.key, conflict.remote);
        this.#emitRemote(
          conflict.remote === null
            ? { upserts: [], deletes: [{ kind: conflict.kind, id: conflict.id }] }
            : { upserts: [conflict.remote], deletes: [] },
        );
      }
      this.#conflicts.delete(conflict.opaqueId);
      this.#conflictsChanged();
    });
    this.#update();
    this.#schedulePush(0);
  }

  #emitRemote(change: RemoteChange): void {
    if (change.upserts.length === 0 && change.deletes.length === 0) return;
    for (const listener of [...this.#remoteListeners]) listener(change);
  }

  // ---------------------------------------------------------------- sync

  /** Pulls and pushes now; resolves when this round is over (errors become state, not rejections). */
  async syncNow(): Promise<void> {
    if (!this.unlocked) return;
    this.#wantPull = true;
    this.#wantPush = true;
    if (this.#mode === "none") {
      await this.#acquire(false).catch((error: unknown) => this.#failed(error));
    }
    await this.#runSync();
  }

  #schedulePush(delay = this.#pushDelayMs): void {
    if (!this.unlocked || this.#pending.size === 0 || this.#pushTimer !== null) return;
    this.#pushTimer = this.#timers.setTimeout(() => {
      this.#pushTimer = null;
      this.#wantPush = true;
      void this.#runSync();
    }, delay);
  }

  #runSync(): Promise<void> {
    if (this.#syncRun !== null) return this.#syncRun;
    const generation = this.#generation;
    const run = (async () => {
      this.#syncing = true;
      this.#update();
      try {
        while ((this.#wantPull || this.#wantPush || this.#needPull) && generation === this.#generation) {
          if (this.#wantPull || this.#needPull) {
            this.#wantPull = false;
            await this.#pullAll(generation);
            this.#needPull = false;
          }
          if (this.#wantPush) {
            this.#wantPush = false;
            await this.#pushAll(generation);
          }
        }
      } catch (error) {
        if (generation === this.#generation) this.#failed(error);
      } finally {
        this.#syncing = false;
        this.#syncRun = null;
        this.#update();
        if (generation === this.#generation) this.#scheduleSnapshot();
      }
    })();
    this.#syncRun = run;
    return run;
  }

  /** Turns a failure into state and a retry; never loses or resends changes blindly. */
  #failed(error: unknown): void {
    if (!this.unlocked) return;
    if (isOffline(error)) {
      this.#online = false;
      this.#needPull = true;
      this.#scheduleRetry();
    } else if (isLeaseError(error)) {
      this.#leaseLost();
    } else if (error instanceof BackendError) {
      this.#lastError = error.code;
      if (error.code !== "forbidden" && error.code !== "unauthorized") this.#scheduleRetry();
    } else {
      this.#lastError = "internal";
      this.#scheduleRetry();
    }
    this.#update();
  }

  #scheduleRetry(): void {
    if (this.#retryTimer !== null || !this.unlocked) return;
    this.#retryTimer = this.#timers.setTimeout(() => {
      this.#retryTimer = null;
      void this.syncNow();
    }, this.#retryMs);
  }

  async #pullAll(generation: number): Promise<void> {
    // Nothing of the project in memory yet (a device that never opened it): pages are only stored, sealed as
    // they come, and opened together at the end. A page that touches a local change goes the
    // usual way (it may be a conflict), after what was stored so far is loaded.
    let fresh = this.#known.size === 0;
    let stored = 0;
    for (;;) {
      const size = fresh ? Math.max(this.#pageSize, LIMITS.maxPullLimit) : this.#pageSize;
      const page = await this.#backend.pull(this.projectId, this.#cursor, size);
      if (generation !== this.#generation) return;
      this.#online = true;
      if (fresh && page.revision >= this.#cursor && !page.records.some((r) => this.#pending.has(r.id))) {
        await this.#exclusive(async () => {
          if (generation !== this.#generation) return;
          await this.#cache.applyPull(this.projectId, page.records, page.revision, []);
          this.#snapshotStale += page.records.length;
          this.#cursor = page.revision;
        });
        stored += page.records.length;
      } else {
        if (stored > 0) await this.#exclusive(() => this.#loadStored(generation));
        stored = 0;
        fresh = false;
        await this.#exclusive(() => this.#applyPage(page, generation));
      }
      if (!page.more) break;
    }
    if (stored > 0) await this.#exclusive(() => this.#loadStored(generation));
    if (this.#lastError !== null && this.#lastError !== "server_behind") this.#lastError = null;
  }

  /** Opens what `#pullAll` stored without opening (a first download) and tells the listeners. */
  async #loadStored(generation: number): Promise<void> {
    const keys = this.#keys;
    if (keys === null || generation !== this.#generation) return;
    const t = performance.now();
    const entries = await this.#readCachedEntries(keys, undefined);
    if (generation !== this.#generation || this.#keys !== keys) return;
    const upserts = this.#loadEntries(entries, new Set(this.#pending.keys()));
    span("first-download-open", t);
    this.#damagedChanged();
    this.#update();
    if (upserts.length > 0) this.#emitRemote({ upserts, deletes: [] });
  }

  async #applyPage(page: PullResult, generation: number): Promise<void> {
    const keys = this.#keys;
    if (keys === null || generation !== this.#generation) return;
    if (page.revision < this.#cursor) {
      // The server is behind what this device already saw (restored from an old backup, or
      // withholding changes). Never move backwards silently: keep the local copy and say so.
      this.#lastError = "server_behind";
      this.#update();
      return;
    }
    const acknowledged: string[] = [];
    const upserts: PlainRecord[] = [];
    const deletes: RecordRef[] = [];
    const plainChanges: (() => void)[] = [];
    let conflictsChanged = false;
    // The records nobody is editing here are opened together, a batch at a time.
    const preopened = await openMany(
      keys,
      page.records.flatMap((r) =>
        r.ciphertext !== null && r.revision > (this.#known.get(r.id) ?? 0) && !this.#pending.has(r.id)
          ? [{ id: r.id, ciphertext: r.ciphertext }]
          : [],
      ),
    );
    for (const record of page.records) {
      const known = this.#known.get(record.id) ?? 0;
      const pending = this.#pending.get(record.id);
      if (record.revision <= known) continue;
      if (pending !== undefined) {
        if (pending.ciphertext === record.ciphertext) {
          acknowledged.push(record.id);
        } else if (record.revision > pending.baseRevision) {
          const ref = this.#refs.get(record.id);
          let remote: PlainRecord | null = null;
          if (record.ciphertext !== null) {
            try {
              remote = await keys.openRecord(record.id, record.ciphertext);
            } catch {
              this.#damaged.add(record.id);
            }
          }
          const kind = ref?.kind ?? remote?.kind ?? "";
          const id = ref?.id ?? remote?.id ?? "";
          const key = recordKey(kind, id);
          this.#conflicts.set(record.id, {
            key,
            kind,
            id,
            opaqueId: record.id,
            local: pending.ciphertext === null ? null : (this.#plain.get(key) ?? null),
            remote,
            remoteRevision: record.revision,
          });
          conflictsChanged = true;
        }
        continue;
      }
      if (record.ciphertext === null) {
        const ref = this.#refs.get(record.id);
        if (ref) {
          plainChanges.push(() => this.#plain.delete(recordKey(ref.kind, ref.id)));
          deletes.push(ref);
        }
        continue;
      }
      const plain = preopened.get(record.id) ?? null;
      if (plain !== null) {
        this.#refs.set(record.id, { kind: plain.kind, id: plain.id });
        plainChanges.push(() => this.#plain.set(recordKey(plain.kind, plain.id), plain));
        upserts.push(plain);
        this.#damaged.delete(record.id);
      } else {
        this.#damaged.add(record.id);
      }
    }
    await this.#cache.applyPull(this.projectId, page.records, page.revision, acknowledged);
    this.#snapshotStale += page.records.length;
    if (generation !== this.#generation) return;
    for (const record of page.records) {
      if (record.revision > (this.#known.get(record.id) ?? 0)) this.#known.set(record.id, record.revision);
      if (record.ciphertext === null) this.#tombstones.add(record.id);
      else this.#tombstones.delete(record.id);
    }
    for (const id of acknowledged) {
      this.#pending.delete(id);
      if (this.#conflicts.delete(id)) conflictsChanged = true;
    }
    for (const change of plainChanges) change();
    this.#cursor = page.revision;
    if (conflictsChanged) this.#conflictsChanged();
    this.#damagedChanged();
    this.#update();
    this.#emitRemote({ upserts, deletes });
  }

  #nextBatch(): PendingChange[] {
    const batch: PendingChange[] = [];
    let size = 0;
    for (const change of this.#pending.values()) {
      if (this.#conflicts.has(change.id)) continue;
      const length = change.ciphertext?.length ?? 0;
      if (batch.length >= LIMITS.maxPushRecords || size + length > LIMITS.maxPushCiphertext) break;
      batch.push(change);
      size += length;
    }
    return batch;
  }

  async #pushAll(generation: number): Promise<void> {
    for (;;) {
      if (generation !== this.#generation || this.#mode !== "edit" || this.#lease === null) return;
      if (this.#needPull) {
        await this.#pullAll(generation);
        this.#needPull = false;
      }
      const batch = this.#nextBatch();
      if (batch.length === 0) return;
      let result;
      for (const change of batch) this.#inFlight.add(change.id);
      try {
        result = await this.#backend.push(
          this.projectId,
          this.#lease.leaseId,
          batch.map((change) => ({ id: change.id, baseRevision: change.baseRevision, ciphertext: change.ciphertext })),
        );
      } catch (error) {
        if (isLeaseError(error)) {
          // Expired or taken over: try to get it back (free again), else become read-only.
          this.#lease = null;
          this.#mode = "none";
          this.#clearTimer("renew");
          await this.#acquire(false);
          if (generation !== this.#generation || !this.#isEditor()) return;
          continue;
        }
        // The push may or may not have been applied: learn it from the server before resending.
        if (isOffline(error) || !(error instanceof BackendError)) this.#needPull = true;
        for (const change of batch) this.#inFlight.delete(change.id);
        throw error;
      }
      // Still "in flight" until the answer is recorded below: a deletion queued before that record
      // must not believe the record never reached the server.
      try {
        await this.#afterPush(batch, result, generation);
      } finally {
        for (const change of batch) this.#inFlight.delete(change.id);
      }
    }
  }

  async #afterPush(batch: readonly PendingChange[], result: PushResult, generation: number): Promise<void> {
    {
      if (generation !== this.#generation) return;
      this.#online = true;
      if (result.ok) {
        const revision = result.revision;
        await this.#exclusive(async () => {
          const cursor = revision === this.#cursor + 1 ? revision : null;
          await this.#cache.commitPush(
            this.projectId,
            batch.map((change) => ({ id: change.id, seq: change.seq, ciphertext: change.ciphertext })),
            revision,
            cursor,
          );
          this.#snapshotStale += batch.length;
          if (generation !== this.#generation) return;
          for (const change of batch) {
            const current = this.#pending.get(change.id);
            if (current?.seq === change.seq) this.#pending.delete(change.id);
            else if (current) this.#pending.set(change.id, { ...current, baseRevision: revision });
            this.#known.set(change.id, revision);
            if (change.ciphertext === null) this.#tombstones.add(change.id);
            else this.#tombstones.delete(change.id);
          }
          if (cursor !== null) this.#cursor = cursor;
        });
        this.#update();
      } else {
        // Someone else wrote these records: the pull lists them as conflicts.
        await this.#pullAll(generation);
        const unresolved = result.conflicts.filter((id) => this.#pending.has(id) && !this.#conflicts.has(id));
        if (unresolved.length > 0) {
          await this.#exclusive(() => this.#markConflicts(unresolved, generation));
          this.#update();
        }
      }
    }
  }

  /**
   * Conflicts the pull could not explain: the server refused a base revision that it does not
   * have (for example after being restored from an older backup). The server's version is the one
   * in the cache.
   */
  async #markConflicts(ids: readonly string[], generation: number): Promise<void> {
    const keys = this.#keys;
    if (keys === null || generation !== this.#generation) return;
    for (const id of ids) {
      const cached = await this.#cache.getRecord(this.projectId, id);
      let remote: PlainRecord | null = null;
      if (cached?.ciphertext) {
        try {
          remote = await keys.openRecord(id, cached.ciphertext);
        } catch {
          this.#damaged.add(id);
        }
      }
      const ref = this.#refs.get(id);
      const key = ref ? recordKey(ref.kind, ref.id) : "";
      const pending = this.#pending.get(id);
      this.#conflicts.set(id, {
        key,
        kind: ref?.kind ?? "",
        id: ref?.id ?? "",
        opaqueId: id,
        local: pending?.ciphertext === null ? null : (this.#plain.get(key) ?? null),
        remote,
        remoteRevision: cached?.revision ?? this.#known.get(id) ?? 0,
      });
    }
    this.#conflictsChanged();
    this.#damagedChanged();
  }

  /** While locked: send what is already sealed (no key needed), then release the lease. */
  async #flushLocked(lease: EditLease): Promise<void> {
    try {
      const cached = await this.#cache.getProject(this.projectId);
      let cursor = cached?.cursor ?? 0;
      const pending = await this.#cache.listPending(this.projectId);
      for (let start = 0; start < pending.length; start += LIMITS.maxPushRecords) {
        if (this.#keys !== null) return;
        const batch = pending.slice(start, start + LIMITS.maxPushRecords);
        const result = await this.#backend.push(
          this.projectId,
          lease.leaseId,
          batch.map((change) => ({ id: change.id, baseRevision: change.baseRevision, ciphertext: change.ciphertext })),
        );
        if (!result.ok) break;
        const next = result.revision === cursor + 1 ? result.revision : null;
        await this.#cache.commitPush(
          this.projectId,
          batch.map((change) => ({ id: change.id, seq: change.seq, ciphertext: change.ciphertext })),
          result.revision,
          next,
        );
        if (next !== null) cursor = next;
      }
    } catch {
      // Left for the next unlock: the changes stay sealed in IndexedDB.
    }
    if (this.#keys === null) {
      await this.#backend.releaseEditLease(this.projectId, lease.leaseId).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- edit lease

  /** Becomes the editor even if someone else is: their next write fails and they turn read-only. */
  async takeOver(): Promise<void> {
    this.#requireUnlocked();
    await this.#acquire(true);
    await this.#runSync();
  }

  async #acquire(takeOver: boolean): Promise<void> {
    const generation = this.#generation;
    let lease: EditLease;
    try {
      lease = await this.#backend.acquireEditLease(this.projectId, this.holder, takeOver);
    } catch (error) {
      if (generation !== this.#generation) return;
      if (error instanceof BackendError && error.code === "lease_held") {
        this.#online = true;
        this.#mode = "readOnly";
        this.#lease = null;
        this.#heldBy = await this.#backend.currentLease(this.projectId).catch(() => null);
        this.#clearTimer("renew");
        this.#schedulePoll();
        this.#update();
        return;
      }
      throw error;
    }
    if (generation !== this.#generation) {
      await this.#backend.releaseEditLease(this.projectId, lease.leaseId).catch(() => undefined);
      return;
    }
    this.#online = true;
    this.#lease = lease;
    this.#heldBy = null;
    this.#mode = "edit";
    this.#clearTimer("poll");
    this.#scheduleRenew();
    this.#wantPull = true;
    this.#wantPush = this.#pending.size > 0;
    this.#update();
    void this.#runSync();
  }

  #scheduleRenew(delay = LEASE_MS / 3): void {
    this.#clearTimer("renew");
    this.#renewTimer = this.#timers.setTimeout(() => {
      this.#renewTimer = null;
      void this.#renew();
    }, delay);
  }

  async #renew(): Promise<void> {
    const lease = this.#lease;
    const generation = this.#generation;
    if (lease === null || !this.unlocked) return;
    try {
      const renewed = await this.#backend.renewEditLease(this.projectId, lease.leaseId);
      if (generation !== this.#generation || this.#lease?.leaseId !== lease.leaseId) return;
      this.#lease = renewed;
      this.#online = true;
      this.#scheduleRenew();
      this.#update();
    } catch (error) {
      if (generation !== this.#generation) return;
      if (isOffline(error)) {
        this.#online = false;
        this.#scheduleRenew(Math.min(this.#retryMs, LEASE_MS / 6));
        this.#update();
      } else {
        this.#failed(error);
      }
    }
  }

  /** The lease expired or was taken over: become read-only unless it is free again. */
  #leaseLost(): void {
    this.#lease = null;
    this.#mode = "none";
    this.#clearTimer("renew");
    this.#update();
    void this.#acquire(false).catch((error: unknown) => this.#failed(error));
  }

  #schedulePoll(): void {
    this.#clearTimer("poll");
    this.#pollTimer = this.#timers.setTimeout(() => {
      this.#pollTimer = null;
      void this.#poll();
    }, this.#pollMs);
  }

  async #poll(): Promise<void> {
    if (!this.unlocked || this.#mode !== "readOnly") return;
    const generation = this.#generation;
    this.#wantPull = true;
    await this.#runSync();
    if (generation !== this.#generation) return;
    try {
      const current = await this.#backend.currentLease(this.projectId);
      if (generation !== this.#generation) return;
      if (current === null) {
        await this.#acquire(false);
        return;
      }
      this.#heldBy = current;
      this.#update();
    } catch (error) {
      if (isOffline(error)) {
        this.#online = false;
        this.#update();
      }
    }
    if (this.#mode === "readOnly") this.#schedulePoll();
  }

  #clearTimer(which: "push" | "renew" | "poll" | "retry"): void {
    const handles = { push: this.#pushTimer, renew: this.#renewTimer, poll: this.#pollTimer, retry: this.#retryTimer };
    const handle = handles[which];
    if (handle !== null) this.#timers.clearTimeout(handle);
    if (which === "push") this.#pushTimer = null;
    else if (which === "renew") this.#renewTimer = null;
    else if (which === "poll") this.#pollTimer = null;
    else this.#retryTimer = null;
  }

  #clearTimers(): void {
    this.#clearTimer("push");
    this.#clearTimer("renew");
    this.#clearTimer("poll");
    this.#clearTimer("retry");
  }

  // ---------------------------------------------------------------- attachments

  /**
   * Encrypts and uploads an attachment (needs the lease and the network). Returns its id: a new random one,
   * or `blobId` when given (restoring a backup keeps the ids the records refer to; they are per project).
   */
  async putBlob(data: Uint8Array, blobId: string = randomId(this.#random)): Promise<string> {
    const keys = this.#requireEditable();
    const lease = this.#lease;
    if (lease === null) throw new VaultError(this.#online ? "no_lease" : "offline");
    if (!ID_PATTERN.test(blobId)) throw new TypeError("blob id must be 32 lowercase hex characters");
    const sealed = await keys.sealBlob(blobId, data, this.#random);
    try {
      await this.#backend.putBlob(this.projectId, lease.leaseId, blobId, sealed);
    } catch (error) {
      if (isOffline(error)) throw new VaultError("offline");
      if (isLeaseError(error)) {
        this.#leaseLost();
        throw new VaultError("no_lease");
      }
      throw error;
    }
    this.#blobs.put(blobId, data.slice());
    return blobId;
  }

  /** Downloads and decrypts an attachment, or takes it from the in-memory cache. Returns a copy. */
  async getBlob(blobId: string): Promise<Uint8Array> {
    const keys = this.#requireUnlocked();
    const cached = this.#blobs.get(blobId);
    if (cached !== undefined) return cached.slice();
    let sealed: Uint8Array;
    try {
      sealed = await this.#backend.getBlob(this.projectId, blobId);
    } catch (error) {
      if (isOffline(error)) throw new VaultError("offline");
      throw error;
    }
    const data = await keys.openBlob(blobId, sealed);
    if (this.unlocked && this.#keys === keys) this.#blobs.put(blobId, data.slice());
    return data;
  }

  async deleteBlob(blobId: string): Promise<void> {
    this.#requireEditable();
    const lease = this.#lease;
    if (lease === null) throw new VaultError(this.#online ? "no_lease" : "offline");
    try {
      await this.#backend.deleteBlob(this.projectId, lease.leaseId, blobId);
    } catch (error) {
      if (isOffline(error)) throw new VaultError("offline");
      if (isLeaseError(error)) {
        this.#leaseLost();
        throw new VaultError("no_lease");
      }
      throw error;
    }
    this.#blobs.delete(blobId);
  }

  /** Bytes of decrypted attachments currently held in memory. */
  get blobCacheBytes(): number {
    return this.#blobs.size;
  }
}
