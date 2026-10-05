/** Time and timers, injectable so that tests drive the sync engine without real waiting. */
export interface Timers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/**
 * Calls `onIdle` after `timeoutMs` without `touch()`. Used for the idle lock (docs/19 §9):
 * the app touches it on user activity (see `watchActivity`).
 */
export class IdleTimer {
  readonly #timeoutMs: number;
  readonly #onIdle: () => void;
  readonly #timers: Timers;
  #handle: unknown = null;

  constructor(timeoutMs: number, onIdle: () => void, timers: Timers = systemTimers) {
    this.#timeoutMs = timeoutMs;
    this.#onIdle = onIdle;
    this.#timers = timers;
  }

  touch(): void {
    this.stop();
    this.#handle = this.#timers.setTimeout(() => {
      this.#handle = null;
      this.#onIdle();
    }, this.#timeoutMs);
  }

  stop(): void {
    if (this.#handle !== null) this.#timers.clearTimeout(this.#handle);
    this.#handle = null;
  }

  get running(): boolean {
    return this.#handle !== null;
  }
}

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/** Touches `timer` on user activity in `target` (usually `window`). Returns the unsubscribe function. */
export function watchActivity(target: EventTarget, touch: () => void): () => void {
  for (const name of ACTIVITY_EVENTS) target.addEventListener(name, touch, { passive: true });
  return () => {
    for (const name of ACTIVITY_EVENTS) target.removeEventListener(name, touch);
  };
}
