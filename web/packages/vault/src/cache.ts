/**
 * The local cache in IndexedDB: ciphertext and sync metadata only (docs/19 §7).
 *
 * It lets the app open a project offline and keeps changes made offline (or not yet sent) across
 * reloads, while the project is locked. Nothing here is plaintext: records and pending changes are
 * the same sealed text the server receives, and the envelope is the server's envelope.
 *
 * Stores (database "opesvault", version 1):
 * - projects: projectId → { cursor (pull revision), envelope, sealedName }
 * - records:  [projectId, opaque id] → { revision, ciphertext | null } (the server's current version;
 *             tombstones are kept, since their revision is the base for re-creating the record)
 * - pending:  [projectId, opaque id] → { baseRevision, ciphertext | null, seq } (not yet accepted)
 */
import type { B64, Envelope, SealedRecord } from "./backend.ts";

export const CACHE_DB_NAME = "opesvault";
const CACHE_DB_VERSION = 1;

export interface CachedProject {
  readonly projectId: string;
  /** Records up to this server revision are in the cache. */
  readonly cursor: number;
  readonly envelope: Envelope | null;
  readonly sealedName: B64 | null;
}

export interface CachedRecord {
  readonly projectId: string;
  readonly id: string;
  readonly revision: number;
  /** null for a tombstone. */
  readonly ciphertext: B64 | null;
}

export interface PendingChange {
  readonly projectId: string;
  readonly id: string;
  /** The server revision this change was made on (0 for a record the server never had). */
  readonly baseRevision: number;
  /** Sealed new version; null for a delete. */
  readonly ciphertext: B64 | null;
  /** Changes on every new local edit of the record, so that a push only clears what it sent. */
  readonly seq: string;
}

/** What a successful push wrote: the pending entries it sent, by their seq. */
export interface PushedChange {
  readonly id: string;
  readonly seq: string;
  readonly ciphertext: B64 | null;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export interface CacheOpenOptions {
  /** Defaults to the browser's `indexedDB`; tests pass a `fake-indexeddb` factory. */
  readonly factory?: IDBFactory;
  /** Defaults to the browser's `IDBKeyRange`; tests pass the one from `fake-indexeddb`. */
  readonly keyRange?: typeof IDBKeyRange;
  readonly name?: string;
}

export class VaultCache {
  readonly #db: IDBDatabase;
  readonly #keyRange: typeof IDBKeyRange;

  private constructor(db: IDBDatabase, keyRange: typeof IDBKeyRange) {
    this.#db = db;
    this.#keyRange = keyRange;
  }

