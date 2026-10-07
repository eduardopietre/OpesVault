/**
 * The store behind the shared month (data/month.ts), without the domain: the session sets it when a project
 * opens, and the session belongs to the first screens, which load before the domain does.
 */
import type { IsoDate, YearMonth } from "@opesvault/domain";

/** "2026-10-07" → October 2026. */
export function monthOfDate(date: IsoDate | string): YearMonth {
  return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) };
}

/** This device's current month. */
export function localMonth(): YearMonth {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

let current: YearMonth = localMonth();
const listeners = new Set<() => void>();

export function subscribeMonth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function sharedMonth(): YearMonth {
  return current;
}

/** Sets the shared month (pages call it when the user picks a month; opening a project starts it). */
export function chooseMonth(month: YearMonth): void {
  if (month.year === current.year && month.month === current.month) return;
  current = month;
  for (const listener of [...listeners]) listener();
}
