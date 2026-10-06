/**
 * The domain's charts of the Contas screen as `ChartData`, through the one converter (`data/chart_data.ts`):
 * the balance of an account over the months (the balances the bank informed are isolated points, never
 * joined), the card's bills and the financing's schedule (one installment per month, labelled "out/26").
 * Series the domain marks as `hidden` stay in the table only.
 */
import type { charts } from "@opesvault/domain";
import type { ChartData } from "@opesvault/ui";
import { toChartData } from "../../data/chart_data.ts";

type DomainChart = charts.data.Chart;

/** The balance chart: points the bank informed (scatter in the domain) are drawn as isolated points. */
export function accountChartData(chart: DomainChart): ChartData {
  return toChartData(chart);
}

/** The card's bills by due month. */
export function billsChartData(chart: DomainChart): ChartData {
  return toChartData(chart);
}

/** The schedule chart: installments by due month. */
export function scheduleChartData(chart: DomainChart): ChartData {
  return toChartData(chart, { monthLabels: true });
}