  /** Opens (and creates) the cache. */
  static async open(options: CacheOpenOptions = {}): Promise<VaultCache> {
    const factory = options.factory ?? globalThis.indexedDB;
    const keyRange = options.keyRange ?? globalThis.IDBKeyRange;
    if (factory === undefined || keyRange === undefined) throw new Error("IndexedDB unavailable");
    const req = factory.open(options.name ?? CACHE_DB_NAME, CACHE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "projectId" });
      if (!db.objectStoreNames.contains("records")) db.createObjectStore("records", { keyPath: ["projectId", "id"] });
      if (!db.objectStoreNames.contains("pending")) db.createObjectStore("pending", { keyPath: ["projectId", "id"] });
    };
    return new VaultCache(await request(req), keyRange);
  }

  /** Every key of one project: [projectId, string] sorts below [projectId, []] (arrays sort after strings). */
  #range(projectId: string): IDBKeyRange {
    return this.#keyRange.bound([projectId, ""], [projectId, []]);
  }

  close(): void {
    this.#db.close();
  }

  async getProject(projectId: string): Promise<CachedProject | null> {
    const tx = this.#db.transaction("projects", "readonly");
    const value = (await request(tx.objectStore("projects").get(projectId))) as CachedProject | undefined;
    return value ?? null;
  }

  async putProject(project: CachedProject): Promise<void> {
    const tx = this.#db.transaction("projects", "readwrite");
    tx.objectStore("projects").put(project);
    await done(tx);
  }

  /** Updates some fields of the project's row, creating it if needed. */
  async updateProject(projectId: string, changes: Partial<Omit<CachedProject, "projectId">>): Promise<void> {
    const tx = this.#db.transaction("projects", "readwrite");
    const store = tx.objectStore("projects");
    const current = ((await request(store.get(projectId))) as CachedProject | undefined) ?? {
      projectId,
      cursor: 0,
      envelope: null,
      sealedName: null,
    };
    store.put({ ...current, ...changes, projectId });
    await done(tx);
  }

  async listRecords(projectId: string): Promise<CachedRecord[]> {
    const tx = this.#db.transaction("records", "readonly");
    return (await request(tx.objectStore("records").getAll(this.#range(projectId)))) as CachedRecord[];
  }

  async getRecord(projectId: string, id: string): Promise<CachedRecord | null> {
    const tx = this.#db.transaction("records", "readonly");
    const value = (await request(tx.objectStore("records").get([projectId, id]))) as CachedRecord | undefined;
    return value ?? null;
  }

  async listPending(projectId: string): Promise<PendingChange[]> {
    const tx = this.#db.transaction("pending", "readonly");
    return (await request(tx.objectStore("pending").getAll(this.#range(projectId)))) as PendingChange[];
  }

  /** Writes local changes atomically: either all of them survive a reload or none does. */
  async stage(changes: readonly PendingChange[]): Promise<void> {
    const tx = this.#db.transaction("pending", "readwrite");
    const store = tx.objectStore("pending");
    for (const change of changes) store.put(change);
    await done(tx);
  }

  async removePending(projectId: string, ids: readonly string[]): Promise<void> {
    const tx = this.#db.transaction("pending", "readwrite");
    const store = tx.objectStore("pending");
    for (const id of ids) store.delete([projectId, id]);
    await done(tx);
  }

  /**
   * Stores a pulled page in one transaction: the server's records (tombstones included), pending
   * entries the page proved were already accepted, and the new cursor.
   */
  async applyPull(
    projectId: string,
    records: readonly SealedRecord[],
    cursor: number,
    acknowledged: readonly string[],
  ): Promise<void> {
    const tx = this.#db.transaction(["records", "pending", "projects"], "readwrite");
    const recordStore = tx.objectStore("records");
    for (const record of records) {
      recordStore.put({ projectId, id: record.id, revision: record.revision, ciphertext: record.ciphertext });
    }
    const pendingStore = tx.objectStore("pending");
    for (const id of acknowledged) pendingStore.delete([projectId, id]);
    const projects = tx.objectStore("projects");
    const current = (await request(projects.get(projectId))) as CachedProject | undefined;
    projects.put({ projectId, envelope: null, sealedName: null, ...current, cursor });
    await done(tx);
  }

  /**
   * Records an accepted push in one transaction. A pending entry whose seq still matches becomes
   * the cached record; one edited again meanwhile stays pending, now based on the new revision.
   */
  async commitPush(
    projectId: string,
    pushed: readonly PushedChange[],
    revision: number,
    cursor: number | null,
  ): Promise<void> {
    const tx = this.#db.transaction(["records", "pending", "projects"], "readwrite");
    const recordStore = tx.objectStore("records");
    const pendingStore = tx.objectStore("pending");
    for (const change of pushed) {
      const current = (await request(pendingStore.get([projectId, change.id]))) as PendingChange | undefined;
      if (current?.seq === change.seq) pendingStore.delete([projectId, change.id]);
      else if (current !== undefined) pendingStore.put({ ...current, baseRevision: revision });
      recordStore.put({ projectId, id: change.id, revision, ciphertext: change.ciphertext });
    }
    if (cursor !== null) {
      const projects = tx.objectStore("projects");
      const row = (await request(projects.get(projectId))) as CachedProject | undefined;
      projects.put({ projectId, envelope: null, sealedName: null, ...row, cursor });
    }
    await done(tx);
  }

  /** Removes everything cached for a project (after it is deleted or access is lost). */
  async forgetProject(projectId: string): Promise<void> {
    const tx = this.#db.transaction(["records", "pending", "projects"], "readwrite");
    tx.objectStore("records").delete(this.#range(projectId));
    tx.objectStore("pending").delete(this.#range(projectId));
    tx.objectStore("projects").delete(projectId);
    await done(tx);
  }
}
