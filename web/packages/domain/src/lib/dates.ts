/**
 * Calendar dates and months (docs/02 §6): financial dates are local dates without a time zone,
 * technical events are instants with an explicit zone.
 *
 * A date is the ISO string "YYYY-MM-DD", the same form the desktop persisted; ISO dates sort
 * and compare correctly as strings. Arithmetic goes through day ordinals (Python's
 * `date.toordinal()`), never through `Date` and its time zone.
 */

export type IsoDate = string & { readonly __isoDate: unique symbol };
/** An instant in UTC: "2026-10-05T22:13:00.296Z". */
export type Instant = string & { readonly __instant: unique symbol };

export class DateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DateError";
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function makeDate(year: number, month: number, day: number): IsoDate {
  if (!Number.isInteger(year) || year < 1 || year > 9999) throw new DateError("year out of range");
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new DateError("month must be in 1..12");
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month))
    throw new DateError("day is out of range for month");
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as IsoDate;
}

export function isIsoDate(text: string): text is IsoDate {
  const m = ISO_DATE.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function parseDate(text: string): IsoDate {
  if (!isIsoDate(text)) throw new DateError("invalid date");
  return text;
}

function dateParts(d: IsoDate): { year: number; month: number; day: number } {
  return { year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)), day: Number(d.slice(8, 10)) };
}

export function yearOf(d: IsoDate): number {
  return Number(d.slice(0, 4));
}
export function monthOf(d: IsoDate): number {
  return Number(d.slice(5, 7));
}
export function dayOf(d: IsoDate): number {
  return Number(d.slice(8, 10));
}

/** Python's `date.toordinal()`: 0001-01-01 is day 1. */
export function toOrdinal(d: IsoDate): number {
  const { year, month, day } = dateParts(d);
  const y = year - 1;
  return (
    y * 365 +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) +
    DAYS_BEFORE_MONTH[month - 1]! +
    (month > 2 && isLeap(year) ? 1 : 0) +
    day
  );
}

/** Python's `date.fromordinal()`. */
export function fromOrdinal(n: number): IsoDate {
  if (!Number.isInteger(n) || n < 1) throw new DateError("ordinal out of range");
  // Algorithm of CPython's _ord2ymd.
  let rest = n - 1;
  const n400 = Math.floor(rest / 146097);
  rest %= 146097;
  const n100 = Math.floor(rest / 36524);
  rest %= 36524;
  const n4 = Math.floor(rest / 1461);
  rest %= 1461;
  const n1 = Math.floor(rest / 365);
  rest %= 365;
  let year = n400 * 400 + n100 * 100 + n4 * 4 + n1 + 1;
  if (n1 === 4 || n100 === 4) return makeDate(year - 1, 12, 31);
  const leap = n1 === 3 && (n4 !== 24 || n100 === 3);
  let month = (rest + 50) >> 5;
  let preceding = DAYS_BEFORE_MONTH[month - 1]! + (month > 2 && leap ? 1 : 0);
  if (preceding > rest) {
    month -= 1;
    preceding -= daysInMonth(year, month);
  }
  year = Math.max(year, 1);
  return makeDate(year, month, rest - preceding + 1);
}

export function addDays(d: IsoDate, days: number): IsoDate {
  return fromOrdinal(toOrdinal(d) + days);
}

/** `(a - b).days` */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return toOrdinal(a) - toOrdinal(b);
}

/** Python's `date.weekday()`: Monday is 0, Sunday is 6. */
export function weekday(d: IsoDate): number {
  return (toOrdinal(d) + 6) % 7;
}

/** Same day of month, clamped to the month's end ("31/01 + 1 mês" is 28 or 29/02). */
export function addMonthsClamped(d: IsoDate, months: number): IsoDate {
  const { year, month, day } = dateParts(d);
  const index = year * 12 + (month - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return makeDate(y, m, Math.min(day, daysInMonth(y, m)));
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}
export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

/** Today in the browser's local calendar (the family's calendar, not UTC). */
export function today(now: Date = new Date()): IsoDate {
  return makeDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function nowInstant(now: Date = new Date()): Instant {
  return now.toISOString() as Instant;
}

/** "05/10/2026" */
export function formatDateBr(d: IsoDate): string {
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
}

/** "10/2026": Python's `f"{month.month:02d}/{month.year}"`. */
export function ymBr(m: YearMonth): string {
  return `${String(m.month).padStart(2, "0")}/${m.year}`;
}

// ── competence months ───────────────────────────────

/** A competence month, persisted as {"year": 2026, "month": 10} like the desktop's YearMonth. */
export interface YearMonth {
  readonly year: number;
  readonly month: number;
}

export function ym(year: number, month: number): YearMonth {
  if (!Number.isInteger(year) || year < 1900 || year > 2999) throw new DateError("year out of range");
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new DateError("month out of range");
  return { year, month };
}

export function ymOf(d: IsoDate): YearMonth {
  return ym(yearOf(d), monthOf(d));
}

/** "2026-10" */
export function ymParse(text: string): YearMonth {
  const [y, m] = text.split("-");
  return ym(Number.parseInt(y ?? "", 10), Number.parseInt(m ?? "", 10));
}

export function ymStr(m: YearMonth): string {
  return `${String(m.year).padStart(4, "0")}-${String(m.month).padStart(2, "0")}`;
}

export function ymAdd(m: YearMonth, months: number): YearMonth {
  const index = m.year * 12 + (m.month - 1) + months;
  return ym(Math.floor(index / 12), (index % 12) + 1);
}

export function ymIndex(m: YearMonth): number {
  return m.year * 12 + (m.month - 1);
}

export function ymCompare(a: YearMonth, b: YearMonth): number {
  return ymIndex(a) - ymIndex(b);
}

export function ymEq(a: YearMonth | null | undefined, b: YearMonth | null | undefined): boolean {
  if (a == null || b == null) return a == b;
  return a.year === b.year && a.month === b.month;
}

export function ymLt(a: YearMonth, b: YearMonth): boolean {
  return ymIndex(a) < ymIndex(b);
}

export function ymLte(a: YearMonth, b: YearMonth): boolean {
  return ymIndex(a) <= ymIndex(b);
}

export function ymFirstDay(m: YearMonth): IsoDate {
  return makeDate(m.year, m.month, 1);
}

export function ymLastDay(m: YearMonth): IsoDate {
  return makeDate(m.year, m.month, daysInMonth(m.year, m.month));
}

/** Months from `a` to `b` inclusive. */
export function ymRange(a: YearMonth, b: YearMonth): YearMonth[] {
  const out: YearMonth[] = [];
  for (let i = ymIndex(a); i <= ymIndex(b); i++) out.push(ym(Math.floor(i / 12), (i % 12) + 1));
  return out;
}
