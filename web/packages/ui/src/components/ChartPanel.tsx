/**
 * Chart and table of the same values (docs/16 §3, rule 9): each in a Collapsible, side by side from 1000 px
 * of panel (chart 3/5, values 2/5), never in tabs. Choosing a row points at the value in the chart; clicking
 * the chart selects the row. ECharts is loaded on demand, themed from the tokens, animated on entry and when
 * the data changes (not when the user asks for less motion), with a tooltip that says where each value comes from
 * and how good it is (docs/07 §5: origin, nature, method, quality, when the series carries them), an optional right
 * scale, zoom along the categories by explicit action (Ampliar, Reduzir, Redefinir escala; Ctrl + wheel inside the
 * chart, a slider to move while zoomed), "Exportar imagem" and "Exportar valores" (CSV), each asked first: the file
 * leaves the project without encryption (docs/19 §12).
 */
import { Download, ImageDown, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { cn } from "../cn.ts";
import { saveFile } from "../download.ts";
import type { ChartOption } from "../chart/echarts.ts";
import {
  chartCsv,
  chartFileName,
  detailLines,
  formatValue,
  tableRows,
  type ChartData,
  type ChartUnit,
} from "../chart/model.ts";
import { CSV_TYPE } from "../download.ts";
import { useReduceMotion } from "../motion.tsx";
import { useResolvedTheme } from "../preferences.tsx";
import { CHART_SERIES_VARS, cssVar } from "../tokens.ts";
import { Button, IconButton } from "./Button.tsx";
import { confirm } from "./Dialog.tsx";
import { notify } from "./Toast.tsx";
import { Collapsible } from "./Collapsible.tsx";
import { Adaptive, Skeleton, type AdaptiveAt } from "./layout.tsx";

type EChartsModule = typeof import("../chart/echarts.ts");
type Instance = ReturnType<EChartsModule["echarts"]["init"]>;

let loading: Promise<EChartsModule> | null = null;
/** Loads the ECharts chunk once. */
export function loadECharts(): Promise<EChartsModule> {
  loading ??= import("../chart/echarts.ts");
  return loading;
}

function axisLabel(unit: ChartUnit | undefined) {
  const compact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
  return (value: number) =>
    unit === "percent"
      ? `${compact.format(value)}%`
      : unit === "money"
        ? `R$ ${compact.format(value)}`
        : compact.format(value);
}

/** The categories shown while zoomed, by index (both ends included); null is the whole chart. */
export interface ZoomWindow {
  from: number;
  to: number;
}

/** From this many categories a chart can be zoomed; the narrowest window shows two. */
export const ZOOM_MIN_CATEGORIES = 4;
const MIN_SPAN = 2;

export const zoomable = (chart: ChartData) => chart.categories.length >= ZOOM_MIN_CATEGORIES;

function placed(center: number, span: number, count: number): ZoomWindow | null {
  if (span >= count) return null;
  const from = Math.min(Math.max(Math.round(center - (span - 1) / 2), 0), count - span);
  return { from, to: from + span - 1 };
}

/** Half the categories in view, around `focus` (the chosen one) or the middle of what is shown. */
export function zoomIn(current: ZoomWindow | null, count: number, focus: number | null = null): ZoomWindow | null {
  const { from, to } = current ?? { from: 0, to: count - 1 };
  const span = Math.max(MIN_SPAN, Math.ceil((to - from + 1) / 2));
  return placed(focus ?? (from + to) / 2, span, count);
}

/** Twice the categories in view; the whole chart once they all fit. */
export function zoomOut(current: ZoomWindow | null, count: number): ZoomWindow | null {
  if (current === null) return null;
  return placed((current.from + current.to) / 2, (current.to - current.from + 1) * 2, count);
}

/** The window moved just enough to show `index` (a value chosen in the table). */
export function showing(current: ZoomWindow | null, index: number): ZoomWindow | null {
  if (current === null || (index >= current.from && index <= current.to)) return current;
  const span = current.to - current.from + 1;
  const from = index < current.from ? index : index - span + 1;
  return { from, to: from + span - 1 };
}

/** Builds the ECharts option from the data, the current tokens and the zoom window. */
export function chartOption(whole: ChartData, reduceMotion: boolean, zoom: ZoomWindow | null = null): ChartOption {
  // Series marked `hidden` live only in the table of values.
  const chart = { ...whole, series: whole.series.filter((series) => !series.hidden) };
  const text = cssVar("--ov-text") || "#1d1d1f";
  const secondary = cssVar("--ov-secondary") || "#5b5b61";
  const grid = cssVar("--ov-chart-grid") || "#e6e6ea";
  const raised = cssVar("--ov-raised") || "#ffffff";
  const separator = cssVar("--ov-separator") || "#dcdce0";
  const font = cssVar("--ov-font-sans") || "sans-serif";
  const colors = CHART_SERIES_VARS.map((name) => cssVar(name) || "#2a78d6");
  const accentSoft = cssVar("--ov-accent-soft") || "#e6effa";
  const canZoom = zoomable(chart);
  const zoomed = canZoom && zoom !== null;
  const range = zoomed ? { startValue: zoom.from, endValue: zoom.to } : { start: 0, end: 100 };
  const right = chart.series.some((series) => series.axis === "right");
  // Many named items (categories, merchants): every name is shown, tilted and shortened, instead of every other one.
  const named = chart.categories.length > 5 && chart.categories.some((label) => label.length > 9);
  const unitOf = (axis: "left" | "right" | undefined) =>
    axis === "right" ? (chart.rightUnit ?? chart.unit) : chart.unit;
  const valueAxis = (unit: ChartUnit | undefined, position: "left" | "right") => ({
    type: "value" as const,
    position,
    axisLabel: { color: secondary, fontFamily: font, fontSize: 12, formatter: axisLabel(unit) },
    splitLine: { show: position === "left", lineStyle: { color: grid } },
    axisLine: { show: false },
    axisTick: { show: false },
  });
  return {
    color: colors,
    animation: !reduceMotion,
    animationDuration: 600,
    animationDurationUpdate: 320,
    animationEasing: "cubicOut",
    textStyle: { fontFamily: font, color: text },
    grid: {
      left: 8,
      right: right ? 8 : 16,
      top: chart.series.length > 1 ? 40 : 16,
      bottom: zoomed ? 40 : 8,
      containLabel: true,
    },
    // Zoom only by an explicit gesture (Ctrl + wheel) or the panel's buttons: a plain wheel or a finger keeps
    // scrolling the page. The slider appears while zoomed, to move along the categories.
    dataZoom: canZoom
      ? [
          {
            type: "inside",
            xAxisIndex: 0,
            ...range,
            minValueSpan: MIN_SPAN - 1,
            zoomOnMouseWheel: "ctrl",
            moveOnMouseWheel: "shift",
            moveOnMouseMove: false,
            preventDefaultMouseMove: false,
          },
          {
            type: "slider",
            xAxisIndex: 0,
            ...range,
            minValueSpan: MIN_SPAN - 1,
            show: zoomed,
            height: 18,
            bottom: 6,
            showDetail: false,
            showDataShadow: false,
            brushSelect: false,
            borderColor: separator,
            backgroundColor: "transparent",
            fillerColor: accentSoft,
            handleStyle: { color: raised, borderColor: secondary },
            moveHandleStyle: { color: separator },
            textStyle: { color: secondary, fontFamily: font, fontSize: 11 },
          },
        ]
      : [],
    legend:
      chart.series.length > 1
        ? {
            top: 0,
            right: 0,
            icon: "roundRect",
            itemWidth: 12,
            itemHeight: 8,
            textStyle: { color: secondary, fontFamily: font, fontSize: 12 },
          }
        : { show: false },
    tooltip: {
      trigger: "axis",
      renderMode: "richText",
      backgroundColor: raised,
      borderColor: separator,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: text, fontFamily: font, fontSize: 12 },
      axisPointer: {
        type: chart.series.some((s) => s.kind !== "line" && s.kind !== "area" && s.kind !== "scatter")
          ? "shadow"
          : "line",
      },
      formatter: (params: unknown) => {
        const list = (Array.isArray(params) ? params : [params]) as { dataIndex: number; seriesIndex: number }[];
        const first = list[0];
        if (!first) return "";
        const lines = [chart.categories[first.dataIndex] ?? ""];
        const shown: number[] = [];
        for (const item of list) {
          const series = chart.series[item.seriesIndex];
          if (!series) continue;
          // markers exist only on their own dates: a line "Aporte: —" on every other date is noise
          if (series.kind === "scatter" && (series.values[item.dataIndex] ?? null) === null) continue;
          lines.push(`${series.name}: ${formatValue(series.values[item.dataIndex] ?? null, unitOf(series.axis))}`);
          shown.push(item.seriesIndex);
        }
        // where the values come from and how good they are, once per line even when series share them
        lines.push(...detailLines(chart, first.dataIndex, shown));
        return lines.join("\n");
      },
    },
    xAxis: {
      type: "category",
      data: [...chart.categories],
      axisLabel: {
        color: secondary,
        fontFamily: font,
        fontSize: 12,
        hideOverlap: true,
        ...(named ? { interval: 0, rotate: 35, width: 96, overflow: "truncate" as const, hideOverlap: false } : {}),
      },
      axisLine: { lineStyle: { color: separator } },
      axisTick: { show: false },
    },
    yAxis: right
      ? [valueAxis(chart.unit, "left"), valueAxis(chart.rightUnit ?? chart.unit, "right")]
      : [valueAxis(chart.unit, "left")],
    series: chart.series.map((series) => {
      // Drawing needs pixel positions: the exact strings stay in the table and the tooltip.
      const data = series.values.map((value) => (value === null ? null : Number(value)));
      const yAxisIndex = series.axis === "right" ? 1 : 0;
      if (series.kind === "scatter") {
        return {
          type: "scatter" as const,
          name: series.name,
          data,
          yAxisIndex,
          symbol: "diamond",
          symbolSize: 12,
          itemStyle: { borderColor: raised, borderWidth: 1.5 },
          emphasis: { focus: "series" as const },
        };
      }
      if (series.kind === "line" || series.kind === "area") {
        return {
          type: "line" as const,
          name: series.name,
          data,
          yAxisIndex,
          showSymbol: true,
          symbolSize: 8,
          lineStyle: { width: 2 },
          connectNulls: series.connect === true,
          ...(series.kind === "area" ? { areaStyle: { opacity: 0.12 } } : {}),
          emphasis: { focus: "series" as const },
        };
      }
      return {
        type: "bar" as const,
        name: series.name,
        data,
        yAxisIndex,
        ...(series.stack ? { stack: series.stack } : {}),
        barMaxWidth: 28,
        barGap: "12%",
        itemStyle: { borderRadius: 3, borderColor: raised, borderWidth: 1 },
        emphasis: { focus: "series" as const },
      };
    }),
  };
}

