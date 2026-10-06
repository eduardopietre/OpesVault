/**
 * What Visão geral shows, as plain values built from the domain (the desktop's `OverviewPage.refresh`,
 * without any React): testable on their own. Nothing here rounds a figure before display, and an unknown
 * value stays `null` ("—"), never zero.
 */
import {
  AccountType,
  Dec,
  ZERO,
  casefold,
  cashDate,
  dom,
  formatFixed,
  isLiquid,
  queries,
  sortedBy,
  today as localToday,
  ymLastDay,
  ymOf,
  ymStr,
  type Id,
  type IsoDate,
  type Ledger,
  type YearMonth,
} from "@opesvault/domain";

/** The months side by side in "Mês a mês". */
export const SUMMARY_MONTHS = 12;
/** Categories that rose most, listed under the totals of the comparison. */
export const COMPARISON_CATEGORIES = 5;
/** Categories needed before a bar adds anything to the percentage. */
export const SHARE_BARS_FROM = 3;

/** Liquid and other balance accounts a member holds; null for the whole project. */
export function heldAccounts(ledger: Ledger, memberId: Id | null): Id[] | null {
  if (memberId === null) return null;
  const held = [...ledger.accounts.values()].filter((a) => a.holders.includes(memberId)).map((a) => a.id);
  const cards = [...ledger.cards.values()].filter((c) => c.holder_id === memberId).map((c) => c.liability_account_id);
  return [...held, ...cards];
}

export interface MonthFigures {
  inflow: Dec;
  outflow: Dec;
  net: Dec;
  income: Dec;
  expense: Dec;
  result: Dec;
  assets: Dec;
  liabilities: Dec;
  worth: Dec;
}

/**
 * Cash, competence result and net worth of a month. A member's view: competence by their shares; cash and
 * net worth by the accounts they hold (a joint account appears whole, so the members' views do not add up
 * to the project's).
 */
export function monthFigures(ledger: Ledger, month: YearMonth, memberId: Id | null): MonthFigures {
  const held = heldAccounts(ledger, memberId);
  const liquid = held === null ? null : held.filter((id) => isLiquid(ledger.account(id)));
  const flow = queries.cashFlow(ledger, month, month, liquid).get(ymStr(month));
  const statement = queries.incomeStatement(ledger, month, memberId);
  const worth = queries.netWorth(ledger, ymLastDay(month));
  let assets = worth.assets;
  let liabilities = worth.liabilities;
  if (held !== null) {
    const mine = new Set(held);
    assets = ZERO;
    liabilities = ZERO;
    for (const [id, value] of worth.byAccount) {
      if (!mine.has(id)) continue;
      if (ledger.account(id).type === AccountType.ASSET) assets = assets.add(value);
      else liabilities = liabilities.add(value);
    }
  }
  return {
    inflow: flow?.inflow ?? ZERO,
    outflow: flow?.outflow ?? ZERO,
    net: flow?.net ?? ZERO,
    income: statement.totalIncome,
    expense: statement.totalExpense,
    result: statement.result,
    assets,
    liabilities,
    worth: assets.sub(liabilities),
  };
}

export interface BalanceRow {
  id: Id;
  name: string;
  value: Dec;
}

/** Balance and liability accounts at the end of the month (archived ones left out). */
export function balanceRows(ledger: Ledger, month: YearMonth, memberId: Id | null): BalanceRow[] {
  const held = heldAccounts(ledger, memberId);
  const mine = held === null ? null : new Set(held);
  const all = queries.balances(ledger, ymLastDay(month));
  const accounts = sortedBy(
    [...ledger.accounts.values()].filter(
      (a) => (a.type === AccountType.ASSET || a.type === AccountType.LIABILITY) && (mine === null || mine.has(a.id)),
    ),
    (a) => [a.type, casefold(a.name)],
  );
  return accounts.filter((a) => !a.archived).map((a) => ({ id: a.id, name: a.name, value: all.get(a.id) ?? ZERO }));
}

export interface CategoryRow {
  id: Id;
  name: string;
  value: Dec;
  /** "42%", or "—" without a total. */
  percent: string;
  /** Fraction of the total (0..1) for the bar; null without a total. */
  share: number | null;
}

