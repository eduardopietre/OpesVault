import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChartPanel,
  DecisionHost,
  Toaster,
  chartCsv,
  chartOption,
  detailLines,
  showing,
  zoomIn,
  zoomOut,
  type ChartData,
} from "../src/index.ts";

// happy-dom has no canvas: a stand-in records what the panel asks of the chart.
const fake = vi.hoisted(() => {
  const options: unknown[] = [];
  const handlers = new Map<string, (event: unknown) => void>();
  const instance = {
    on: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
    setOption: (option: unknown) => options.push(option),
    getOption: () => ({ dataZoom: [{ startValue: 2, endValue: 4 }] }),
    dispatchAction: () => undefined,
    resize: () => undefined,
    dispose: () => undefined,
    getDataURL: () => "data:image/png;base64,",
  };
  return { options, handlers, instance };
});
vi.mock("../src/chart/echarts.ts", () => ({ echarts: { init: () => fake.instance } }));

const MONTHS = ["mai/26", "jun/26", "jul/26", "ago/26", "set/26", "out/26"];

const chart: ChartData = {
  title: "Evolução do investimento",
  categories: MONTHS,
  unit: "money",
  series: [
    {
      id: "a",
      name: "Valor bruto",
      kind: "line",
      values: ["100.00", null, "102.50", "103.00", "104.00", "105.00"],
      details: [
        { natureza: "Bruto", fonte: "extrato", qualidade: "observado" },
        null,
        { natureza: "Bruto", fonte: "informado" },
        undefined,
        null,
        null,
      ],
    },
    {
      id: "b",
      name: "=Aporte",
      kind: "scatter",
      values: [null, null, "-50.00", null, null, null],
      details: [null, null, { evento: "Aporte", fonte: "informado" }, null, null, null],
    },
  ],
};

type Tooltip = { formatter: (params: unknown) => string };
type Zoom = { type: string; show?: boolean; startValue?: number; endValue?: number; zoomOnMouseWheel?: unknown };

describe("chart model", () => {
  it("puts the origin and quality of a value in the tooltip, each line once", () => {
    const option = chartOption(chart, true);
    const tip = (option.tooltip as Tooltip).formatter([
      { dataIndex: 2, seriesIndex: 0 },
      { dataIndex: 2, seriesIndex: 1 },
    ]);
    expect(tip.split("\n")).toEqual([
      "jul/26",
      "Valor bruto: R$ 102,50",
      "=Aporte: R$ -50,00",
      "Natureza: Bruto",
      "Fonte: informado",
      "Evento: Aporte",
    ]);
    // a value without details says only the value; the details of a hidden marker are not shown
    expect((option.tooltip as Tooltip).formatter([{ dataIndex: 0, seriesIndex: 0 }]).split("\n")).toEqual([
      "mai/26",
      "Valor bruto: R$ 100,00",
      "Natureza: Bruto",
      "Fonte: extrato",
      "Qualidade: observado",
    ]);
    expect(detailLines(chart, 3)).toEqual([]);
  });

  it("zooms by halves around the chosen value, out by doubles, and moves to show a value", () => {
    expect(zoomIn(null, 12)).toEqual({ from: 3, to: 8 });
    expect(zoomIn({ from: 3, to: 8 }, 12)).toEqual({ from: 5, to: 7 });
    expect(zoomIn({ from: 5, to: 7 }, 12)).toEqual({ from: 6, to: 7 });
    expect(zoomIn({ from: 6, to: 7 }, 12)).toEqual({ from: 6, to: 7 });
    expect(zoomIn(null, 12, 11)).toEqual({ from: 6, to: 11 });
    expect(zoomIn(null, 12, 0)).toEqual({ from: 0, to: 5 });
    expect(zoomOut({ from: 5, to: 7 }, 12)).toEqual({ from: 4, to: 9 });
    expect(zoomOut({ from: 3, to: 8 }, 12)).toBeNull();
    expect(zoomOut(null, 12)).toBeNull();
    expect(showing({ from: 3, to: 5 }, 4)).toEqual({ from: 3, to: 5 });
    expect(showing({ from: 3, to: 5 }, 9)).toEqual({ from: 7, to: 9 });
    expect(showing({ from: 3, to: 5 }, 0)).toEqual({ from: 0, to: 2 });
    expect(showing(null, 9)).toBeNull();
  });

  it("zooms only by Ctrl + wheel inside the chart, with a slider while zoomed, and not a short chart", () => {
    const whole = chartOption(chart, true).dataZoom as Zoom[];
    expect(whole.map((zoom) => zoom.type)).toEqual(["inside", "slider"]);
    expect(whole[0]!.zoomOnMouseWheel).toBe("ctrl");
    expect(whole[1]!.show).toBe(false);
    const zoomed = chartOption(chart, true, { from: 2, to: 4 }).dataZoom as Zoom[];
    expect(zoomed[1]!.show).toBe(true);
    expect([zoomed[0]!.startValue, zoomed[0]!.endValue]).toEqual([2, 4]);
    const short = { ...chart, categories: MONTHS.slice(0, 3) };
    expect(chartOption(short, true).dataZoom).toEqual([]);
  });

  it("writes the values as CSV: unknown is empty, text that could be a formula is guarded", () => {
    const csv = chartCsv(chart, "Data");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split("\n")).toEqual([
      "Data;Valor bruto (R$);'=Aporte (R$)",
      "mai/26;100.00;",
      "jun/26;;",
      "jul/26;102.50;-50.00",
      "ago/26;103.00;",
      "set/26;104.00;",
      "out/26;105.00;",
      "",
    ]);
    const quoted = chartCsv({ ...chart, categories: ['A; "B"', ...MONTHS.slice(1)] });
    expect(quoted.split("\n")[1]).toBe('"A; ""B""";100.00;');
  });
});

