/** Small helpers for maps built from collections: indexes, groups and running sums. */
import { DEC_ZERO, type Dec } from "./dec.ts";

/** Values by key; the first value of a key wins, as `.find` over the same order would. */
export function indexBy<K, V>(values: Iterable<V>, key: (value: V) => K): Map<K, V> {
  const out = new Map<K, V>();
  for (const value of values) {
    const k = key(value);
    if (!out.has(k)) out.set(k, value);
  }
  return out;
}

/** Values grouped by key, each group in the original order; groups in first-seen order. */
export function groupBy<K, V>(values: Iterable<V>, key: (value: V) => K): Map<K, V[]> {
  const out = new Map<K, V[]>();
  for (const value of values) pushTo(out, key(value), value);
  return out;
}

/** Appends `value` to the list at `key`, creating it on first use. */
export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/** Adds `value` to the running sum at `key` (Python's `totals[key] = totals.get(key, 0) + value`). */
export function addTo<K>(map: Map<K, Dec>, key: K, value: Dec): void {
  map.set(key, (map.get(key) ?? DEC_ZERO).add(value));
}
