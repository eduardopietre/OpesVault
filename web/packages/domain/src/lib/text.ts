/** String helpers with Python's semantics where the port depends on them. */

/** Python's `str.casefold()` for the cases that matter in Portuguese and common Latin text. */
export function casefold(text: string): string {
  return text.toLowerCase().replaceAll("ß", "ss").replaceAll("ς", "σ");
}

/** Python's string ordering: by code point, not by UTF-16 unit or locale. */
export function cmpStr(a: string, b: string): number {
  if (a === b) return 0;
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** Compares tuples of keys the way Python compares tuples (sort keys). */
export function cmpKeys(a: readonly unknown[], b: readonly unknown[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmpValue(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

function cmpValue(x: unknown, y: unknown): number {
  if (typeof x === "string" && typeof y === "string") return cmpStr(x, y);
  if (typeof x === "number" && typeof y === "number") return x < y ? -1 : x > y ? 1 : 0;
  if (typeof x === "boolean" && typeof y === "boolean") return Number(x) - Number(y);
  if (Array.isArray(x) && Array.isArray(y)) return cmpKeys(x, y);
  if (x && y && typeof x === "object" && typeof y === "object" && "cmp" in x && typeof x.cmp === "function") {
    return (x.cmp as (o: unknown) => number)(y);
  }
  if (x === y) return 0;
  throw new TypeError("values are not comparable");
}

/** Sorts a copy by a Python-style key (stable, like `sorted(key=..., reverse=...)`). */
export function sortedBy<T>(items: Iterable<T>, key: (item: T) => unknown, reverse = false): T[] {
  const decorated = [...items].map((item, index) => ({ item, index, k: key(item) }));
  decorated.sort((a, b) => {
    const c = Array.isArray(a.k) && Array.isArray(b.k) ? cmpKeys(a.k, b.k) : cmpKeys([a.k], [b.k]);
    // Python's reverse=True keeps equal elements in their original order.
    return c !== 0 ? (reverse ? -c : c) : a.index - b.index;
  });
  return decorated.map((d) => d.item);
}
