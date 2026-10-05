/**
 * The ECharts build used by ChartPanel, loaded on demand (a separate chunk): only bar and line charts,
 * grid, tooltip, legend and the canvas renderer. Canvas, and tooltips rendered as rich text instead of HTML,
 * keep ECharts clear of innerHTML under Trusted Types (docs/18 §3.7).
 */
import { BarChart, LineChart, type BarSeriesOption, type LineSeriesOption } from "echarts/charts";
import {
  AxisPointerComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  type GridComponentOption,
  type LegendComponentOption,
  type TooltipComponentOption,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  AxisPointerComponent,
  CanvasRenderer,
]);

export type ChartOption = echarts.ComposeOption<
  BarSeriesOption | LineSeriesOption | GridComponentOption | TooltipComponentOption | LegendComponentOption
>;

export { echarts };
