/**
 * The chart model: points, series, a chart with its provenance, and the table of values behind it.
 * Port of `charts/data/model.py`.
 *
 * Python told a date from a text label by type; here a point says so with `isDate` (a date is an
 * `IsoDate` string, a label is any text such as a month "2026-03" or a category name).
 */
import { type IsoDate, type YearMonth, ymAdd, ymLte } from "../../lib/dates.ts";
import { Dec } from "../../lib/dec.ts";
import { roundMoney, ZERO } from "../../domain/money.ts";

export interface Point {
  readonly x: string;
  /** The x is a calendar date (`IsoDate`) rather than a label. */
  readonly isDate: boolean;
  readonly y: Dec | null;
  /** Tooltip: origin, nature, method, quality… */
  readonly info: Readonly<Record<string, string>>;
}

/** A point on a text axis (a month "2026-03", a category, an account). */
export function point(x: string, y: Dec | null, info: Readonly<Record<string, string>> = {}): Point {
  return { x, isDate: false, y, info };
}

/** A point on a date axis. */
export function datePoint(on: IsoDate, y: Dec | null, info: Readonly<Record<string, string>> = {}): Point {
  return { x: on, isDate: true, y, info };
}

export type SeriesStyle = "bar" | "line" | "scatter" | "step" | "forecast";

export interface Series {
  readonly name: string;
  readonly points: readonly Point[];
  readonly style: SeriesStyle;
  readonly markerPoints: boolean;
  /** Only in the table of values, not drawn (keeps the chart readable). */
  readonly hidden: boolean;
  /** Whether a total over the rows means something: flows (bars) add up, positions (lines) do not. */
  readonly summable: boolean | null;
  /** "right": drawn against a second scale (a loan's installment beside its balance). */
  readonly axis: "left" | "right";
}

export interface SeriesOptions {
  readonly style?: SeriesStyle;
  readonly markerPoints?: boolean;
  readonly hidden?: boolean;
  readonly summable?: boolean | null;
  readonly axis?: "left" | "right";
}

export function series(name: string, points: readonly Point[], options: SeriesOptions = {}): Series {
  return {
    name,
    points,
    style: options.style ?? "bar",
    markerPoints: options.markerPoints ?? false,
    hidden: options.hidden ?? false,
    summable: options.summable ?? null,
    axis: options.axis ?? "left",
  };
}

/** Python's `Series.adds_up` property. */
export function addsUp(s: Series): boolean {
  return s.summable !== null ? s.summable : s.style === "bar" || s.style === "forecast";
}

export interface Chart {
  readonly title: string;
  /** "BRL" or "%" */
  readonly unit: string;
  readonly series: readonly Series[];
  readonly notes: readonly string[];
  readonly regime: string | null;
}

export function chart(
  title: string,
  unit: string,
  seriesList: readonly Series[],
  notes: readonly string[] = [],
  regime: string | null = null,
): Chart {
  return { title, unit, series: seriesList, notes, regime };
}

export function monthsBetween(start: YearMonth, end: YearMonth): YearMonth[] {
  const out: YearMonth[] = [];
  for (let cursor = start; ymLte(cursor, end); cursor = ymAdd(cursor, 1)) out.push(cursor);
  return out;
}

export interface TableRow {
  /** null for the summary rows. */
  readonly x: string | null;
  readonly isDate: boolean;
  readonly label: string;
  readonly values: readonly (Dec | null)[];
}

/** `YearMonth.parse(text)` succeeds: "YYYY-MM" with the model's ranges, as `int()` reads numbers. */
function isMonth(text: string): boolean {
  const parts = text.split("-");
  if (parts.length !== 2) return false;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\s*\+?\d+(?:_\d+)*\s*$/.test(part)) return false;
    numbers.push(Number(part.replaceAll("_", "").trim().replace(/^\+/, "")));
  }
  const [year, month] = numbers as [number, number];
  return year >= 1900 && year <= 2999 && month >= 1 && month <= 12;
}

const keyOf = (isDate: boolean, x: string) => (isDate ? "d" : "s") + x;

/**
 * The chart's numbers as rows (one per x) and columns (one per series, hidden ones included).
 *
 * Monthly charts get "Total" and "Média" rows for the series that add up (flows); positions such as
 * balances never get a total. Unknown values stay null.
 */
export function tableRows(c: Chart): [string[], TableRow[]] {
  const xs: { x: string; isDate: boolean }[] = [];
  const seen = new Set<string>();
  for (const s of c.series) {
    for (const p of s.points) {
      const key = keyOf(p.isDate, p.x);
      if (!seen.has(key)) {
        seen.add(key);
        xs.push({ x: p.x, isDate: p.isDate });
      }
    }
  }
  if (xs.every((x) => x.isDate)) xs.sort((a, b) => (a.x < b.x ? -1 : a.x > b.x ? 1 : 0));
  const lookup = c.series.map((s) => {
    const m = new Map<string, Dec | null>();
    for (const p of s.points) m.set(keyOf(p.isDate, p.x), p.y);
    return m;
  });
  const rows: TableRow[] = xs.map(({ x, isDate }) => ({
    x,
    isDate,
    label: x,
    values: lookup.map((values) => values.get(keyOf(isDate, x)) ?? null),
  }));
  const monthly = xs.length > 0 && xs.every((x) => !x.isDate && isMonth(x.x));
  const summable = c.series.map(addsUp);
  if (monthly && rows.length > 1 && summable.some(Boolean) && c.unit === "BRL") {
    const totals: (Dec | null)[] = [];
    const averages: (Dec | null)[] = [];
    summable.forEach((adds, column) => {
      const known = rows.map((r) => r.values[column]!).filter((v): v is Dec => v !== null && v !== undefined);
      if (!adds || !known.length) {
        totals.push(null);
        averages.push(null);
        return;
      }
      const total = Dec.sum(known, ZERO);
      totals.push(total);
      averages.push(roundMoney(total.div(known.length)));
    });
    rows.push({ x: null, isDate: false, label: "Total", values: totals });
    rows.push({ x: null, isDate: false, label: "Média", values: averages });
  }
  return [c.series.map((s) => s.name), rows];
}

const MONTH_NAMES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"] as const;

/** "mar/2026" */
export function monthName(month: YearMonth): string {
  return `${MONTH_NAMES[month.month - 1]}/${month.year}`;
}
