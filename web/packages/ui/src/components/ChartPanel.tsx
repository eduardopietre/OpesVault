/**
 * Chart and table of the same values (docs/16 §3, rule 9): each in a Collapsible, side by side from 1000 px
 * of panel (chart 3/5, values 2/5), never in tabs. Choosing a row points at the value in the chart; clicking
 * the chart selects the row. ECharts is loaded on demand, themed from the tokens, animated on entry and when
 * the data changes (not when the user asks for less motion), with a tooltip, an optional right scale and
 * "Exportar imagem".
 */
import { ImageDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../cn.ts";
import type { ChartOption } from "../chart/echarts.ts";
import { formatValue, tableRows, type ChartData, type ChartUnit } from "../chart/model.ts";
import { useReduceMotion } from "../motion.tsx";
import { useResolvedTheme } from "../preferences.tsx";
import { CHART_SERIES_VARS, cssVar } from "../tokens.ts";
import { Button } from "./Button.tsx";
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

/** Builds the ECharts option from the data and the current tokens. */
export function chartOption(whole: ChartData, reduceMotion: boolean): ChartOption {
  // Series marked `hidden` live only in the table of values.
  const chart = { ...whole, series: whole.series.filter((series) => !series.hidden) };
  const text = cssVar("--ov-text") || "#1d1d1f";
  const secondary = cssVar("--ov-secondary") || "#5b5b61";
  const grid = cssVar("--ov-chart-grid") || "#e6e6ea";
  const raised = cssVar("--ov-raised") || "#ffffff";
  const separator = cssVar("--ov-separator") || "#dcdce0";
  const font = cssVar("--ov-font-sans") || "sans-serif";
  const colors = CHART_SERIES_VARS.map((name) => cssVar(name) || "#2a78d6");
  const right = chart.series.some((series) => series.axis === "right");
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
    grid: { left: 8, right: right ? 8 : 16, top: chart.series.length > 1 ? 40 : 16, bottom: 8, containLabel: true },
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
      axisPointer: { type: chart.series.some((s) => s.kind !== "line" && s.kind !== "area") ? "shadow" : "line" },
      formatter: (params: unknown) => {
        const list = (Array.isArray(params) ? params : [params]) as { dataIndex: number; seriesIndex: number }[];
        const first = list[0];
        if (!first) return "";
        const lines = [chart.categories[first.dataIndex] ?? ""];
        for (const item of list) {
          const series = chart.series[item.seriesIndex];
          if (!series) continue;
          lines.push(`${series.name}: ${formatValue(series.values[item.dataIndex] ?? null, unitOf(series.axis))}`);
        }
        return lines.join("\n");
      },
    },
    xAxis: {
      type: "category",
      data: [...chart.categories],
      axisLabel: { color: secondary, fontFamily: font, fontSize: 12, hideOverlap: true },
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
      if (series.kind === "line" || series.kind === "area") {
        return {
          type: "line" as const,
          name: series.name,
          data,
          yAxisIndex,
          showSymbol: true,
          symbolSize: 8,
          lineStyle: { width: 2 },
          connectNulls: false,
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
  /** Receives the instance (for export). */
  onReady?: (instance: Instance | null) => void;
  className?: string | undefined;
}

/** The chart alone; prefer ChartPanel, which always shows the table of the same values. */
export function ChartView({ chart, selected = null, onSelect, height = 280, onReady, className }: ChartViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<Instance | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const reduce = useReduceMotion();
  const theme = useResolvedTheme();
  const select = useRef(onSelect);
  const ready_ = useRef(onReady);
  useEffect(() => {
    select.current = onSelect;
    ready_.current = onReady;
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
    instance.current.setOption(chartOption(chart, reduce), { notMerge: false, replaceMerge: ["series", "yAxis"] });
  }, [ready, chart, reduce, theme]);

  useEffect(() => {
    if (!ready || !instance.current || selected === null) return;
    instance.current.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: selected });
  }, [ready, selected]);

  const summary = `${chart.title}: gráfico com ${chart.series.map((s) => s.name).join(", ")} por ${chart.categories.length} períodos. Os valores estão na tabela.`;
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
  className?: string | undefined;
}

export function ChartPanel({
  chart,
  prefKey,
  height = 300,
  columns = "3fr 2fr",
  at = 1000,
  className,
}: ChartPanelProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const instance = useRef<Instance | null>(null);
  const rows = useMemo(() => tableRows(chart), [chart]);
  const [tableOpen, setTableOpen] = useState(true);

  const exportImage = () => {
    const current = instance.current;
    if (!current) return;
    const url = current.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: cssVar("--ov-content") || "#fff" });
    const link = document.createElement("a");
    link.href = url;
    link.download = `${chart.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "grafico"}.png`;
    link.click();
  };

  return (
    <div className={cn("min-w-0", className)}>
      <Adaptive at={at} columns={columns} gap={24}>
        <Collapsible
          title={chart.title}
          {...(prefKey ? { prefKey: `${prefKey}/grafico` } : {})}
          actions={
            <Button size="sm" variant="ghost" icon={<ImageDown className="size-4" />} onClick={exportImage}>
              Exportar imagem
            </Button>
          }
        >
          <ChartView
            chart={chart}
            selected={selected}
            onSelect={(index) => {
              setSelected(index);
              setTableOpen(true);
            }}
            height={height}
            onReady={(value) => (instance.current = value)}
          />
          {chart.note ? <p className="mt-2 text-caption text-secondary">{chart.note}</p> : null}
        </Collapsible>
        <Collapsible
          title="Valores"
          open={tableOpen}
          onOpenChange={setTableOpen}
          {...(prefKey ? { prefKey: `${prefKey}/valores` } : {})}
        >
          <div className="max-h-[360px] overflow-auto">
            <table className="w-full border-collapse text-body">
              <caption className="sr-only">Valores de {chart.title}</caption>
              <thead className="sticky top-0 bg-content">
                <tr className="border-b border-separator">
                  <th scope="col" className="py-2 pr-3 text-left text-caption font-semibold text-secondary">
                    Período
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
                            onClick={() => setSelected(active ? null : row.index)}
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
