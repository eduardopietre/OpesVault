/**
 * The domain's investment charts as the design system's `ChartData`, plus what `toChartData` does not carry:
 * markers (contributions, redemptions, distributions) are drawn as points only, never joined by a line, and a line
 * of observations is joined across the dates it has no value (it links observed points, not daily prices).
 */
import { Dec, charts, formatDateBr, type IsoDate, type investments } from "@opesvault/domain";
import type { ChartData } from "@opesvault/ui";
import { toChartData } from "../../data/chart_data.ts";

type DomainChart = charts.data.Chart;

export function toInvestmentChart(chart: DomainChart): ChartData {
  const data = toChartData(chart);
  return {
    ...data,
    series: data.series.map((series, index) => {
      const source = chart.series[index]!;
      if (source.style === "scatter") return { ...series, kind: "scatter" as const };
      if (source.markerPoints) return { ...series, connect: true };
      return series;
    }),
  };
}

/** A chart in "%" carries ratios (0,0123 is 1,23%): the design system's percent unit shows the number as it is. */
export function toPercentChart(chart: DomainChart): ChartData {
  const data = toChartData(chart);
  return {
    ...data,
    series: data.series.map((series) => ({
      ...series,
      values: series.values.map((value) => (value === null ? null : Dec.from(value).mul(Dec.from(100)).toFixed())),
    })),
  };
}

/**
 * The returns chart from results already computed (the domain's `returnsChart` computes every method again,
 * the slow one included): percentages by method; an unavailable method appears in the notes with its reason,
 * never as zero.
 */
export function returnsChartOf(
  results: readonly investments.performance.Result[],
  start: IsoDate,
  end: IsoDate,
): DomainChart {
  const { chart, series, point } = charts.data;
  const points = [];
  const notes = [];
  for (const result of results) {
    const label = result.method.split(" (")[0]!;
    if (result.value === null) notes.push(`${label}: indisponível — ${result.notes.length ? result.notes[0] : ""}`);
    points.push(
      point(label, result.value, {
        método: result.method,
        qualidade: result.quality,
        ...(result.notes.length ? { notas: result.notes.join("; ") } : {}),
      }),
    );
  }
  return chart(`Rentabilidade ${formatDateBr(start)} a ${formatDateBr(end)}`, "%", [series("Retorno", points)], notes);
}
