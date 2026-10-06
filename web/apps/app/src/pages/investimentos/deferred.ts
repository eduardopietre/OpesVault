/**
 * Heavy calculations of a screen: computed lazily, for the selected investment only, after the screen has
 * painted (so a skeleton shows meanwhile), and kept by the ledger's version so choosing the same investment
 * again, or only resizing the window, never repeats the work. Nothing here runs in a loop over every position.
 * A calculation may return a promise (the internal rate of return runs in a Web Worker, `xirr_client.ts`).
 */
import { type Ledger } from "@opesvault/domain";
import { useEffect, useRef, useState } from "react";
import { useLedgerVersion, useWorkspace } from "../../data/react.tsx";

const LIMIT = 24;
const caches = new WeakMap<object, { version: number; entries: Map<string, unknown> }>();

function cacheOf(workspace: object, version: number): Map<string, unknown> {
  let found = caches.get(workspace);
  if (!found || found.version !== version) {
    found = { version, entries: new Map() };
    caches.set(workspace, found);
  }
  return found.entries;
}

export interface Deferred<T> {
  value: T | null;
  /** True while the calculation has not finished for the current inputs. */
  pending: boolean;
}

/**
 * `compute(ledger)` for `key` (everything it reads besides the ledger), after the next paint; `enabled` false
 * skips it. A cached result is returned at once. The calculation reads the ledger before it first awaits
 * anything: what it returns later belongs to the version it started with.
 */
export function useDeferred<T>(key: string, compute: (ledger: Ledger) => T | Promise<T>, enabled = true): Deferred<T> {
  const workspace = useWorkspace();
  const version = useLedgerVersion();
  const latest = useRef(compute);
  useEffect(() => {
    latest.current = compute;
  });
  const [done, setDone] = useState<{ version: number; key: string; value: T } | null>(null);
  const cached = enabled ? (cacheOf(workspace, version).get(key) as T | undefined) : undefined;

  useEffect(() => {
    if (!enabled || cacheOf(workspace, version).has(key)) return;
    let live = true;
    // after the paint: a timeout runs once the browser has had the chance to draw the skeleton
    const handle = setTimeout(() => {
      void Promise.resolve(latest.current(workspace.ledger)).then((value) => {
        const entries = cacheOf(workspace, version);
        if (entries.size >= LIMIT) entries.delete(entries.keys().next().value as string);
        entries.set(key, value);
        if (live) setDone({ version, key, value });
      });
    }, 0);
    return () => {
      live = false;
      clearTimeout(handle);
    };
  }, [workspace, version, key, enabled]);

  if (!enabled) return { value: null, pending: false };
  if (cached !== undefined) return { value: cached, pending: false };
  if (done && done.version === version && done.key === key) return { value: done.value, pending: false };
  return { value: null, pending: true };
}
