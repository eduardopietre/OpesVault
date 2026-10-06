/**
 * The domain's `charts.data.Chart` as what a ChartPanel draws and tabulates (`ChartData`): the same
 * values for the chart and its table. Exact decimals travel as strings; null stays "unknown".
 */
import { ymParse, type charts } from "@opesvault/domain";
import { formatMonthShort, type ChartData, type ChartUnit } from "@opesvault/ui";

type DomainChart = charts.data.Chart;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** "2026-03" as "mar/26" (the chart axis); any other label as it is. */
export function axisLabel(x: string): string {
  return MONTH.test(x) ? formatMonthShort(ymParse(x)) : x;
}

function unitOf(unit: string): ChartUnit {
  return unit === "BRL" ? "money" : unit === "%" ? "percent" : "number";
}

/** One category per distinct x (in the order the series bring them), a value or null per series. */
export function toChartData(chart: DomainChart): ChartData {
  const xs: string[] = [];
  for (const series of chart.series) for (const p of series.points) if (!xs.includes(p.x)) xs.push(p.x);
  const monthly = xs.length > 0 && xs.every((x) => MONTH.test(x));
  const data: ChartData = {
    title: chart.title,
    categories: xs.map(axisLabel),
    unit: unitOf(chart.unit),
    flow: monthly && chart.series.some((s) => s.style === "bar"),
    series: chart.series.map((series, index) => {
      const byX = new Map(series.points.map((p) => [p.x, p.y]));
      return {
        id: `s${index}`,
        name: series.name,
        values: xs.map((x) => byX.get(x)?.toFixed() ?? null),
        kind: series.style === "line" || series.style === "step" ? ("line" as const) : ("bar" as const),
        axis: series.axis,
      };
    }),
  };
  const note = chart.notes.join(" ");
  return note ? { ...data, note } : data;
}
