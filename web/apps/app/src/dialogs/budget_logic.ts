/**
 * What the budget dialogs share, free of React: the expense categories as options, amounts as the field
 * reads and writes them, and the grid's differences (desktop `BudgetGridDialog.values/apply`).
 */
import { AccountType, Dec, dom, formatBrl, type Ledger, type YearMonth } from "@opesvault/domain";
import { normalizeMoneyInput, type SelectOption } from "@opesvault/ui";

/** "Casa › Aluguel": the expense categories with their parent, in alphabetical order (desktop `category_items`). */
export function expenseCategoryOptions(ledger: Ledger): SelectOption[] {
  const options = ledger.categories(AccountType.EXPENSE).map((account) => {
    const parent = account.parent_id ? ledger.accounts.get(account.parent_id) : undefined;
    return { id: account.id, label: parent ? `${parent.name} › ${account.name}` : account.name };
  });
  return options.sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}

/** A planned amount as typed in the field: "2.350,00". */
export function editableAmount(value: Dec): string {
  return formatBrl(value).replace("R$", "").trim();
}

/** The amount typed in a field as an exact decimal; null when empty or not an amount. */
export function readAmount(text: string): Dec | null {
  const canonical = normalizeMoneyInput(text);
  return canonical === null ? null : Dec.from(canonical);
}

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

/** Every expense category with this month's plan, spending and last month's plan. */
export function gridRows(
  ledger: Ledger,
  month: YearMonth,
  previousMonth: YearMonth,
  spending: ReadonlyMap<string, Dec>,
): GridRow[] {
  return expenseCategoryOptions(ledger).map<GridRow>((option) => {
    const line = dom.budget.lineFor(ledger, option.id, month);
    const before = dom.budget.lineFor(ledger, option.id, previousMonth);
    return {
      categoryId: option.id,
      name: option.label,
      text: line ? editableAmount(line.amount) : "",
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
      next[row.categoryId] = editableAmount(row.previous);
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
