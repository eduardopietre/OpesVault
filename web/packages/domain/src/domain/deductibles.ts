/**
 * Deductible expenses marked during the year (docs/09 §1.3 E; support for the annual tax return).
 * Port of `domain/deductibles.py`.
 *
 * Material de apoio, not the return: the app adds up what the family spent in the marked
 * categories, per person, with each operation listed so the receipts can be checked. It does not
 * apply legal limits (education, PGBL) nor decide what the tax authority accepts (docs/00 §5).
 * Expenses count in the year they were paid or, for card purchases, made.
 */
import { z } from "zod";

import { yearOf } from "../lib/dates.ts";
import type { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { zId } from "../lib/schema.ts";
import { sortedBy } from "../lib/text.ts";
import { DomainError, Ledger } from "./ledger.ts";
import { AccountSubtype, AccountType, cashDate, type Operation, zEntityId } from "./model.ts";
import { ZERO } from "./money.ts";

export const DeductibleKind = {
  HEALTH: "health",
  EDUCATION: "education",
  PENSION: "pension", // previdência privada (PGBL)
  ALIMONY: "alimony",
  DONATION: "donation",
  OTHER: "other",
} as const;
export type DeductibleKind = (typeof DeductibleKind)[keyof typeof DeductibleKind];

export const KIND_LABELS: Readonly<Record<DeductibleKind, string>> = {
  health: "Saúde",
  education: "Educação",
  pension: "Previdência privada (PGBL)",
  alimony: "Pensão alimentícia",
  donation: "Doações incentivadas",
  other: "Outras",
};

export const NOTICE =
  "Material de apoio: soma o que foi lançado nas categorias marcadas. Não aplica limites legais " +
  "nem substitui a declaração; confira cada valor com o comprovante.";

export const DeductibleCategorySchema = z.strictObject({
  id: zEntityId,
  category_id: zId,
  kind: z.enum(["health", "education", "pension", "alimony", "donation", "other"]),
});
export type DeductibleCategory = Readonly<z.output<typeof DeductibleCategorySchema>>;

Ledger.registerKind("deductible_category", DeductibleCategorySchema);

export function marks(ledger: Ledger) {
  return ledger.entities<DeductibleCategory>("deductible_category");
}

/** The mark of the category or of its nearest marked parent. */
export function kindOf(ledger: Ledger, categoryId: Id): DeductibleKind | null {
  // The last mark of a category wins.
  const byCategory = ledger.cachedFor("deductibles.kindOf", ["deductible_category"], () => {
    const out = new Map<Id, DeductibleKind>();
    for (const m of marks(ledger).values()) out.set(m.category_id, m.kind);
    return out;
  });
  const seen = new Set<Id>();
  let cursor: Id | null = categoryId;
  while (cursor !== null && !seen.has(cursor)) {
    const found = byCategory.get(cursor);
    if (found !== undefined) return found;
    seen.add(cursor);
    const account = ledger.accounts.get(cursor);
    cursor = account !== undefined ? account.parent_id : null;
  }
  return null;
}

/** Marks an expense category as deductible (or clears the mark with null). */
export function mark(ledger: Ledger, categoryId: Id, kind: DeductibleKind | null): void {
  const account = ledger.accounts.get(categoryId);
  if (account === undefined || account.type !== AccountType.EXPENSE || account.subtype !== AccountSubtype.CATEGORY) {
    throw new DomainError("Só categorias de despesa podem ser dedutíveis.");
  }
  const collection = marks(ledger);
  const current = [...collection.values()].find((m) => m.category_id === categoryId) ?? null;
  if (kind === null) {
    if (current !== null) collection.delete(current.id);
    return;
  }
  if (current === null) {
    ledger.put("deductible_category", DeductibleCategorySchema.parse({ category_id: categoryId, kind }));
  } else if (current.kind !== kind) {
    ledger.put("deductible_category", { ...current, kind }, { reason: "tipo de dedução alterado" });
  }
}

export interface DeductibleLine {
  readonly operation: Operation;
  readonly categoryId: Id;
  readonly memberId: Id | null;
  /** Negative for refunds and reimbursements. */
  readonly amount: Dec;
}

export interface DeductibleGroup {
  kind: DeductibleKind;
  /** null: not attributed to a person. */
  memberId: Id | null;
  total: Dec;
  lines: DeductibleLine[];
}

const ORDER = Object.values(DeductibleKind);

/** Totals per kind and person in `year`, with the operations behind each one. */
export function annual(ledger: Ledger, year: number): DeductibleGroup[] {
  const groups = new Map<string, DeductibleGroup>();
  const kinds = new Map<Id, DeductibleKind | null>();
  for (const op of ledger.activeOperations()) {
    const when = cashDate(op);
    if (when === null || yearOf(when) !== year) continue;
    for (const p of op.postings) {
      if (!kinds.has(p.account_id)) {
        const expense = ledger.account(p.account_id).type === AccountType.EXPENSE;
        kinds.set(p.account_id, expense ? kindOf(ledger, p.account_id) : null);
      }
      const kind = kinds.get(p.account_id) ?? null;
      if (kind === null) continue;
      const member = p.member_id ?? op.member_id;
      const key = `${kind}|${member ?? ""}`;
      let group = groups.get(key);
      if (group === undefined) groups.set(key, (group = { kind, memberId: member, total: ZERO, lines: [] }));
      group.total = group.total.add(p.amount);
      group.lines.push({ operation: op, categoryId: p.account_id, memberId: member, amount: p.amount });
    }
  }
  const out = [...groups.values()].filter((g) => g.lines.length);
  for (const group of out) {
    group.lines = sortedBy(
      group.lines,
      (line) => cashDate(line.operation) ?? line.operation.occurred_on ?? "0001-01-01",
    );
  }
  return sortedBy(out, (g) => [ORDER.indexOf(g.kind), g.memberId ?? ""]);
}
