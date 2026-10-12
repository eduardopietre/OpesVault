/** The tab's lease label is held by one page at a time: a duplicated tab gets its own (docs/19 §9.2). */
import { describe, expect, it } from "vitest";
import { claimTabHolder } from "../src/preferences.ts";

/** Web Locks for one browser: exclusive locks by name, held until the callback's promise settles. */
function fakeLocks(): LockManager {
  const held = new Set<string>();
  const waiting = new Map<string, (() => void)[]>();
  const release = (name: string) => {
    held.delete(name);
    waiting.get(name)?.shift()?.();
  };
  const request = (async (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => {
    if (held.has(name)) {
      if (options.ifAvailable) return callback(null);
      await new Promise<void>((resolve, reject) => {
        const queue = waiting.get(name) ?? [];
        queue.push(resolve);
        waiting.set(name, queue);
        options.signal?.addEventListener("abort", () => {
          queue.splice(queue.indexOf(resolve), 1);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    held.add(name);
    try {
      return await callback({ name, mode: "exclusive" } as Lock);
    } finally {
      release(name);
    }
  }) as LockManager["request"];
  return { request, query: () => Promise.resolve({}) } as LockManager;
}

describe("the tab's lease label", () => {
  it("a reloaded tab keeps its label; a duplicated one, which inherits it, takes a new one", async () => {
    sessionStorage.clear();
    const locks = fakeLocks();
    const first = await claimTabHolder(locks, 50);
    // A duplicate of the tab: same sessionStorage, the first page still alive and holding the label.
    const duplicate = await claimTabHolder(locks, 50);
    expect(duplicate).not.toBe(first);
    expect(duplicate).toMatch(/^tab-/);
    expect(sessionStorage.getItem("opesvault:aba")).toBe(duplicate);
  });

  it("without Web Locks, the label of the tab's session", async () => {
    sessionStorage.clear();
    const label = await claimTabHolder(undefined);
    expect(await claimTabHolder(undefined)).toBe(label);
  });
});
