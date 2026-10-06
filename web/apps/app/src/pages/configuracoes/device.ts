/**
 * What this browser keeps for the app and whether it may erase it under pressure (docs/19 §8): the storage
 * manager's answers, behind functions so a test can stand in for the browser.
 */
import type { PersistState } from "./rows.ts";

export interface StorageInfo {
  persist: PersistState;
  /** Bytes this site uses, when the browser says. */
  usage: number | null;
  quota: number | null;
}

function manager(): StorageManager | null {
  const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage;
  return storage ?? null;
}

export async function readStorage(): Promise<StorageInfo> {
  const storage = manager();
  if (storage === null) return { persist: "unavailable", usage: null, quota: null };
  let persist: PersistState = "unavailable";
  try {
    if (typeof storage.persisted === "function") persist = (await storage.persisted()) ? "yes" : "no";
  } catch {
    persist = "unavailable";
  }
  let usage: number | null = null;
  let quota: number | null = null;
  try {
    if (typeof storage.estimate === "function") {
      const estimate = await storage.estimate();
      usage = estimate.usage ?? null;
      quota = estimate.quota ?? null;
    }
  } catch {
    // The estimate is only information.
  }
  return { persist, usage, quota };
}

/** Asks the browser not to erase this site's storage. Returns the state afterwards. */
export async function requestPersist(): Promise<PersistState> {
  const storage = manager();
  if (storage === null || typeof storage.persist !== "function") return "unavailable";
  try {
    return (await storage.persist()) ? "yes" : "no";
  } catch {
    return "unavailable";
  }
}