/** Expense by category in the month, the largest first, with the share of the total. */
export function categoryRows(ledger: Ledger, month: YearMonth, memberId: Id | null): CategoryRow[] {
  const spending =
    memberId === null
      ? queries.expensesByCategory(ledger, month, month)
      : new Map([...queries.incomeStatement(ledger, month, memberId).expense].filter(([, value]) => !value.isZero()));
  const total = Dec.sum(spending.values(), ZERO);
  return sortedBy([...spending], ([, value]) => value, true).map(([id, value]) => {
    const fraction = total.isZero() ? null : value.div(total);
    return {
      id,
      name: ledger.account(id).name,
      value,
      percent: fraction === null ? "—" : `${formatFixed(fraction.mul(100), 0)}%`,
      share: fraction === null ? null : Math.min(fraction.toNumberForDisplay(), 1),
    };
  });
}

export interface ComparisonRow {
  key: string;
  name: string;
  /** A category that rose (indented under the totals). */
  category: boolean;
  /** The category's account, to open its operations. */
  categoryId: Id | null;
  current: Dec;
  average: Dec | null;
  /** "+12%", or "—" without an average. */
  variation: string;
  lastYear: Dec | null;
}

function comparisonRow(row: dom.comparisons.Comparison, category: boolean): ComparisonRow {
  const change = row.change;
  return {
    key: `${category ? "c" : "t"}:${row.categoryId ?? row.name}`,
    name: row.name,
    category,
    categoryId: row.categoryId,
    current: row.current,
    average: row.average,
    variation: change === null ? "—" : `${formatFixed(change.mul(100), 0, true)}%`,
    lastYear: row.lastYear,
  };
}

/** Totals against the 3-month average and a year ago, then the categories that rose most. */
export function comparisonRows(ledger: Ledger, month: YearMonth): ComparisonRow[] {
  const rows = dom.comparisons.totalsComparison(ledger, month).map((row) => comparisonRow(row, false));
  const risers = sortedBy(
    dom.comparisons.categoryComparison(ledger, month).filter((r) => r.delta !== null && r.delta.isPositive()),
    (r) => r.delta ?? ZERO,
    true,
  ).slice(0, COMPARISON_CATEGORIES);
  return [...rows, ...risers.map((row) => comparisonRow(row, true))];
}

export const INDICATOR_LABELS: Readonly<Record<string, string>> = {
  savings: "Poupança no mês",
  savings_12m: "Poupança em 12 meses",
  fixed: "Despesas fixas",
  committed: "Renda em parcelas",
  reserve: "Reserva",
};

export interface IndicatorRow {
  key: string;
  label: string;
  /** Display text: "12%", "3,5 meses" or "—". */
  text: string;
  /** Negative savings is flagged. */
  negative: boolean;
  /** How it is computed, or why it is unavailable. */
  detail: string;
}

export function indicatorRows(ledger: Ledger, month: YearMonth): IndicatorRow[] {
  return dom.indicators.indicators(ledger, month).map((indicator) => {
    const label = INDICATOR_LABELS[indicator.key] ?? indicator.label;
    const value = indicator.value;
    let text: string;
    if (value === null) text = "—";
    else if (indicator.unit === "%") text = `${formatFixed(value.mul(100), 0)}%`;
    else text = `${value.toString().replace(".", ",")} meses`;
    return {
      key: indicator.key,
      label,
      text,
      negative: indicator.key === "savings" && value !== null && value.isNegative(),
      detail: indicator.detail,
    };
  });
}

/** The latest month with activity up to today: the page opens there, not on an empty current month. */
export function latestActivityMonth(ledger: Ledger, today: IsoDate = localToday()): YearMonth | null {
  let latest: IsoDate | null = null;
  for (const op of ledger.operations.values()) {
    const when = op.occurred_on ?? cashDate(op);
    if (when !== null && (latest === null || when > latest)) latest = when;
  }
  if (latest === null) return null;
  return ymOf(latest < today ? latest : today);
}
