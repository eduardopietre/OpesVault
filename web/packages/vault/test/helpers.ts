import type { KdfParams } from "@opesvault/crypto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  MemoryServer,
  ProjectVault,
  signIn,
  signUp,
  VaultCache,
  type ProjectVaultOptions,
  type SyncBackend,
  type Timers,
} from "../src/index.ts";

export const TEST_KDF: KdfParams = { algorithm: "argon2id", memoryKiB: 8192, iterations: 1, parallelism: 1 };

/** Timers that only fire when the test says so. */
export class ManualTimers implements Timers {
  #now = 1_000_000;
  #next = 1;
  readonly #due = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const handle = this.#next++;
    this.#due.set(handle, { at: this.#now + ms, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.#due.delete(handle as number);
  }

  get scheduled(): number {
    return this.#due.size;
  }

  /** Moves time forward and fires every timer that became due, in order. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      const next = [...this.#due.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (next === undefined) break;
      this.#due.delete(next[0]);
      this.#now = next[1].at;
      next[1].callback();
      await settle();
    }
    this.#now = target;
    await settle();
  }
}

/** Lets pending promises and fake IndexedDB callbacks run. */
export async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Waits (in event-loop turns, never in wall time) until `condition` holds: for work a timer
 * started in the background, whose number of turns depends on the machine's load.
 */
export async function until(condition: () => boolean, rounds = 2000): Promise<void> {
  for (let i = 0; i < rounds && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
}

/** One browser: its own IndexedDB, its own server session. */
export interface Device {
  readonly factory: IDBFactory;
  readonly cache: VaultCache;
  readonly backend: SyncBackend;
  readonly timers: ManualTimers;
  vault(projectId: string, extra?: Partial<ProjectVaultOptions>): ProjectVault;
  /** A fresh page load: a new cache connection on the same IndexedDB, a new vault object. */
  reload(): Promise<Device>;
}

export async function device(
  server: MemoryServer,
  backend: SyncBackend = server.client(),
  factory = new IDBFactory(),
): Promise<Device> {
  const cache = await VaultCache.open({ factory, keyRange: IDBKeyRange });
  const timers = new ManualTimers();
  const self: Device = {
    factory,
    cache,
    backend,
    timers,
    vault: (projectId, extra = {}) =>
      new ProjectVault({ backend, cache, projectId, timers, kdf: TEST_KDF, pushDelayMs: 100, ...extra }),
    reload: async () => {
      cache.close();
      return device(server, backend, factory);
    },
  };
  return self;
}

export async function account(backend: SyncBackend, email: string): Promise<void> {
  await signUp(backend, email, `conta de ${email}`, TEST_KDF);
}

export async function login(backend: SyncBackend, email: string): Promise<void> {
  await signIn(backend, email, `conta de ${email}`, TEST_KDF);
}

export async function createProject(
  dev: Device,
  name = "Família Teste",
  password = "senha do projeto",
): Promise<{ vault: ProjectVault; recoveryKey: string }> {
  return ProjectVault.create({
    backend: dev.backend,
    cache: dev.cache,
    timers: dev.timers,
    kdf: TEST_KDF,
    pushDelayMs: 100,
    name,
    password,
  });
}

/** A backend wrapper whose methods can be replaced one by one. */
export function intercept(backend: SyncBackend, overrides: Partial<SyncBackend>): SyncBackend {
  return new Proxy(backend, {
    get(target, property, receiver) {
      const override = (overrides as Record<string | symbol, unknown>)[property];
      if (override !== undefined) return override;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** Everything stored in an IndexedDB database, as JSON text. */
export async function dumpIndexedDb(factory: IDBFactory, name = "opesvault"): Promise<string> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const out: Record<string, unknown[]> = {};
  for (const store of Array.from(db.objectStoreNames)) {
    const tx = db.transaction(store, "readonly");
    out[store] = await new Promise<unknown[]>((resolve, reject) => {
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  db.close();
  return JSON.stringify(out);
}