export interface ChartViewProps {
  chart: ChartData;
  /** Category index pointed at (from the table). */
  selected?: number | null;
  onSelect?: (index: number) => void;
  height?: number;
  /** The categories in view (null: all of them). */
  zoom?: ZoomWindow | null;
  /** Called when the person zooms or moves inside the chart (Ctrl + wheel, the slider). */
  onZoom?: (zoom: ZoomWindow | null) => void;
  /** Receives the instance (for export). */
  onReady?: (instance: Instance | null) => void;
  className?: string | undefined;
}

/** The window ECharts shows after a gesture in the chart, read back from its option. */
function windowOf(instance: Instance, count: number): ZoomWindow | null {
  const option = instance.getOption?.() as { dataZoom?: { startValue?: unknown; endValue?: unknown }[] } | undefined;
  const zoom = option?.dataZoom?.[0];
  if (!zoom || typeof zoom.startValue !== "number" || typeof zoom.endValue !== "number") return null;
  const from = Math.max(0, Math.round(zoom.startValue));
  const to = Math.min(count - 1, Math.round(zoom.endValue));
  return from <= 0 && to >= count - 1 ? null : { from, to };
}

/** The chart alone; prefer ChartPanel, which always shows the table of the same values. */
export function ChartView({
  chart,
  selected = null,
  onSelect,
  height = 280,
  zoom = null,
  onZoom,
  onReady,
  className,
}: ChartViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<Instance | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const reduce = useReduceMotion();
  const theme = useResolvedTheme();
  const select = useRef(onSelect);
  const ready_ = useRef(onReady);
  const zoomed = useRef(onZoom);
  const count = useRef(chart.categories.length);
  useEffect(() => {
    select.current = onSelect;
    ready_.current = onReady;
    zoomed.current = onZoom;
    count.current = chart.categories.length;
  });

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | null = null;
    loadECharts()
      .then(({ echarts }) => {
        if (disposed || !host.current) return;
        const chartInstance = echarts.init(host.current, null, { renderer: "canvas" });
        instance.current = chartInstance;
        chartInstance.on("click", (event: { dataIndex?: number }) => {
          if (typeof event.dataIndex === "number") select.current?.(event.dataIndex);
        });
        chartInstance.on("datazoom", () => zoomed.current?.(windowOf(chartInstance, count.current)));
        if (typeof ResizeObserver !== "undefined") {
          observer = new ResizeObserver(() => chartInstance.resize());
          observer.observe(host.current);
        }
        setReady(true);
        ready_.current?.(chartInstance);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      observer?.disconnect();
      instance.current?.dispose();
      instance.current = null;
      ready_.current?.(null);
    };
  }, []);

  useEffect(() => {
    if (!ready || !instance.current) return;
    instance.current.setOption(chartOption(chart, reduce, zoom), {
      notMerge: false,
      replaceMerge: ["series", "yAxis", "dataZoom"],
    });
  }, [ready, chart, reduce, theme, zoom]);

  useEffect(() => {
    if (!ready || !instance.current || selected === null) return;
    instance.current.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: selected });
  }, [ready, selected]);

  const shown = zoom ? ` (mostrando ${chart.categories[zoom.from]} a ${chart.categories[zoom.to]})` : "";
  const summary = `${chart.title}: gráfico com ${chart.series.map((s) => s.name).join(", ")} por ${chart.categories.length} períodos${shown}. Os valores estão na tabela.`;
  return (
    <div className={cn("relative", className)} style={{ height }}>
      <div ref={host} role="img" aria-label={summary} className="absolute inset-0" />
      {!ready && !failed ? <Skeleton className="absolute inset-0 h-auto rounded-lg" /> : null}
      {failed ? (
        <p className="absolute inset-0 grid place-items-center text-body text-secondary">
          Não foi possível desenhar o gráfico. Os valores estão na tabela.
        </p>
      ) : null}
    </div>
  );
}

