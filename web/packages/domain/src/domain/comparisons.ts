/**
 * Month against the recent average and against the same month last year (docs/09 §1.3 E).
 * Port of `domain/comparisons.py`.
 *
 * "Gastei mais que o normal?" Months before the family started recording are unknown, not zero:
 * they never enter an average, and a comparison without known months is null.
 */
import { ymAdd, ymLt, ymLte, ymParse, type YearMonth } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { casefold, sortedBy } from "../lib/text.ts";
import * as queries from "./queries.ts";
import type { Ledger } from "./ledger.ts";
import { AccountType, OperationKind } from "./model.ts";
import { roundMoney, ZERO } from "./money.ts";

export const DEFAULT_WINDOW = 3;

/** The first competence month with income or expense: before it, nothing is known. */
export function firstActivity(ledger: Ledger): YearMonth | null {
  let found: YearMonth | null = null;
  for (const [key, ops] of queries.index(ledger).byCompetence) {
    const month = ymParse(key);
    if (found !== null && !ymLt(month, found)) continue;
    for (const op of ops) {
      if (op.kind === OperationKind.OPENING_BALANCE) continue;
      const counts = op.postings.some((p) => {
        const type = ledger.account(p.account_id).type;
        return type === AccountType.INCOME || type === AccountType.EXPENSE;
      });
      if (counts) {
        found = month;
        break;
      }
    }
  }
  return found;
}

export function knownMonths(ledger: Ledger, months: readonly YearMonth[]): YearMonth[] {
  const first = firstActivity(ledger);
  return months.filter((m) => first !== null && ymLte(first, m));
}

export class Comparison {
  /** null for the totals. */
  readonly categoryId: Id | null;
  readonly name: string;
  readonly current: Dec;
  readonly average: Dec | null;
  readonly monthsAveraged: number;
  readonly lastYear: Dec | null;

  constructor(
    categoryId: Id | null,
    name: string,
    current: Dec,
    average: Dec | null,
    monthsAveraged: number,
    lastYear: Dec | null,
  ) {
    this.categoryId = categoryId;
    this.name = name;
    this.current = current;
    this.average = average;
    this.monthsAveraged = monthsAveraged;
    this.lastYear = lastYear;
  }

  get delta(): Dec | null {
    return this.average === null ? null : this.current.sub(this.average);
  }

  /** Relative to the average: 0.25 = 25% above. null without an average or with a zero one. */
  get change(): Dec | null {
    if (this.average === null || this.average.isZero()) return null;
    return this.current.div(this.average).sub(1).quantize("0.0001");
  }
}

function average(values: readonly Dec[]): Dec | null {
  return values.length ? roundMoney(Dec.sum(values, ZERO).div(values.length)) : null;
}

function previousMonths(month: YearMonth, window: number): YearMonth[] {
  return Array.from({ length: window }, (_, i) => ymAdd(month, -(i + 1)));
}

/** Expense per category: this month, the average of the `window` months before, and a year ago. */
export function categoryComparison(ledger: Ledger, month: YearMonth, window = DEFAULT_WINDOW): Comparison[] {
  const previous = knownMonths(ledger, previousMonths(month, window));
  const yearAgo = ymAdd(month, -12);
  const hasYearAgo = knownMonths(ledger, [yearAgo]).length > 0;
  const current = queries.expensesByCategory(ledger, month, month);
  const history = previous.map((m) => queries.expensesByCategory(ledger, m, m));
  const lastYear = hasYearAgo ? queries.expensesByCategory(ledger, yearAgo, yearAgo) : new Map<Id, Dec>();
  const categories = new Set<Id>(current.keys());
  for (const totals of history) for (const c of totals.keys()) categories.add(c);
  const out: Comparison[] = [];
  for (const categoryId of categories) {
    out.push(
      new Comparison(
        categoryId,
        ledger.account(categoryId).name,
        current.get(categoryId) ?? ZERO,
        average(history.map((totals) => totals.get(categoryId) ?? ZERO)),
        history.length,
        hasYearAgo ? (lastYear.get(categoryId) ?? ZERO) : null,
      ),
    );
  }
  return sortedBy(out, (c) => [c.current.negate(), (c.average ?? ZERO).negate(), casefold(c.name)]);
}

/** Income, expense and result (competence) against the average and a year ago. */
export function totalsComparison(ledger: Ledger, month: YearMonth, window = DEFAULT_WINDOW): Comparison[] {
  const previous = knownMonths(ledger, previousMonths(month, window));
  const yearAgo = ymAdd(month, -12);
  const hasYearAgo = knownMonths(ledger, [yearAgo]).length > 0;
  const now = queries.incomeStatement(ledger, month);
  const past = previous.map((m) => queries.incomeStatement(ledger, m));
  const then = hasYearAgo ? queries.incomeStatement(ledger, yearAgo) : null;
  const rows: [string, (s: queries.Statement) => Dec][] = [
    ["Receitas", (s) => s.totalIncome],
    ["Despesas", (s) => s.totalExpense],
    ["Resultado", (s) => s.result],
  ];
  return rows.map(
    ([name, value]) =>
      new Comparison(
        null,
        name,
        value(now),
        average(past.map((s) => value(s))),
        past.length,
        then !== null ? value(then) : null,
      ),
  );
}
