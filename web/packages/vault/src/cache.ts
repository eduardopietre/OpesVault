/**
 * The local cache in IndexedDB: ciphertext and sync metadata only (docs/19 §7).
 *
 * It lets the app open a project offline and keeps changes made offline (or not yet sent) across
 * reloads, while the project is locked. Nothing here is plaintext: records and pending changes are
 * the same sealed text the server receives, and the envelope is the server's envelope.
 *
 * Stores (database "opesvault", version 2):
 * - projects:  projectId → { cursor (pull revision), envelope, sealedName, generation }
 * - records:   [projectId, opaque id] → { revision, ciphertext | null, gen } (the server's current version;
 *              tombstones are kept, since their revision is the base for re-creating the record). `gen` is the
 *              project's generation when the row was written (index "byGen").
 * - pending:   [projectId, opaque id] → { baseRevision, ciphertext | null, seq } (not yet accepted)
 * - snapshots: projectId → { generation, sealed } — this device's snapshot: every record opened at one
 *              generation, sealed in one block with a key derived from the project key (docs/19 §8). Opening
 *              a big project decrypts it and then only the records written after it.
 *
 * The generation goes up with every transaction that writes records, so "the rows written after the
 * snapshot" is an index range. Version 1 rows have no `gen`: they are older than any snapshot.
 */
import type { B64, Envelope, SealedRecord } from "./backend.ts";

export const CACHE_DB_NAME = "opesvault";
const CACHE_DB_VERSION = 2;

export interface CachedProject {
  readonly projectId: string;
  /** Records up to this server revision are in the cache. */
  readonly cursor: number;
  readonly envelope: Envelope | null;
  readonly sealedName: B64 | null;
  /** Goes up with every write to the project's records (absent before the first one). */
  readonly generation?: number;
}

export interface CachedRecord {
  readonly projectId: string;
  readonly id: string;
  readonly revision: number;
  /** null for a tombstone. */
  readonly ciphertext: B64 | null;
  /** The project's generation when this row was written (absent in rows from cache version 1). */
  readonly gen?: number;
}

/** This device's sealed snapshot of a project (see the stores above). */
export interface CachedSnapshot {
  readonly projectId: string;
  readonly generation: number;
  readonly sealed: Uint8Array;
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
  /** The database's name. */
  readonly name: string;

  private constructor(db: IDBDatabase, keyRange: typeof IDBKeyRange, name: string) {
    this.#db = db;
    this.#keyRange = keyRange;
    this.name = name;
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
      const records = db.objectStoreNames.contains("records")
        ? req.transaction!.objectStore("records")
        : db.createObjectStore("records", { keyPath: ["projectId", "id"] });
      if (!records.indexNames.contains("byGen")) records.createIndex("byGen", ["projectId", "gen"]);
      if (!db.objectStoreNames.contains("pending")) db.createObjectStore("pending", { keyPath: ["projectId", "id"] });
      if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots", { keyPath: "projectId" });
    };
    return new VaultCache(await request(req), keyRange, options.name ?? CACHE_DB_NAME);
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

  /** Writes a project's row anew (a new project); a snapshot left from before no longer applies. */
  async putProject(project: CachedProject): Promise<void> {
    const tx = this.#db.transaction(["projects", "snapshots"], "readwrite");
    tx.objectStore("projects").put(project);
    tx.objectStore("snapshots").delete(project.projectId);
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

  /**
   * Every cached record of the project, ordered by id. Read as four slices at once (ids are hex): the
   * database reads one slice while the page copies another, which is faster than one `getAll` for the
   * tens of thousands of records of a big project.
   */
  async listRecords(projectId: string): Promise<CachedRecord[]> {
    const cuts = ["", "4", "8", "c"];
    const slices = await Promise.all(
      cuts.map((from, i) => {
        const to = cuts[i + 1];
        const range = this.#keyRange.bound(
          [projectId, from],
          to === undefined ? [projectId, []] : [projectId, to],
          false,
          true,
        );
        const tx = this.#db.transaction("records", "readonly");
        return request(tx.objectStore("records").getAll(range)) as Promise<CachedRecord[]>;
      }),
    );
    return slices.flat();
  }

