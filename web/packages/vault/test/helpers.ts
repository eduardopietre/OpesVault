import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  MemoryServer,
  ProjectVault,
  signIn,
  signUp,
  VaultCache,
  type ProjectVaultOptions,
  type SyncBackend,
} from "../src/index.ts";
import { ManualTimers, TEST_KDF } from "./support.ts";

export { ManualTimers, settle, TEST_KDF, until } from "./support.ts";

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
  // Bytes (the device snapshot, attachments) are dumped as text, so plaintext inside them would show.
  return JSON.stringify(out, (_key, value: unknown) =>
    value instanceof Uint8Array ? Buffer.from(value).toString("latin1") + Buffer.from(value).toString("utf8") : value,
  );
}