export interface ChartPanelProps {
  chart: ChartData;
  /** Preference key prefix for the two collapsible parts. */
  prefKey?: string;
  height?: number;
  /** Widths of the chart and of the values when side by side ("3fr 2fr" by default; "1fr 1fr" for many columns). */
  columns?: string;
  /** Panel width from which they sit side by side (1000 by default; more for a table with many columns). */
  at?: AdaptiveAt;
  /** Heading of the first column of the values ("Período" by default; "Item", "Data"…). */
  firstColumn?: string;
  /** Called with the chosen category index (from the chart or the table), or null when the choice is cleared. */
  onSelect?: (index: number | null) => void;
  /** Actions on the title line of the values (an export of the table). */
  valuesActions?: ReactNode;
  /**
   * The page owns the exports (it asks first, with its own file names): the panel stores here the function that
   * downloads the image, returning false when the chart is not on screen (its section folded), and drops its own
   * "Exportar imagem" and "Exportar valores" buttons.
   */
  exportRef?: RefObject<(() => boolean) | null>;
  className?: string | undefined;
}

const NOT_ENCRYPTED = "Guarde-o com cuidado: ele não é cifrado.";

/** Asks before a file leaves the project without encryption (docs/19 §12), saves it and says so. */
async function askAndSave(what: "imagem" | "valores", save: () => boolean, done: string): Promise<void> {
  const image = what === "imagem";
  const yes = await confirm({
    title: image ? "Exportar imagem sem criptografia?" : "Exportar valores sem criptografia?",
    text: `${image ? "A imagem" : "O arquivo CSV"} será gravad${image ? "a" : "o"} fora do projeto, na pasta de downloads deste aparelho, sem criptografia.`,
    confirmLabel: "Exportar",
  });
  if (!yes || !save()) return;
  notify(`${done} ${NOT_ENCRYPTED}`);
}

