/** Loads the reference files written by scripts/golden (docs/18 §4). */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Dec } from "../src/lib/dec.ts";

export function golden<T = unknown>(name: string): T {
  const path = fileURLToPath(new URL(`../golden/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

/** The JSON form of a TS value, matching scripts/golden/common.py `j()`. */
export function j(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Dec) return { $dec: value.toFixed() };
  if (Array.isArray(value)) return value.map(j);
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), j(v)]));
  if (value instanceof Set) return [...value].map(j);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, j(v)]));
  }
  return value;
}

export type Outcome = { ok: unknown } | { error: string };

export function outcome(fn: () => unknown): Outcome {
  try {
    return { ok: j(fn()) };
  } catch (error) {
    return { error: error instanceof Error ? error.name : "Error" };
  }
}
