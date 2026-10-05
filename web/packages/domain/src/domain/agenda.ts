/**
 * Due-date calendar: card bills, recurrences, loan installments and investment maturities by day.
 * Port of `domain/agenda.py`.
 *
 * Read-only: each event says what it is, how much, and whether it is paid, pending or late, with a
 * reference the screen uses to open the place where it is resolved. `today` is explicit.
 */
import { type IsoDate, type YearMonth, ymFirstDay, ymLastDay, ymOf, ymRange } from "../lib/dates.ts";
import type { Dec } from "../lib/dec.ts";
import { getOrKeyError } from "../lib/py.ts";
import { sortedBy } from "../lib/text.ts";
import { valueAt } from "../investments/performance.ts";
import { profiles } from "../investments/profile.ts";
import { assets, positions, remainingCost } from "../investments/service.ts";
import { BillStatus, bills } from "./cards.ts";
import type { Ledger } from "./ledger.ts";
import { paidNumbers, planSchedule, plans } from "./loans.ts";
import { ForecastStatus, forecasts } from "./recurrence.ts";

export const EventState = {
  DONE: "done", // paid, realized or skipped
  PENDING: "pending",
  LATE: "late",
} as const;
export type EventState = (typeof EventState)[keyof typeof EventState];

export const STATE_LABELS: Readonly<Record<EventState, string>> = {
  done: "Pago",
  pending: "A vencer",
  late: "Atrasado",
};

export interface AgendaEvent {
  readonly on: IsoDate;
  readonly title: string;
  /** Positive: money in; negative: money out. */
  readonly amount: Dec;
  /** "fatura", "recorrência", "financiamento", "vencimento" */
  readonly kind: string;
  readonly state: EventState;
  /** Page key that resolves it ("accounts", "recurrences", "investments"). */
  readonly target: string;
  readonly ref: unknown;
}

export function events(ledger: Ledger, start: IsoDate, end: IsoDate, today: IsoDate): AgendaEvent[] {
  const out: AgendaEvent[] = [];
  for (const forecast of forecasts(ledger, start, end, today)) {
    let state: EventState;
    if (forecast.status === ForecastStatus.REALIZED || forecast.status === ForecastStatus.SKIPPED) {
      state = EventState.DONE;
    } else if (forecast.status === ForecastStatus.LATE) {
      state = EventState.LATE;
    } else {
      state = forecast.dueOn < today ? EventState.LATE : EventState.PENDING;
    }
    out.push({
      on: forecast.dueOn,
      title: forecast.description,
      amount: forecast.amount,
      kind: "recorrência",
      state,
      target: "recurrences",
      ref: [forecast.ruleId, forecast.dueOn],
    });
  }
  const months: YearMonth[] = ymRange(ymOf(start), ymOf(end));
  for (const card of ledger.cards.values()) {
    for (const bill of bills(ledger, card.id, months)) {
      if (!bill.total.isPositive() || !(start <= bill.cycle.due && bill.cycle.due <= end)) continue;
      const status = bill.status(today);
      let state: EventState;
      if (status === BillStatus.PAID) state = EventState.DONE;
      else if (bill.cycle.due < today) state = EventState.LATE;
      else state = EventState.PENDING;
      out.push({
        on: bill.cycle.due,
        title: `Fatura ${card.name}`,
        amount: bill.total.negate(),
        kind: "fatura",
        state,
        target: "accounts",
        ref: [card.id, bill.cycle.month],
      });
    }
  }
  for (const plan of plans(ledger).values()) {
    const paid = paidNumbers(ledger, plan.id);
    for (const item of planSchedule(ledger, plan.id)) {
      if (!(start <= item.due && item.due <= end)) continue;
      let state: EventState;
      if (paid.has(item.number)) state = EventState.DONE;
      else state = item.due < today ? EventState.LATE : EventState.PENDING;
      out.push({
        on: item.due,
        title: `Parcela ${item.number} — ${plan.name}`,
        amount: item.payment.negate(),
        kind: "financiamento",
        state,
        target: "accounts",
        ref: ["loan", plan.id, item.number],
      });
    }
  }
  out.push(...maturities(ledger, start, end, today));
  return sortedBy(out, (e) => [e.on, e.title]);
}

/**
 * Python's `_maturities`: investments that mature in the period (from their characteristics),
 * the money comes back.
 */
export function maturities(ledger: Ledger, start: IsoDate, end: IsoDate, today: IsoDate): AgendaEvent[] {
  const out: AgendaEvent[] = [];
  for (const profile of profiles(ledger).values()) {
    if (profile.maturity === null || !(start <= profile.maturity && profile.maturity <= end)) continue;
    const pos = positions(ledger).get(profile.position_id);
    if (pos === undefined) continue;
    const observed = valueAt(ledger, pos.id, profile.maturity);
    const value = observed ? observed.valuation.value : remainingCost(ledger, pos.id, profile.maturity);
    const late = profile.maturity < today;
    const state = pos.closed ? EventState.DONE : late ? EventState.LATE : EventState.PENDING;
    out.push({
      on: profile.maturity,
      title: `Vencimento — ${getOrKeyError(assets(ledger), pos.asset_id).name}`,
      amount: value,
      kind: "vencimento",
      state,
      target: "investments",
      ref: pos.id,
    });
  }
  return out;
}

/** Events grouped by day, in the order found. */
export function byDay(found: readonly AgendaEvent[]): Map<IsoDate, AgendaEvent[]> {
  const out = new Map<IsoDate, AgendaEvent[]>();
  for (const event of found) {
    const list = out.get(event.on);
    if (list === undefined) out.set(event.on, [event]);
    else list.push(event);
  }
  return out;
}

export function monthEvents(ledger: Ledger, month: YearMonth, today: IsoDate): AgendaEvent[] {
  return events(ledger, ymFirstDay(month), ymLastDay(month), today);
}
