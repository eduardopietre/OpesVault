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

/**
 * Schema 3 (docs/18 §10, 13/10/2026) added fields the Python never had: a recurrence's `interval_months`, a
 * budget line's `carry_over` and, in the budget status, what a line carried from the month before. The frozen
 * reference files are at schema 2, so a comparison with them drops these fields and reads schema 3 as 2. Only
 * the new fields go: everything the Python computed is still compared.
 */
const SCHEMA_3_FIELDS = new Set([
  "interval_months",
  "carry_over",
  "carried",
  "available",
  "carryOver",
  "totalCarried",
  "total_carried",
]);
const SCHEMA_FIELDS = new Set(["schema_version", "versao_esquema"]);

export function atGoldenSchema<T>(value: T): T {
  if (Array.isArray(value)) return value.map(atGoldenSchema) as T;
  if (value === null || typeof value !== "object" || value instanceof Dec) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (SCHEMA_3_FIELDS.has(key)) continue;
    out[key] = SCHEMA_FIELDS.has(key) && inner === 3 ? 2 : atGoldenSchema(inner);
  }
  return out as T;
}

/** An exported JSON file (`JSON.stringify(…, null, 1)`) as it would read at schema 2. */
export function jsonAtGoldenSchema(bytes: Uint8Array): Uint8Array {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  return new TextEncoder().encode(JSON.stringify(atGoldenSchema(parsed), null, 1));
}

export type Outcome = { ok: unknown } | { error: string };

export function outcome(fn: () => unknown): Outcome {
  try {
    return { ok: j(fn()) };
  } catch (error) {
    return { error: error instanceof Error ? error.name : "Error" };
  }
}
