/**
 * Monthly budget per expense category: planned, actual by competence, remaining (docs/09 §1.3).
 * Port of `domain/budget.py`.
 *
 * A budget is a plan, not a financial fact: it never touches balances or results. The actual
 * comes from the same competence view as the overview, so card purchases count in the month they
 * happened, refunds reduce it and bill payments do not repeat it. A budget on a parent category
 * covers its sub-categories. A line may carry its leftover (the unspent part, never an overspending) into
 * the next month, where it adds to what is available (schema 3, not in the Python original).
 */
import { z } from "zod";

import { ymAdd, ymEq, type YearMonth } from "../lib/dates.ts";
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
  // the unspent part of this month goes to the next one (schema 3); overspending never does
  carry_over: z.boolean().default(false),
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
  /** The leftover brought from the month before (its line carries over); zero otherwise. */
  readonly carried: Dec;
  /** planned + carried: what may be spent this month. */
  readonly available: Dec;
  readonly actual: Dec;
  /** available − actual; negative when over. */
  readonly remaining: Dec;
  /** actual / available, e.g. 0.82 */
  readonly used: Dec;
  readonly state: BudgetState;
  /** This month's leftover goes to the next month. */
  readonly carryOver: boolean;
}

export class BudgetStatus {
  readonly month: YearMonth;
  readonly rows: readonly BudgetRow[];
  readonly totalPlanned: Dec;
  /** Budgeted categories only. */
  readonly totalActual: Dec;
  /** Spending in categories without a plan. */
  readonly unbudgeted: Dec;
  /** Leftovers brought from the month before, budgeted categories only (top level, like the plan). */
  readonly totalCarried: Dec;

  constructor(
    month: YearMonth,
    rows: readonly BudgetRow[],
    totalPlanned: Dec,
    totalActual: Dec,
    unbudgeted: Dec,
    totalCarried: Dec = ZERO,
  ) {
    this.month = month;
    this.rows = rows;
    this.totalPlanned = totalPlanned;
    this.totalActual = totalActual;
    this.unbudgeted = unbudgeted;
    this.totalCarried = totalCarried;
  }

  /** planned + carried: what may be spent in the month. */
  get totalAvailable(): Dec {
    return this.totalPlanned.add(this.totalCarried);
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

/** Repeats last month's plan, with each line's carry-over choice; existing lines of the target month stay unless overwrite. */
export function copyMonth(ledger: Ledger, source: YearMonth, target: YearMonth, overwrite = false): number {
  let copied = 0;
  for (const line of linesOf(ledger, source)) {
    if (!overwrite && lineFor(ledger, line.category_id, target) !== null) continue;
    setBudget(ledger, line.category_id, target, line.amount);
    if (line.carry_over) setCarryOver(ledger, line.category_id, target, true);
    copied += 1;
  }
  return copied;
}

/**
 * Whether the leftover of a category's budget in `month` (what was not spent) goes to the next month. The
 * month needs a planned value first. Overspending is never carried: the next month does not start in debt.
 */
export function setCarryOver(ledger: Ledger, categoryId: Id, month: YearMonth, carry: boolean): BudgetLine {
  expenseCategory(ledger, categoryId);
  const current = lineFor(ledger, categoryId, month);
  if (current === null) throw new DomainError("Defina o valor do orçamento deste mês antes de levar a sobra.");
  if (current.carry_over === carry) return current;
  const updated: BudgetLine = { ...current, carry_over: carry, version: current.version + 1 };
  return ledger.put("budget_line", updated, {
    reason: carry ? "sobra levada ao mês seguinte" : "sobra deixa de ir ao mês seguinte",
  });
}

/** What a category spent in `month` (its sub-categories included), from the month's spending. */
function spentBy(ledger: Ledger, categoryId: Id, spending: ReadonlyMap<Id, Dec>): Dec {
  let total = ZERO;
  for (const [id, value] of spending) if (ancestors(ledger, id).includes(categoryId)) total = total.add(value);
  return total;
}

/**
 * The leftover a category brings into `month`: the unspent part of the month before when that month's line
 * carries over, itself including what it brought. Never negative; zero without a carrying line before.
 */
export function carriedInto(ledger: Ledger, categoryId: Id, month: YearMonth): Dec {
  // Walk back over the chain of carrying lines, then add up from its oldest month forward.
  const chain: BudgetLine[] = [];
  let cursor = ymAdd(month, -1);
  for (;;) {
    const line = lineFor(ledger, categoryId, cursor);
    if (line === null || !line.carry_over) break;
    chain.push(line);
    cursor = ymAdd(cursor, -1);
  }
  let carried = ZERO;
  for (const line of chain.reverse()) {
    const spending = queries.expensesByCategory(ledger, line.month, line.month);
    const left = line.amount.add(carried).sub(spentBy(ledger, categoryId, spending));
    carried = left.isPositive() ? left : ZERO;
  }
  return carried;
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
  const carrying = new Set<Id>();
  for (const line of linesOf(ledger, month)) {
    planned.set(line.category_id, line.amount);
    if (line.carry_over) carrying.add(line.category_id);
  }
  // A leftover brought from the month before is budget too, even without a plan this month.
  const carried = new Map<Id, Dec>();
  for (const line of linesOf(ledger, ymAdd(month, -1))) {
    if (!line.carry_over) continue;
    const value = carriedInto(ledger, line.category_id, month);
    if (value.isPositive()) carried.set(line.category_id, value);
  }
  const budgeted = new Set<Id>([...planned.keys(), ...carried.keys()]);
  const actual = new Map<Id, Dec>([...budgeted].map((k) => [k, ZERO]));
  let unbudgeted = ZERO;
  for (const [categoryId, value] of spending) {
    const covering = ancestors(ledger, categoryId).filter((c) => budgeted.has(c));
    if (!covering.length) unbudgeted = unbudgeted.add(value);
    // a parent's plan covers its sub-categories
    for (const c of covering) actual.set(c, actual.get(c)!.add(value));
  }
  const rows: BudgetRow[] = [];
  for (const categoryId of budgeted) {
    const plan = planned.get(categoryId) ?? ZERO;
    const brought = carried.get(categoryId) ?? ZERO;
    const available = plan.add(brought);
    const spent = actual.get(categoryId)!;
    const used = spent.div(available).quantize("0.0001", "ROUND_HALF_UP");
    const state = spent.gt(available) ? BudgetState.OVER : used.gte(NEAR_LIMIT) ? BudgetState.NEAR : BudgetState.OK;
    const account = ledger.accounts.get(categoryId);
    rows.push({
      categoryId,
      name: account ? account.name : "?",
      planned: plan,
      carried: brought,
      available,
      actual: spent,
      remaining: available.sub(spent),
      used,
      state,
      carryOver: carrying.has(categoryId),
    });
  }
  const sorted = sortedBy(rows, (r) => [r.used.negate(), casefold(r.name)]);
  const topLevel = [...budgeted].filter(
    (c) =>
      !ancestors(ledger, c)
        .slice(1)
        .some((a) => budgeted.has(a)),
  );
  return new BudgetStatus(
    month,
    sorted,
    Dec.sum(
      topLevel.map((c) => planned.get(c) ?? ZERO),
      ZERO,
    ),
    Dec.sum(
      topLevel.map((c) => actual.get(c)!),
      ZERO,
    ),
    unbudgeted,
    Dec.sum(
      topLevel.map((c) => carried.get(c) ?? ZERO),
      ZERO,
    ),
  );
}
