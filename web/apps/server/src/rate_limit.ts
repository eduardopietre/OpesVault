/** Fixed-window counters in memory, by key (an IP or a normalized email). */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(limit: number, windowMs: number, now: () => number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  #window(key: string): { start: number; count: number } {
    const now = this.#now();
    let window = this.#windows.get(key);
    if (window === undefined || now - window.start >= this.#windowMs) {
      window = { start: now, count: 0 };
      this.#windows.set(key, window);
    }
    if (this.#windows.size > 10_000) this.#sweep(now);
    return window;
  }

  #sweep(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.#windowMs) this.#windows.delete(key);
    }
  }

  /** True if the key is already over the limit (does not count). */
  blocked(key: string): boolean {
    return this.#window(key).count >= this.#limit;
  }

  /** Counts one attempt; true if it is still within the limit. */
  hit(key: string): boolean {
    const window = this.#window(key);
    window.count += 1;
    return window.count <= this.#limit;
  }

  reset(key: string): void {
    this.#windows.delete(key);
  }
}
