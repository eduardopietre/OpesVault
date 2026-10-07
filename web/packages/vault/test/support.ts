/**
 * Test support shared with the app's and the server's tests (`@opesvault/vault/testing`): a light key
 * derivation, timers the test moves by hand and waits for background work. Never imported by production code.
 */
import type { KdfParams } from "@opesvault/crypto";
import type { Timers } from "../src/index.ts";

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
 * Waits until `condition` holds, for work started in the background (a poll, an idle lock) that ends with
 * WebCrypto and IndexedDB, whose real time depends on the machine's load. It used to count event-loop turns, but a
 * turn lasts microseconds while a decryption on the thread pool lasts as long as the CPU is busy, so under load the
 * count ran out first and the test asserted too early. The bound is a deadline that only fails a test that would
 * otherwise hang, and it fails loudly instead of returning with the condition still false.
 */
export async function until(condition: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`until: the condition did not hold within ${timeoutMs} ms`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}
