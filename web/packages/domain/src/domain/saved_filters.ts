/**
 * Saved Ledger filters ("Cartão da Ana este mês"), kept in the project (docs/09 §1.3 A).
 * Port of `domain/saved_filters.py`.
 *
 * They name accounts and members of this family, so they live in the project and never in the
 * computer's preferences.
 */
import { z } from "zod";

import type { Id } from "../lib/ids.ts";
import { collapseSpaces } from "../lib/py.ts";
import { zId } from "../lib/schema.ts";
import { casefold, sortedBy } from "../lib/text.ts";
import { DomainError, Ledger } from "./ledger.ts";
import { zEntityId } from "./model.ts";

export const PERIODS = ["all", "month", "this_month", "last_month", "last_3", "this_year"] as const;

export const SavedFilterSchema = z.strictObject({
  id: zEntityId,
  name: z.string().min(1).max(60),
  period: z.string().default("all"), // one of PERIODS; a custom range is not saved (it would go stale)
  account_id: zId.nullable().default(null),
  member_id: zId.nullable().default(null),
  text: z.string().max(200).default(""),
  status: z.string().default("all"),
  origin: z.string().nullable().default(null),
  tag: z.string().max(40).nullable().default(null),
});
export type SavedFilter = Readonly<z.output<typeof SavedFilterSchema>>;

Ledger.registerKind("saved_filter", SavedFilterSchema);

export function saved(ledger: Ledger): SavedFilter[] {
  return sortedBy(ledger.entities<SavedFilter>("saved_filter").values(), (f) => casefold(f.name));
}

export function saveFilter(ledger: Ledger, flt: SavedFilter): SavedFilter {
  const name = collapseSpaces(flt.name);
  if (!name) throw new DomainError("Dê um nome ao filtro.");
  if (!(PERIODS as readonly string[]).includes(flt.period)) {
    throw new DomainError("Período personalizado não é salvo; escolha um período com nome.");
  }
  const existing = saved(ledger).find((f) => casefold(f.name) === casefold(name)) ?? null;
  const renamed: SavedFilter = { ...flt, name };
  if (existing !== null) {
    return ledger.put("saved_filter", { ...renamed, id: existing.id }, { reason: "filtro substituído" });
  }
  return ledger.put("saved_filter", renamed);
}

export function deleteFilter(ledger: Ledger, filterId: Id): void {
  const collection = ledger.entities<SavedFilter>("saved_filter");
  if (collection.has(filterId)) collection.delete(filterId);
}
