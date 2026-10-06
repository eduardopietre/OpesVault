/**
 * Metas without React (desktop `ui/pages/goals_page.py` `refresh`): each goal with its progress as plain
 * values, the words of the progress column and the line under the title. A value the ledger cannot give
 * (no deadline, no history) stays unknown: "—", never zero.
 */
import { dom, formatBrl, formatDateBr, type Dec, type IsoDate, type YearMonth } from "@opesvault/domain";
import { formatMonth, formatMonthShort } from "@opesvault/ui";
import { cents, usedPercent } from "../orcamento/rows.ts";

type Goal = dom.goals.Goal;

export interface GoalRow {
  id: string;
  goal: Goal;
  progress: dom.goals.Progress;
}

export const NONE = "—";

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

export function moneyOrNone(value: Dec | null): string {
  return value === null ? NONE : formatBrl(value);
}

export function dateOrNone(value: IsoDate | null): string {
  return value === null ? NONE : formatDateBr(value);
}

/** "Outubro de 2027", when the recent pace reaches the target. */
export function reachedLabel(month: YearMonth | null): string {
  if (month === null) return NONE;
  const text = formatMonth(month);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "out/27": the short form the table has room for; the details below it say the month in full. */
export function reachedShort(month: YearMonth | null): string {
  return month === null ? NONE : formatMonthShort(month);
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