  /**
   * The records whose id is in [from, to) (to = null: to the end), for reading a project in several slices
   * at once. Ids are compared as the strings they are.
   */
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
    const projects = tx.objectStore("projects");
    const current = (await request(projects.get(projectId))) as CachedProject | undefined;
    const gen = (current?.generation ?? 0) + 1;
    const recordStore = tx.objectStore("records");
    for (const record of records) {
      recordStore.put({ projectId, id: record.id, revision: record.revision, ciphertext: record.ciphertext, gen });
    }
    const pendingStore = tx.objectStore("pending");
    for (const id of acknowledged) pendingStore.delete([projectId, id]);
    projects.put({ projectId, envelope: null, sealedName: null, ...current, cursor, generation: gen });
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
    const projects = tx.objectStore("projects");
    const row = (await request(projects.get(projectId))) as CachedProject | undefined;
    const gen = (row?.generation ?? 0) + 1;
    const recordStore = tx.objectStore("records");
    const pendingStore = tx.objectStore("pending");
    for (const change of pushed) {
      const current = (await request(pendingStore.get([projectId, change.id]))) as PendingChange | undefined;
      if (current?.seq === change.seq) pendingStore.delete([projectId, change.id]);
      else if (current !== undefined) pendingStore.put({ ...current, baseRevision: revision });
      recordStore.put({ projectId, id: change.id, revision, ciphertext: change.ciphertext, gen });
    }
    projects.put({
      projectId,
      envelope: null,
      sealedName: null,
      cursor: 0,
      ...row,
      ...(cursor !== null ? { cursor } : {}),
      generation: gen,
    });
    await done(tx);
  }

  /** The rows of a project written after `generation` (those a snapshot of that generation does not hold). */
  async listRecordsSince(projectId: string, generation: number): Promise<CachedRecord[]> {
    const tx = this.#db.transaction("records", "readonly");
    const range = this.#keyRange.bound([projectId, generation + 1], [projectId, Number.MAX_SAFE_INTEGER]);
    return (await request(tx.objectStore("records").index("byGen").getAll(range))) as CachedRecord[];
  }

  async getSnapshot(projectId: string): Promise<CachedSnapshot | null> {
    const tx = this.#db.transaction("snapshots", "readonly");
    const value = (await request(tx.objectStore("snapshots").get(projectId))) as CachedSnapshot | undefined;
    return value ?? null;
  }

  /** Keeps `snapshot` unless the device already has one of a later generation. Returns whether it was kept. */
  async putSnapshot(snapshot: CachedSnapshot): Promise<boolean> {
    const tx = this.#db.transaction("snapshots", "readwrite");
    const store = tx.objectStore("snapshots");
    const current = (await request(store.get(snapshot.projectId))) as CachedSnapshot | undefined;
    const keep = current === undefined || current.generation <= snapshot.generation;
    if (keep) store.put(snapshot);
    await done(tx);
    return keep;
  }

  async removeSnapshot(projectId: string): Promise<void> {
    const tx = this.#db.transaction("snapshots", "readwrite");
    tx.objectStore("snapshots").delete(projectId);
    await done(tx);
  }

  /** Removes everything cached on this device, for every project (the "forget this device" command). */
  async forgetAll(): Promise<void> {
    const tx = this.#db.transaction(["records", "pending", "projects", "snapshots"], "readwrite");
    tx.objectStore("records").clear();
    tx.objectStore("pending").clear();
    tx.objectStore("projects").clear();
    tx.objectStore("snapshots").clear();
    await done(tx);
  }

  /** Removes everything cached for a project (after it is deleted or access is lost). */
  async forgetProject(projectId: string): Promise<void> {
    const tx = this.#db.transaction(["records", "pending", "projects", "snapshots"], "readwrite");
    tx.objectStore("records").delete(this.#range(projectId));
    tx.objectStore("pending").delete(this.#range(projectId));
    tx.objectStore("projects").delete(projectId);
    tx.objectStore("snapshots").delete(projectId);
    await done(tx);
  }
}
