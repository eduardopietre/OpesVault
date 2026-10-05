/**
 * The JSON form of TS results as Python's `scripts/golden/common.py` `j()` writes them, so planning
 * goldens compare whole result objects: camelCase fields become snake_case (dataclass fields),
 * persisted entities (objects with an `id`) become their persisted dump (Pydantic's
 * `model_dump(mode="json")`), decimals become {"$dec": text}. Getters on class prototypes are not
 * fields, like Python properties.
 */
import { dump } from "../src/domain/model.ts";
import { Dec } from "../src/lib/dec.ts";
import { cmpStr } from "../src/lib/text.ts";

function snake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function py(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Dec) return { $dec: value.toFixed() };
  if (Array.isArray(value)) return value.map(py);
  if (value instanceof Set) return [...value].map(py);
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), py(v)]));
  if (typeof value === "object") {
    if (Object.hasOwn(value, "id")) return dump(value);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [snake(k), py(v)]));
  }
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT_KEYS = new Set(["closed_at", "at"]);

/**
 * Mirrors `anon()` of cases_planning.py: unknown ids (values and keys) become "new:<n>", instants a
 * placeholder, and
 * a set of ids ({"$ids": [...]}, see `idSet`) is sorted once anonymized.
 */
export function anon(value: unknown, known: ReadonlySet<string>, seen: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => anon(v, known, seen));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === "$ids") {
      const list = [...(record["$ids"] as string[])].sort(cmpStr);
      return list.map((v) => anon(v, known, seen) as string).sort(cmpStr);
    }
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((k) => [
          anon(k, known, seen) as string,
          INSTANT_KEYS.has(k) && typeof record[k] === "string" ? "<instant>" : anon(record[k], known, seen),
        ]),
    );
  }
  if (typeof value === "string" && UUID.test(value) && !known.has(value)) {
    if (!seen.has(value)) seen.set(value, `new:${seen.size}`);
    return seen.get(value);
  }
  return value;
}

/** Every id-looking string inside a JSON value. */
export function uuidsIn(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) uuidsIn(v, out);
  else if (value !== null && typeof value === "object") for (const v of Object.values(value)) uuidsIn(v, out);
  else if (typeof value === "string" && UUID.test(value)) out.add(value);
  return out;
}

/** A set of ids, sorted once anonymized (Python's `ids()`). */
export function idSet(values: Iterable<string>): { $ids: string[] } {
  return { $ids: [...values].sort(cmpStr) };
}
