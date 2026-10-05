/**
 * What a ChartPanel draws and tabulates: one data set for the chart and its table of values (docs/07 §4).
 * Values are exact decimal strings; null is "unknown", shown as "—" and never drawn as zero.
 * The domain's charts/data (when ported) produces this shape.
 */
import { formatDecimalBR, meanDecimals, sumDecimals } from "../format.ts";

export type ChartUnit = "money" | "percent" | "number";

export interface ChartSeries {
  id: string;
  name: string;
  values: readonly (string | null)[];
  kind?: "bar" | "line" | "area";
  /** "right" puts a series of another order of magnitude on the secondary scale (docs/16 §4 rule 13). */
  axis?: "left" | "right";
  /** Bars with the same stack id pile up. */
  stack?: string;
}

export interface ChartData {
  title: string;
  /** Category labels on the horizontal axis ("out/26"). */
  categories: readonly string[];
  series: readonly ChartSeries[];
  unit?: ChartUnit;
  /** Unit of the right scale, when a series uses it. */
  rightUnit?: ChartUnit;
  /** Monthly flows get "Total" and "Média" rows in the table; positions (balances) do not add up. */
  flow?: boolean;
  /** A note under the chart (which scale is which, what is estimated). */
  note?: string;
}

export function formatValue(value: string | null, unit: ChartUnit = "money"): string {
  if (value === null) return "—";
  if (unit === "percent") return `${formatDecimalBR(value, { places: 2 })}%`;
  if (unit === "money") return formatDecimalBR(value, { places: 2, currency: true });
  return formatDecimalBR(value);
}

export interface TableRow {
  key: string;
  label: string;
  /** Index into the categories, or null for summary rows. */
  index: number | null;
  cells: string[];
  summary?: boolean;
}

/** The table of values of a chart: one row per category, a column per series, totals for flows. */
export function tableRows(chart: ChartData): TableRow[] {
  const unitOf = (series: ChartSeries) => (series.axis === "right" ? (chart.rightUnit ?? chart.unit) : chart.unit);
  const rows: TableRow[] = chart.categories.map((label, index) => ({
    key: `c${index}`,
    label,
    index,
    cells: chart.series.map((series) => formatValue(series.values[index] ?? null, unitOf(series))),
  }));
  if (chart.flow && chart.categories.length > 1) {
    const known = (series: ChartSeries) => series.values.filter((value): value is string => value !== null);
    rows.push({
      key: "total",
      label: "Total",
      index: null,
      summary: true,
      cells: chart.series.map((series) => {
        const values = known(series);
        return values.length ? formatValue(sumDecimals(values), unitOf(series)) : "—";
      }),
    });
    rows.push({
      key: "mean",
      label: "Média",
      index: null,
      summary: true,
      cells: chart.series.map((series) => formatValue(meanDecimals(known(series)), unitOf(series))),
    });
  }
  return rows;
}
