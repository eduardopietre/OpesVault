/**
 * The real services without a browser: each "device" has its own fake IndexedDB and talks to the in-memory
 * reference server, with light key derivation and fast sync.
 */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { MemoryServer, VaultCache, type Timers } from "@opesvault/vault";
import { TEST_KDF } from "@opesvault/vault/testing";
import { createRealServices } from "../src/services/real.ts";

export { ManualTimers, TEST_KDF } from "@opesvault/vault/testing";

export interface DeviceOptions {
  /** The timers of the vault (sync, idle lock); real ones by default. */
  timers?: Timers;
  /** Locks after this long without use; never by default. */
  idleLockMs?: number | null;
}

/** A device signed in to `server` as `holder`: its services and the IndexedDB they keep. */
export function realDevice(server: MemoryServer, holder: string, options: DeviceOptions = {}) {
  const factory = new IDBFactory();
  const services = createRealServices({
    backend: server.client(),
    openCache: () => VaultCache.open({ factory, keyRange: IDBKeyRange }),
    holder,
    kdf: TEST_KDF,
    idleLockMs: options.idleLockMs === undefined ? null : options.idleLockMs,
    vaultOptions: { pushDelayMs: 0, pollMs: 50, ...(options.timers ? { timers: options.timers } : {}) },
  });
  return { services, factory };
}

/** The services of a new device (see `realDevice`). */
export const realServices = (server: MemoryServer, holder: string, options: DeviceOptions = {}) =>
  realDevice(server, holder, options).services;

/** Waits (polling every 10 ms) until `condition` holds; fails after `ms`. */
export async function until(condition: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
