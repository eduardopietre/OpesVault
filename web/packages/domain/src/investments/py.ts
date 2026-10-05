/**
 * Python semantics the W5 ports depend on and that `lib/` does not have yet: model equality
 * (`model == other`), slicing by code point (`text[:n]`) and `" ".join(text.split())`.
 * Not a Python module of its own; kept beside the ports that use it.
 */
import { Dec } from "../lib/dec.ts";

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

/** Python's `str.split()` separators: JavaScript's `\s` plus the information separators and NEL. */
// eslint-disable-next-line no-control-regex -- Python treats U+001C..U+001F as whitespace
const PY_WHITESPACE = /[\s\u001c-\u001f\u0085]+/u;

/** `" ".join(text.split())`: Python's whitespace split drops empty parts. */
export function collapseSpaces(text: string): string {
  return text.split(PY_WHITESPACE).filter(Boolean).join(" ");
}
