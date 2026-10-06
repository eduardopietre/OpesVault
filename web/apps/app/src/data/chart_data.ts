/**
 * The domain's chart (`charts.data.Chart`: points with provenance) as the design system's `ChartData`
 * (what a ChartPanel draws and tabulates). The values stay exact decimal strings; hidden series stay in
 * the table only, and positions (lines) get no total or mean, as in the domain's own table of values.
 */
import { charts, ymOf, type Dec, type IsoDate } from "@opesvault/domain";
import { formatBrDate, formatMonthShort, type ChartData, type ChartSeries, type ChartUnit } from "@opesvault/ui";

type Chart = charts.data.Chart;
type Point = charts.data.Point;

export interface ChartDataOptions {
  /** Label a dated point by its month ("out/26", one point per month, as in a schedule) instead of "dd/mm". */
  readonly monthLabels?: boolean;
}

function labelOf(x: string, isDate: boolean, monthLabels: boolean): string {
  if (isDate) return monthLabels ? formatMonthShort(ymOf(x as IsoDate)) : formatBrDate(x).slice(0, 5);
  const month = /^(\d{4})-(\d{2})$/.exec(x);
  return month ? formatMonthShort({ year: Number(month[1]), month: Number(month[2]) }) : x;
}

function unitOf(unit: string): ChartUnit {
  return unit === "BRL" ? "money" : unit === "%" ? "percent" : "number";
}

const text = (value: Dec | null): string | null => (value === null ? null : value.toFixed());

/** Converts a domain chart. A monthly flow chart gets "Total" and "Média" rows, as in the domain's table. */
export function toChartData(chart: Chart, options: ChartDataOptions = {}): ChartData {
  const [, rows] = charts.data.tableRows(chart);
  const data = rows.filter((row) => row.x !== null);
  const keys = data.map((row) => (row.isDate ? "d" : "s") + row.x);
  const categories = data.map((row) => labelOf(row.x as string, row.isDate, options.monthLabels === true));
  const series: ChartSeries[] = chart.series.map((s, index) => {
    const byKey = new Map<string, Point>(s.points.map((p) => [(p.isDate ? "d" : "s") + p.x, p]));
    return {
      id: `s${index}`,
      name: s.name,
      values: keys.map((key) => text(byKey.get(key)?.y ?? null)),
      kind: s.style === "bar" || s.style === "forecast" ? "bar" : "line",
      ...(s.axis === "right" ? { axis: "right" as const } : {}),
      ...(s.hidden ? { hidden: true } : {}),
      summable: charts.data.addsUp(s),
    };
  });
  return {
    title: chart.title,
    categories,
    series,
    unit: unitOf(chart.unit),
    flow: rows.some((row) => row.x === null),
    ...(chart.notes.length ? { note: chart.notes.join(" ") } : {}),
  };
}
