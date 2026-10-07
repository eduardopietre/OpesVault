/**
 * What the budget dialogs share, free of React: the suggested plan and the grid's rows and differences
 * (desktop `BudgetGridDialog.values/apply`).
 */
import { AccountType, Dec, dom, queries, ymAdd, type Ledger, type YearMonth } from "@opesvault/domain";
import { editableMoney, readAmount } from "./form_readers.ts";
import { categoryItems } from "./account_choices.ts";

export interface GridRow {
  readonly categoryId: string;
  readonly name: string;
  /** What is typed at first ("" for no plan). */
  readonly text: string;
  /** This month's plan today. */
  readonly current: Dec | null;
  /** Last month's plan, for "Copiar do mês anterior". */
  readonly previous: Dec | null;
  readonly spent: Dec | null;
}

/** How many months before the budget's month a suggested plan averages. */
export const SUGGESTION_MONTHS = 3;

/**
 * A suggested plan: each expense category's average spending (by competence) in the `months` months before
 * `month`, in cents rounded half away from zero. Categories with no spending in those months are left out.
 */
export function averageSpending(ledger: Ledger, month: YearMonth, months = SUGGESTION_MONTHS): Map<string, Dec> {
  const spent = queries.expensesByCategory(ledger, ymAdd(month, -months), ymAdd(month, -1));
  const averages = new Map<string, Dec>();
  for (const [categoryId, total] of spent) {
    const average = total.div(months).quantize("0.01", "ROUND_HALF_UP");
    if (average.isPositive()) averages.set(categoryId, average);
  }
  return averages;
}

/**
 * Every expense category with this month's plan, spending and last month's plan. With `suggested`, a category
 * without a plan starts with the suggested amount typed in (saved only if the person keeps it).
 */
export function gridRows(
  ledger: Ledger,
  month: YearMonth,
  previousMonth: YearMonth,
  spending: ReadonlyMap<string, Dec>,
  suggested?: ReadonlyMap<string, Dec>,
): GridRow[] {
  return categoryItems(ledger, AccountType.EXPENSE).map<GridRow>((option) => {
    const line = dom.budget.lineFor(ledger, option.id, month);
    const before = dom.budget.lineFor(ledger, option.id, previousMonth);
    const suggestion = suggested?.get(option.id);
    return {
      categoryId: option.id,
      name: option.label,
      text: line ? editableMoney(line.amount) : suggestion ? editableMoney(suggestion) : "",
      current: line ? line.amount : null,
      previous: before ? before.amount : null,
      spent: spending.get(option.id) ?? null,
    };
  });
}

/** Fills the empty fields with last month's plan (desktop `copy_previous` of the grid). */
export function fillFromPrevious(
  rows: readonly GridRow[],
  texts: Readonly<Record<string, string>>,
): Record<string, string> {
  const next: Record<string, string> = { ...texts };
  for (const row of rows) {
    if (row.previous !== null && !(next[row.categoryId] ?? "").trim()) {
      next[row.categoryId] = editableMoney(row.previous);
    }
  }
  return next;
}

export interface GridChange {
  readonly categoryId: string;
  /** null removes the category from the month's budget. */
  readonly value: Dec | null;
}

export type GridParse = { ok: true; changes: GridChange[] } | { ok: false; error: string; categoryId: string };

/** The typed values against the current plan: only the differences; a message for the first bad field. */
export function parseGrid(rows: readonly GridRow[], texts: Readonly<Record<string, string>>): GridParse {
  const changes: GridChange[] = [];
  for (const row of rows) {
    const text = (texts[row.categoryId] ?? "").trim();
    let value: Dec | null = null;
    if (text !== "") {
      value = readAmount(text);
      if (value === null || !value.isPositive()) {
        return {
          ok: false,
          categoryId: row.categoryId,
          error: `${row.name}: informe um valor positivo ou deixe vazio.`,
        };
      }
    }
    const same = value === null ? row.current === null : row.current !== null && row.current.eq(value);
    if (!same) changes.push({ categoryId: row.categoryId, value });
  }
  return { ok: true, changes };
}

/** Writes the differences; returns how many categories changed. Call it inside one `act`. */
export function applyGrid(ledger: Ledger, month: YearMonth, changes: readonly GridChange[]): number {
  for (const change of changes) {
    if (change.value === null) dom.budget.removeBudget(ledger, change.categoryId, month);
    else dom.budget.setBudget(ledger, change.categoryId, month, change.value);
  }
  return changes.length;
}
