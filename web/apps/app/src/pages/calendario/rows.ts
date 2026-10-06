/**
 * What Calendário shows, as plain values (desktop `AgendaPage.refresh` and `_fill_grid`, without Qt):
 * the figures of the month, the weeks of the grid (Sunday first, as Brazilian calendars) and the entries
 * of a day. The entries come from `dom.agenda`: bills, recurrences, installments and investment maturities.
 */
import {
  Dec,
  ZERO,
  dom,
  makeDate,
  daysInMonth,
  weekday,
  ymFirstDay,
  type IsoDate,
  type YearMonth,
} from "@opesvault/domain";

type AgendaEvent = dom.agenda.AgendaEvent;
const { EventState } = dom.agenda;

export const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] as const;
export const WEEKDAY_NAMES = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"] as const;

export const KIND_LABELS: Readonly<Record<string, string>> = {
  fatura: "Fatura",
  recorrência: "Recorrência",
  financiamento: "Financiamento",
  vencimento: "Investimento",
};

export interface AgendaFigures {
  /** Money still to leave: pending and late bills. */
  toPay: Dec;
  /** The part of it that is already late. */
  late: Dec;
  /** Bills already paid. */
  paid: Dec;
  /** Money still to come in. */
  toReceive: Dec;
}

const sum = (values: Iterable<Dec>) => Dec.sum(values, ZERO);

export function agendaFigures(events: readonly AgendaEvent[]): AgendaFigures {
  const pending = events.filter((e) => e.state !== EventState.DONE);
  return {
    toPay: sum(pending.filter((e) => e.amount.isNegative()).map((e) => e.amount.negate())),
    late: sum(
      pending.filter((e) => e.amount.isNegative() && e.state === EventState.LATE).map((e) => e.amount.negate()),
    ),
    paid: sum(events.filter((e) => e.state === EventState.DONE && e.amount.isNegative()).map((e) => e.amount.negate())),
    toReceive: sum(pending.filter((e) => e.amount.isPositive()).map((e) => e.amount)),
  };
}

export interface DayCell {
  date: IsoDate;
  day: number;
  isToday: boolean;
  events: readonly AgendaEvent[];
  /** What leaves on the day (a positive amount); null when nothing does. */
  outflow: Dec | null;
  late: boolean;
}

/** The month's weeks, Sunday first; a null is a day of another month. */
export function monthWeeks(month: YearMonth, events: readonly AgendaEvent[], today: IsoDate): (DayCell | null)[][] {
  const byDay = dom.agenda.byDay(events);
  const first = ymFirstDay(month);
  const lead = (weekday(first) + 1) % 7; // Python's Monday=0 → Sunday first
  const last = daysInMonth(month.year, month.month);
  const weeks: (DayCell | null)[][] = [];
  for (let index = 0; index < Math.ceil((lead + last) / 7) * 7; index++) {
    const day = index - lead + 1;
    const week = Math.floor(index / 7);
    weeks[week] ??= [];
    if (day < 1 || day > last) {
      weeks[week]!.push(null);
      continue;
    }
    const date = makeDate(month.year, month.month, day);
    const found = byDay.get(date) ?? [];
    const out = sum(found.filter((e) => e.amount.isNegative()).map((e) => e.amount.negate()));
    weeks[week]!.push({
      date,
      day,
      isToday: date === today,
      events: found,
      outflow: out.isZero() ? null : out,
      late: found.some((e) => e.state === EventState.LATE),
    });
  }
  return weeks;
}

/** The entries of one day, or of the whole month when no day is chosen. */
export function entriesOf(events: readonly AgendaEvent[], day: IsoDate | null): AgendaEvent[] {
  return events.filter((e) => day === null || e.on === day);
}

/** "qui, 08 de outubro": a day for the list on phones. */
export function dayTitle(date: IsoDate, monthName: string): string {
  const parts = date.split("-");
  const week = WEEKDAYS[(weekday(date) + 1) % 7] as string;
  return `${week}, ${parts[2]} de ${monthName}`;
}
