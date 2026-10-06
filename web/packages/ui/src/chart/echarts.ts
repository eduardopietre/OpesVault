/**
 * The ECharts build used by ChartPanel, loaded on demand (a separate chunk): only bar, line and scatter (markers) charts,
 * grid, tooltip, legend and the canvas renderer. Canvas, and tooltips rendered as rich text instead of HTML,
 * keep ECharts clear of innerHTML under Trusted Types (docs/18 §3.7).
 */
import {
  BarChart,
  LineChart,
  ScatterChart,
  type BarSeriesOption,
  type LineSeriesOption,
  type ScatterSeriesOption,
} from "echarts/charts";
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
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  AxisPointerComponent,
  CanvasRenderer,
]);

export type ChartOption = echarts.ComposeOption<
  | BarSeriesOption
  | LineSeriesOption
  | ScatterSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
>;

export { echarts };
