/**
 * What a ChartPanel draws and tabulates: one data set for the chart and its table of values (docs/07 §4).
 * Values are exact decimal strings; null is "unknown", shown as "—" and never drawn as zero.
 * The domain's charts/data (when ported) produces this shape.
 */
import { exporting } from "@opesvault/domain";
import { formatDecimalBR, meanDecimals, sumDecimals } from "../format.ts";

/** What the tooltip says about a value besides the number (docs/07 §5): its origin, nature, method, quality… */
export type PointDetails = Readonly<Record<string, string>>;

export type ChartUnit = "money" | "percent" | "number";

export interface ChartSeries {
  id: string;
  name: string;
  values: readonly (string | null)[];
  /** "scatter": markers only (events on a date, such as contributions), never joined by a line. */
  kind?: "bar" | "line" | "area" | "scatter";
  /** A line joins its observations across categories where it has no value (observed points, not daily prices). */
  connect?: boolean;
  /** "right" puts a series of another order of magnitude on the secondary scale (docs/16 §4 rule 13). */
  axis?: "left" | "right";
  /** Bars with the same stack id pile up. */
  stack?: string;
  /** Only in the table of values, not drawn (keeps the chart readable). */
  hidden?: boolean;
  /** False for positions (a balance): the table gives no total or mean for it, even in a flow chart. */
  summable?: boolean;
  /**
   * Per category, aligned with `values`: where the value comes from and how good it is ("fonte", "origem",
   * "qualidade", "método"…), shown in the tooltip. A category without details has null or nothing.
   */
  details?: readonly (PointDetails | null | undefined)[];
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
        return values.length && series.summable !== false ? formatValue(sumDecimals(values), unitOf(series)) : "—";
      }),
    });
    rows.push({
      key: "mean",
      label: "Média",
      index: null,
      summary: true,
      cells: chart.series.map((series) =>
        series.summable === false ? "—" : formatValue(meanDecimals(known(series)), unitOf(series)),
      ),
    });
  }
  return rows;
}

/** "qualidade" → "Qualidade": the key of a detail as a label. */
const detailLabel = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);

/**
 * The details of the values of one category, as "Rótulo: valor" lines, without repeating a line that several
 * series share (a chart whose series have the same provenance shows it once).
 */
export function detailLines(chart: ChartData, index: number, seriesIndexes?: readonly number[]): string[] {
  const lines: string[] = [];
  const indexes = seriesIndexes ?? chart.series.map((_, at) => at);
  for (const at of indexes) {
    const details = chart.series[at]?.details?.[index];
    if (!details) continue;
    for (const [key, value] of Object.entries(details)) {
      if (!value) continue;
      const line = `${detailLabel(key)}: ${value}`;
      if (!lines.includes(line)) lines.push(line);
    }
  }
  return lines;
}

/** One CSV field: quoted when it holds ';', '"' or a line break (as the Livro's and the Relatórios' exports). */
function csvField(text: string): string {
  return /[;"\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * The chart's values as CSV (';' between fields, decimals with '.', a BOM for spreadsheets): one row per
 * category, one column per series (hidden ones included, as in the table), unknown values empty, never zero.
 * Labels and names are free text: one a spreadsheet could run as a formula gets a leading "'" (docs/19 achado
 * 12); the value columns are written as they are.
 */
export function chartCsv(chart: ChartData, firstColumn = "Período"): string {
  const text = exporting.spreadsheetText;
  const suffix = (series: ChartSeries) => {
    const unit = series.axis === "right" ? (chart.rightUnit ?? chart.unit) : chart.unit;
    return unit === "percent" ? " (%)" : unit === "money" ? " (R$)" : "";
  };
  const rows = [
    [text(firstColumn), ...chart.series.map((series) => text(series.name + suffix(series)))],
    ...chart.categories.map((label, index) => [
      text(label),
      ...chart.series.map((series) => series.values[index] ?? ""),
    ]),
  ];
  return String.fromCharCode(0xfeff) + rows.map((row) => row.map(csvField).join(";") + "\n").join("");
}

/** A chart's title as a file name: without accents or reserved characters, so every system keeps it as given. */
export function chartFileName(title: string, extension: string): string {
  const name = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w .()-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${name || "grafico"}.${extension}`;
}
