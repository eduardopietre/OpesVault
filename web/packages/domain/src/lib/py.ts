/**
 * Python semantics the ports depend on and that have no JavaScript equivalent: model equality
 * (`model == other`), whitespace, lengths and slices by code point (`text[:n]`),
 * `" ".join(text.split())` and `KeyError` on a missing dict key. Not a Python module of its own.
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

// ── Python string semantics ─────────────────────────

/**
 * Characters Python's `str.isspace()`, `str.strip()`, `str.split()` and `re`'s `\s` treat as
 * whitespace (JavaScript's `\s` differs slightly: Python counts \x1c-\x1f), as regex class text.
 */
export const PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_CLASS = new RegExp(`[${PY_WS}]`, "u");
const WS_RUNS = new RegExp(`[${PY_WS}]+`, "gu");

function isPySpace(ch: string): boolean {
  return WS_CLASS.test(ch);
}

/** `str.strip()` with no argument (Python's whitespace), or `str.strip(chars)`. */
export function pyStrip(text: string, chars: string | null = null): string {
  const strip = chars === null ? (c: string) => isPySpace(c) : (c: string) => chars.includes(c);
  const units = [...text];
  let start = 0;
  let end = units.length;
  while (start < end && strip(units[start]!)) start++;
  while (end > start && strip(units[end - 1]!)) end--;
  return units.slice(start, end).join("");
}

/** `str.split()` with no argument. */
export function pySplit(text: string): string[] {
  return text.split(WS_RUNS).filter((w) => w !== "");
}

/** `" ".join(text.split())`: words separated by single spaces, no ends. */
export function collapseSpaces(text: string): string {
  return pySplit(text).join(" ");
}

/** Python's length and slices count code points, not UTF-16 units. */
export function pyLen(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** `text[:limit]` in code points, without splitting the whole text when it is already short. */
export function pyHead(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let out = "";
  let n = 0;
  for (const ch of text) {
    if (n === limit) break;
    out += ch;
    n++;
  }
  return out;
}

/** `text[:n]` (the golden tests' name for `pyHead`). */
export const head = pyHead;

/** Python's `str.capitalize()`: the first character upper case, the rest lower case. */
export function capitalize(text: string): string {
  const [first = "", ...rest] = [...text];
  return first.toUpperCase() + rest.join("").toLowerCase();
}

// ── dicts ───────────────────────────────────────────

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

// ── decimals ────────────────────────────────────────

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
