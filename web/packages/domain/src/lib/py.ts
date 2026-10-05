/**
 * Python semantics the ports depend on and that have no JavaScript equivalent: model equality
 * (`model == other`), slicing by code point (`text[:n]`), `" ".join(text.split())` and `KeyError`
 * on a missing dict key. Not a Python module of its own.
 */
import { Dec } from "./dec.ts";

/**
 * Pydantic's `==` between two entities: field by field, decimals by value (Decimal("95") equals
 * Decimal("95.0")), tuples and nested models recursively.
 */
export function pyEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Dec || b instanceof Dec) return a instanceof Dec && b instanceof Dec && a.eq(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => pyEquals(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    const rb = b as Record<string, unknown>;
    const ra = a as Record<string, unknown>;
    return ka.every((k) => k in rb && pyEquals(ra[k], rb[k]));
  }
  return false;
}

/** `text[:n]`: the first `n` code points (JavaScript's `slice` counts UTF-16 units). */
export function head(text: string, n: number): string {
  const points = [...text];
  return points.length <= n ? text : points.slice(0, n).join("");
}

/** Python's whitespace for `str.split()`/`str.strip()` (JavaScript's `\s` differs slightly). */
// eslint-disable-next-line no-control-regex -- Python counts \x1c-\x1f as whitespace
const PY_SPACE = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;

/** `" ".join(text.split())`: words separated by single spaces, no ends. */
export function collapseSpaces(text: string): string {
  return text
    .split(PY_SPACE)
    .filter((w) => w)
    .join(" ");
}

/** Python's `KeyError` on a missing dict key (`assets(ledger)[id]`). */
export class KeyError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "KeyError";
  }
}

/** `mapping[key]` with Python's failure: a KeyError, never `undefined`. */
export function getOrKeyError<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new KeyError();
  return value;
}

const PY_STRIP_ENDS = new RegExp("^" + PY_SPACE.source + "|" + PY_SPACE.source + "$", "gu");

/** `text.strip()`: Python's whitespace, not JavaScript's. */
export function strip(text: string): string {
  return text.replace(PY_STRIP_ENDS, "");
}

/** `text.strip(chars)`: removes any of `chars` from both ends. */
export function stripChars(text: string, chars: string): string {
  const set = new Set([...chars]);
  const points = [...text];
  let a = 0;
  let b = points.length;
  while (a < b && set.has(points[a]!)) a++;
  while (b > a && set.has(points[b - 1]!)) b--;
  return points.slice(a, b).join("");
}

/**
 * `format(value, ".<places>f")` (or `"+.<places>f"` with `signed`) of a Decimal: it rounds with the
 * context's rounding, half to even, not the half-up of management figures.
 */
export function formatFixed(value: Dec, places: number, signed = false): string {
  const text = value.rescale(0 - places, "ROUND_HALF_EVEN").toFixed();
  return signed && !text.startsWith("-") ? `+${text}` : text;
}

/** Python's `float`-free `x or ZERO` for optional decimals: a missing or zero value is `fallback`. */
export function orDec(value: Dec | null | undefined, fallback: Dec): Dec {
  return value === null || value === undefined || value.isZero() ? fallback : value;
}