describe("ChartPanel", () => {
  let saved: { name: string; type: string }[] = [];
  beforeEach(() => {
    saved = [];
    fake.options.length = 0;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ name: this.download, type: "" });
    });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const lastZoom = () => (fake.options.at(-1) as { dataZoom: Zoom[] }).dataZoom[0]!;

  it("zooms in and out with its buttons, resets the scale and follows a gesture in the chart", async () => {
    const user = userEvent.setup();
    render(<ChartPanel chart={chart} />);
    const zoomOutButton = screen.getByRole("button", { name: "Reduzir" });
    const reset = screen.getByRole("button", { name: "Redefinir escala" });
    await waitFor(() => expect(fake.options.length).toBeGreaterThan(0));
    expect(zoomOutButton).toHaveProperty("disabled", true);
    expect(reset).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Ampliar" }));
    await waitFor(() => expect([lastZoom().startValue, lastZoom().endValue]).toEqual([2, 4]));
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("mostrando jul/26 a set/26");
    expect(reset).toHaveProperty("disabled", false);
    // choosing a value outside the window brings it into view
    await user.click(screen.getByRole("button", { name: "out/26" }));
    await waitFor(() => expect([lastZoom().startValue, lastZoom().endValue]).toEqual([3, 5]));
    await user.click(reset);
    await waitFor(() => expect(lastZoom().startValue).toBeUndefined());
    expect(reset).toHaveProperty("disabled", true);
    // Ctrl + wheel or the slider in the chart: the panel reads the window back
    fake.handlers.get("datazoom")!({});
    await waitFor(() => expect([lastZoom().startValue, lastZoom().endValue]).toEqual([2, 4]));
    await user.click(screen.getByRole("button", { name: "Reduzir" }));
    await waitFor(() => expect(lastZoom().startValue).toBeUndefined());
  });

  it("exports the values as CSV and the image only after asking, and says the file is not encrypted", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ChartPanel chart={chart} firstColumn="Data" />
        <DecisionHost />
        <Toaster />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Exportar valores…" }));
    let ask = await screen.findByRole("alertdialog", { name: "Exportar valores sem criptografia?" });
    await user.click(within(ask).getByRole("button", { name: "Cancelar" }));
    expect(saved).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Exportar valores…" }));
    ask = await screen.findByRole("alertdialog", { name: "Exportar valores sem criptografia?" });
    await user.click(within(ask).getByRole("button", { name: "Exportar" }));
    await waitFor(() => expect(saved.map((file) => file.name)).toEqual(["Evolucao do investimento.csv"]));
    expect(await screen.findByText(/Arquivo CSV gerado. Guarde-o com cuidado/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Exportar imagem…" }));
    ask = await screen.findByRole("alertdialog", { name: "Exportar imagem sem criptografia?" });
    await user.click(within(ask).getByRole("button", { name: "Exportar" }));
    await waitFor(() => expect(saved.map((file) => file.name)).toContain("Evolucao do investimento.png"));
  });

  it("leaves the exports to the page that owns them, and has no zoom for a short chart", () => {
    const exportRef = { current: null as (() => boolean) | null };
    render(<ChartPanel chart={{ ...chart, categories: MONTHS.slice(0, 3) }} exportRef={exportRef} />);
    expect(screen.queryByRole("button", { name: "Exportar valores…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Exportar imagem…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ampliar" })).toBeNull();
    expect(typeof exportRef.current).toBe("function");
  });
});