export function ChartPanel({
  chart,
  prefKey,
  height = 300,
  columns = "3fr 2fr",
  at = 1000,
  firstColumn = "Período",
  onSelect,
  valuesActions,
  exportRef,
  className,
}: ChartPanelProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const instance = useRef<Instance | null>(null);
  const rows = useMemo(() => tableRows(chart), [chart]);
  const [tableOpen, setTableOpen] = useState(true);
  // The zoom belongs to the categories it was made on: other data (another month, another account) starts whole.
  const categories = chart.categories.join("\u0000");
  const [zoomState, setZoomState] = useState<{ of: string; window: ZoomWindow | null }>({ of: "", window: null });
  const zoom = zoomState.of === categories ? zoomState.window : null;
  const setZoom = (window: ZoomWindow | null) => setZoomState({ of: categories, window });
  const count = chart.categories.length;
  const canZoom = zoomable(chart);

  const choose = (index: number | null) => {
    setSelected(index);
    if (index !== null) {
      const moved = showing(zoom, index);
      if (moved !== zoom) setZoom(moved);
    }
    onSelect?.(index);
  };

  const exportImage = (): boolean => {
    const current = instance.current;
    if (!current) return false;
    const url = current.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: cssVar("--ov-content") || "#fff" });
    // a file of its own (not the data address): the browser keeps the name given here
    const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (char) => char.charCodeAt(0));
    saveFile(chartFileName(chart.title, "png"), bytes, "image/png");
    return true;
  };
  const exportValues = (): boolean => {
    saveFile(chartFileName(chart.title, "csv"), chartCsv(chart, firstColumn), CSV_TYPE);
    return true;
  };
  useEffect(() => {
    if (!exportRef) return;
    exportRef.current = exportImage;
    return () => {
      exportRef.current = null;
    };
  });

  const chartActions = (
    <>
      {canZoom ? (
        <div role="group" aria-label={`Escala de ${chart.title}`} className="flex items-center gap-0.5">
          <IconButton
            size="sm"
            label="Ampliar"
            icon={<ZoomIn className="size-4" />}
            disabled={zoom !== null && zoom.to - zoom.from + 1 <= MIN_SPAN}
            onClick={() => setZoom(zoomIn(zoom, count, selected))}
          />
          <IconButton
            size="sm"
            label="Reduzir"
            icon={<ZoomOut className="size-4" />}
            disabled={zoom === null}
            onClick={() => setZoom(zoomOut(zoom, count))}
          />
          <IconButton
            size="sm"
            label="Redefinir escala"
            icon={<RotateCcw className="size-4" />}
            disabled={zoom === null}
            onClick={() => setZoom(null)}
          />
        </div>
      ) : null}
      {exportRef ? null : (
        <Button
          size="sm"
          variant="ghost"
          icon={<ImageDown className="size-4" />}
          onClick={() =>
            void askAndSave(
              "imagem",
              () => {
                if (exportImage()) return true;
                notify("O gráfico ainda não está desenhado.");
                return false;
              },
              "Imagem do gráfico gerada.",
            )
          }
        >
          Exportar imagem…
        </Button>
      )}
    </>
  );
  const tableActions =
    valuesActions || !exportRef ? (
      <>
        {valuesActions}
        {exportRef ? null : (
          <Button
            size="sm"
            variant="ghost"
            icon={<Download className="size-4" />}
            title="Grava a tabela em CSV, fora do projeto"
            onClick={() => void askAndSave("valores", exportValues, "Arquivo CSV gerado.")}
          >
            Exportar valores…
          </Button>
        )}
      </>
    ) : null;

  return (
    <div className={cn("min-w-0", className)}>
      <Adaptive at={at} columns={columns} gap={24}>
        <Collapsible title={chart.title} {...(prefKey ? { prefKey: `${prefKey}/grafico` } : {})} actions={chartActions}>
          <ChartView
            chart={chart}
            selected={selected}
            onSelect={(index) => {
              choose(index);
              setTableOpen(true);
            }}
            height={height}
            zoom={zoom}
            onZoom={setZoom}
            onReady={(value) => (instance.current = value)}
          />
          {chart.note ? <p className="mt-2 text-caption text-secondary">{chart.note}</p> : null}
        </Collapsible>
        <Collapsible
          title="Valores"
          open={tableOpen}
          onOpenChange={setTableOpen}
          {...(tableActions ? { actions: tableActions } : {})}
          {...(prefKey ? { prefKey: `${prefKey}/valores` } : {})}
        >
          <div className="max-h-[360px] overflow-auto">
            <table className="w-full border-collapse text-body">
              <caption className="sr-only">Valores de {chart.title}</caption>
              <thead className="sticky top-0 bg-content">
                <tr className="border-b border-separator">
                  <th scope="col" className="py-2 pr-3 text-left text-caption font-semibold text-secondary">
                    {firstColumn}
                  </th>
                  {chart.series.map((series) => (
                    <th
                      key={series.id}
                      scope="col"
                      className="py-2 pl-3 text-right text-caption font-semibold text-secondary"
                    >
                      {series.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const active = row.index !== null && row.index === selected;
                  return (
                    <tr
                      key={row.key}
                      className={cn(
                        "border-b border-separator/70",
                        row.summary && "font-semibold",
                        active && "bg-accent-soft",
                      )}
                    >
                      <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                        {row.index === null ? (
                          <span className="font-semibold">{row.label}</span>
                        ) : (
                          <button
                            type="button"
                            aria-pressed={active}
                            onClick={() => choose(active ? null : row.index)}
                            className="rounded-sm text-left hover:text-accent"
                          >
                            {row.label}
                          </button>
                        )}
                      </th>
                      {row.cells.map((cell, index) => (
                        <td key={index} className="py-1.5 pl-3 text-right whitespace-nowrap tabular-nums">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Collapsible>
      </Adaptive>
    </div>
  );
}
