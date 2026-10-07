/**
 * Metas without React (desktop `ui/pages/goals_page.py` `refresh`): each goal with its progress as plain
 * values, the words of the progress column and the line under the title. A value the ledger cannot give
 * (no deadline, no history) stays unknown: "—", never zero.
 */
import { Dec, addMonthsClamped, dom, queries, ymAdd, ymOf, type IsoDate, type YearMonth } from "@opesvault/domain";
import { formatMonth, formatMonthShort } from "@opesvault/ui";
import { usedPercent } from "../orcamento/rows.ts";
import { cents, DASH } from "../../data/money.ts";

type Goal = dom.goals.Goal;

export interface GoalRow {
  id: string;
  goal: Goal;
  progress: dom.goals.Progress;
}

export function goalRows(ledger: Parameters<typeof dom.goals.goals>[0], today: IsoDate): GoalRow[] {
  return dom.goals
    .goals(ledger)
    .map((goal) => ({ id: goal.id, goal, progress: dom.goals.progress(ledger, goal, today) }));
}

/** "Reserva de emergência (arquivada)". */
export function nameOf(goal: Goal): string {
  return goal.archived ? `${goal.name} (arquivada)` : goal.name;
}

/** "42%" or "100% · alcançada". */
export function shareLabel(progress: dom.goals.Progress): string {
  return `${usedPercent(progress.share)}${progress.reached ? " · alcançada" : ""}`;
}

/** "Outubro de 2027", when the recent pace reaches the target. */
export function reachedLabel(month: YearMonth | null): string {
  if (month === null) return DASH;
  const text = formatMonth(month);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "out/27": the short form the table has room for; the details below it say the month in full. */
export function reachedShort(month: YearMonth | null): string {
  return month === null ? DASH : formatMonthShort(month);
}

export function sortCents(value: Dec | null): bigint | null {
  return value === null ? null : cents(value);
}

/** The line under the title. */
export function summaryLine(goals: readonly Goal[]): string {
  if (!goals.length) return "";
  const active = goals.filter((g) => !g.archived).length;
  return `${active} meta(s) ativa(s)`;
}

/** What the "Defina uma meta" form starts with: an example the person can keep or change. */
export interface GoalExample {
  name: string;
  kind: Goal["kind"];
  /** Six months of the average spending; null when the project has no spending yet. */
  target: Dec | null;
  targetDate: IsoDate;
}

/** Months of spending an emergency reserve covers, in the example. */
export const RESERVE_MONTHS = 6;

/**
 * The example goal: an emergency reserve of six months of the average spending of the last three complete
 * months, within a year. Without spending the value stays empty for the person to type (unknown is not zero).
 */
export function goalExample(ledger: Parameters<typeof dom.goals.goals>[0], today: IsoDate): GoalExample {
  const month = ymOf(today);
  const spent = queries.expensesByCategory(ledger, ymAdd(month, -3), ymAdd(month, -1));
  const total = Dec.sum(spent.values());
  const target = total.isPositive() ? total.div(3).mul(RESERVE_MONTHS).quantize("0.01", "ROUND_HALF_UP") : null;
  return { name: "Reserva de emergência", kind: "net_worth", target, targetDate: addMonthsClamped(today, 12) };
}
