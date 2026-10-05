/**
 * Zod building blocks for persisted entities: the web equivalent of the desktop's Pydantic
 * models with `extra="forbid"` (objects are strict). Persisted JSON keeps the desktop's
 * shapes: decimals as fixed text, dates as ISO strings, months as {year, month}.
 */
import { z } from "zod";

// Zod compiles object parsers with `new Function`; the app's CSP forbids eval and Trusted Types
// report the attempt. The interpreted parsers measured just as fast on a 50 000-entry project.
z.config({ jitless: true });

import { Dec } from "./dec.ts";
import { type Instant, type IsoDate, isIsoDate, type YearMonth } from "./dates.ts";
import { type Id, isId } from "./ids.ts";

/** A decimal: text from storage or a Dec in code; always a Dec once parsed. Never a float. */
export const zDec = z.union([z.string(), z.custom<Dec>((v) => v instanceof Dec)]).transform((value, ctx): Dec => {
  if (value instanceof Dec) return value;
  try {
    return Dec.parse(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "invalid decimal" });
    return z.NEVER;
  }
});

export const zDate = z.string().refine(isIsoDate, "invalid date") as unknown as z.ZodType<IsoDate, string>;

export const zInstant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, "invalid instant") as unknown as z.ZodType<
  Instant,
  string
>;

export const zId = z.string().refine(isId, "invalid id") as unknown as z.ZodType<Id, string>;

export const zYearMonth = z.strictObject({
  year: z.number().int().min(1900).max(2999),
  month: z.number().int().min(1).max(12),
}) as unknown as z.ZodType<YearMonth, YearMonth>;

/** A string enum from its values (TypeScript `enum` is not used: erasable syntax only). */
export function zEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values);
}

/** Every entity has a stable id. */
export const entityBase = { id: zId };
