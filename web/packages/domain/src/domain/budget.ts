/**
 * Monthly budget per expense category: planned, actual by competence, remaining (docs/09 §1.3).
 * Port of `domain/budget.py`.
 *
 * A budget is a plan, not a financial fact: it never touches balances or results. The actual
 * comes from the same competence view as the overview, so card purchases count in the month they
 * happened, refunds reduce it and bill payments do not repeat it. A budget on a parent category
 * covers its sub-categories.
 */
import { z } from "zod";

import { ymEq, type YearMonth } from "../lib/dates.ts";
import { indexBy } from "../lib/collections.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { zDec, zId, zYearMonth } from "../lib/schema.ts";
import { casefold, sortedBy } from "../lib/text.ts";
import * as queries from "./queries.ts";
import { DomainError, Ledger } from "./ledger.ts";
import { AccountSubtype, AccountType, zEntityId } from "./model.ts";
import { isCents, toDecimal, ZERO } from "./money.ts";

export const NEAR_LIMIT = Dec.from("0.9"); // warn from 90% of the plan

export const BudgetLineSchema = z.strictObject({
  id: zEntityId,
  category_id: zId,
  month: zYearMonth,
  amount: zDec,
  version: z.number().int().default(1),
});
export type BudgetLine = Readonly<z.output<typeof BudgetLineSchema>>;

Ledger.registerKind("budget_line", BudgetLineSchema);

export const BudgetState = { OK: "ok", NEAR: "near", OVER: "over" } as const;
export type BudgetState = (typeof BudgetState)[keyof typeof BudgetState];

export interface BudgetRow {
  readonly categoryId: Id;
  readonly name: string;
  readonly planned: Dec;
  readonly actual: Dec;
  /** Negative when over. */
  readonly remaining: Dec;
  /** actual / planned, e.g. 0.82 */
  readonly used: Dec;
  readonly state: BudgetState;
}

export class BudgetStatus {
  readonly month: YearMonth;
  readonly rows: readonly BudgetRow[];
  readonly totalPlanned: Dec;
  /** Budgeted categories only. */
  readonly totalActual: Dec;
  /** Spending in categories without a plan. */
  readonly unbudgeted: Dec;

  constructor(month: YearMonth, rows: readonly BudgetRow[], totalPlanned: Dec, totalActual: Dec, unbudgeted: Dec) {
    this.month = month;
    this.rows = rows;
    this.totalPlanned = totalPlanned;
    this.totalActual = totalActual;
    this.unbudgeted = unbudgeted;
  }

  get over(): BudgetRow[] {
    return this.rows.filter((r) => r.state === BudgetState.OVER);
  }

  get near(): BudgetRow[] {
    return this.rows.filter((r) => r.state === BudgetState.NEAR);
  }
}

export function lines(ledger: Ledger) {
  return ledger.entities<BudgetLine>("budget_line");
}

export function linesOf(ledger: Ledger, month: YearMonth): BudgetLine[] {
  return [...lines(ledger).values()].filter((line) => ymEq(line.month, month));
}

/** (category, month) as one map key: ids and numbers never contain "\u0000". */
function lineKey(categoryId: Id, month: YearMonth): string {
  return `${categoryId}\u0000${month.year}\u0000${month.month}`;
}

export function lineFor(ledger: Ledger, categoryId: Id, month: YearMonth): BudgetLine | null {
  const index = ledger.cachedFor("budget.lineFor", ["budget_line"], () =>
    indexBy(lines(ledger).values(), (x) => lineKey(x.category_id, x.month)),
  );
  return index.get(lineKey(categoryId, month)) ?? null;
}

function expenseCategory(ledger: Ledger, categoryId: Id): void {
  const account = ledger.accounts.get(categoryId);
  if (account === undefined || account.type !== AccountType.EXPENSE || account.subtype !== AccountSubtype.CATEGORY) {
    throw new DomainError("O orçamento é definido para categorias de despesa.");
  }
}

