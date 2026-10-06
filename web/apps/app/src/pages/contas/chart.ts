/**
 * The domain's charts of this screen as `ChartData`: the balance of an account over the months (the balances
 * the bank informed are isolated points, never joined), the card's bills and the financing's schedule (one
 * installment per month, labelled "out/26"). Series the domain marks as `hidden` (a table-only column) stay
 * out of the drawing.
 */
import { ymOf, type charts, type IsoDate } from "@opesvault/domain";
import { formatMonthShort, type ChartData } from "@opesvault/ui";
import { toChartData } from "../orcamento/chart.ts";

type DomainChart = charts.data.Chart;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `toChartData` plus what it does not carry: hidden series and the points the bank informed. */
function convert(chart: DomainChart): ChartData {
  const data = toChartData(chart);
  return {
    ...data,
    series: data.series.map((series, index) => {
      const source = chart.series[index];
      return {
        ...series,
        ...(source?.style === "scatter" ? { kind: "line" as const } : {}),
        ...(source?.hidden ? { hidden: true } : {}),
      };
    }),
  };
}

/** The balance chart: points the bank informed (scatter in the domain) are drawn as isolated points. */
export function accountChartData(chart: DomainChart): ChartData {
  return convert(chart);
}

/** The card's bills by due month. */
export function billsChartData(chart: DomainChart): ChartData {
  return convert(chart);
}

/** The schedule chart: installments by due month. */
export function scheduleChartData(chart: DomainChart): ChartData {
  const data = convert(chart);
  return {
    ...data,
    categories: data.categories.map((label) =>
      ISO_DATE.test(label) ? formatMonthShort(ymOf(label as IsoDate)) : label,
    ),
  };
}
