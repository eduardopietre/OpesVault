/**
 * The month shared by Visão geral, Orçamento, Livro, Calendário and Relatórios (docs/16 §5): choosing
 * a month in one of them shows the same month in the others for the rest of the session.
 */
import { today, ym, type YearMonth, yearOf, monthOf } from "@opesvault/domain";
import { useSyncExternalStore } from "react";

let current: YearMonth = (() => {
  const d = today();
  return ym(yearOf(d), monthOf(d));
})();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function get(): YearMonth {
  return current;
}

/** Sets the shared month (pages call it when the user picks a month). */
export function chooseMonth(month: YearMonth): void {
  if (month.year === current.year && month.month === current.month) return;
  current = month;
  for (const listener of [...listeners]) listener();
}

/** The shared month and its setter. */
export function useSharedMonth(): [YearMonth, (month: YearMonth) => void] {
  return [useSyncExternalStore(subscribe, get, get), chooseMonth];
}
