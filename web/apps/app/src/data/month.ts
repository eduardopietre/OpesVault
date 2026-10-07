/**
 * The month shared by Visão geral, Orçamento, Livro, Calendário and Relatórios (docs/16 §5): choosing
 * a month in one of them shows the same month in the others for the rest of the session. Opening a project
 * starts it on the project's own month (`OpenProject.startMonth`) or on the current month.
 */
import {
  competence,
  dayOf,
  daysInMonth,
  isActive,
  ymAdd,
  ymIndex,
  ymOf,
  type IsoDate,
  type Ledger,
  type YearMonth,
} from "@opesvault/domain";
import { useSyncExternalStore } from "react";
import { chooseMonth, sharedMonth, subscribeMonth } from "./shared_month.ts";

export { chooseMonth };

/** The shared month and its setter. */
export function useSharedMonth(): [YearMonth, (month: YearMonth) => void] {
  return [useSyncExternalStore(subscribeMonth, sharedMonth, sharedMonth), chooseMonth];
}

/** How far back `lastCompleteMonth` looks for a month with entries. */
const LOOK_BACK = 24;

/**
 * The last complete month that has entries: the current month on its last day; otherwise the newest earlier
 * month with an active operation (within two years), or the current month when there is none. The
 * demonstration opens on it, so its screens show a whole month instead of a few days of one.
 */
export function lastCompleteMonth(ledger: Ledger, on: IsoDate): YearMonth {
  const month = ymOf(on);
  if (dayOf(on) === daysInMonth(month.year, month.month)) return month;
  const used = new Set<number>();
  for (const op of ledger.operations.values()) {
    if (!isActive(op)) continue;
    const at = competence(op);
    if (at) used.add(ymIndex(at));
  }
  for (let back = 1; back <= LOOK_BACK; back++) {
    const candidate = ymAdd(month, -back);
    if (used.has(ymIndex(candidate))) return candidate;
  }
  return month;
}