export function setBudget(ledger: Ledger, categoryId: Id, month: YearMonth, amount: unknown): BudgetLine {
  expenseCategory(ledger, categoryId);
  const value = toDecimal(amount);
  if (!value.isPositive()) throw new DomainError("Informe um valor positivo para o orçamento.");
  if (!isCents(value)) throw new DomainError("Use valores em centavos.");
  const current = lineFor(ledger, categoryId, month);
  if (current === null) {
    return ledger.put("budget_line", BudgetLineSchema.parse({ category_id: categoryId, month, amount: value }));
  }
  if (current.amount.eq(value)) return current;
  const updated: BudgetLine = { ...current, amount: value, version: current.version + 1 };
  return ledger.put("budget_line", updated, { reason: "valor do orçamento alterado" });
}

export function removeBudget(ledger: Ledger, categoryId: Id, month: YearMonth): void {
  const current = lineFor(ledger, categoryId, month);
  if (current !== null) lines(ledger).delete(current.id);
}

/** Repeats last month's plan; existing lines of the target month stay unless overwrite. */
export function copyMonth(ledger: Ledger, source: YearMonth, target: YearMonth, overwrite = false): number {
  let copied = 0;
  for (const line of linesOf(ledger, source)) {
    if (!overwrite && lineFor(ledger, line.category_id, target) !== null) continue;
    setBudget(ledger, line.category_id, target, line.amount);
    copied += 1;
  }
  return copied;
}

function ancestors(ledger: Ledger, categoryId: Id): Id[] {
  const chain = [categoryId];
  const seen = new Set([categoryId]);
  let account = ledger.accounts.get(categoryId);
  while (account !== undefined && account.parent_id !== null && !seen.has(account.parent_id)) {
    chain.push(account.parent_id);
    seen.add(account.parent_id);
    account = ledger.accounts.get(account.parent_id);
  }
  return chain;
}

export function status(ledger: Ledger, month: YearMonth): BudgetStatus {
  const spending = queries.expensesByCategory(ledger, month, month);
  const planned = new Map<Id, Dec>();
  for (const line of linesOf(ledger, month)) planned.set(line.category_id, line.amount);
  const actual = new Map<Id, Dec>([...planned.keys()].map((k) => [k, ZERO]));
  let unbudgeted = ZERO;
  for (const [categoryId, value] of spending) {
    const covering = ancestors(ledger, categoryId).filter((c) => planned.has(c));
    if (!covering.length) unbudgeted = unbudgeted.add(value);
    // a parent's plan covers its sub-categories
    for (const c of covering) actual.set(c, actual.get(c)!.add(value));
  }
  const rows: BudgetRow[] = [];
  for (const [categoryId, plan] of planned) {
    const spent = actual.get(categoryId)!;
    const used = spent.div(plan).quantize("0.0001", "ROUND_HALF_UP");
    const state = spent.gt(plan) ? BudgetState.OVER : used.gte(NEAR_LIMIT) ? BudgetState.NEAR : BudgetState.OK;
    const account = ledger.accounts.get(categoryId);
    rows.push({
      categoryId,
      name: account ? account.name : "?",
      planned: plan,
      actual: spent,
      remaining: plan.sub(spent),
      used,
      state,
    });
  }
  const sorted = sortedBy(rows, (r) => [r.used.negate(), casefold(r.name)]);
  const topLevel = [...planned.keys()].filter(
    (c) =>
      !ancestors(ledger, c)
        .slice(1)
        .some((a) => planned.has(a)),
  );
  return new BudgetStatus(
    month,
    sorted,
    Dec.sum(
      topLevel.map((c) => planned.get(c)!),
      ZERO,
    ),
    Dec.sum(
      topLevel.map((c) => actual.get(c)!),
      ZERO,
    ),
    unbudgeted,
  );
}
