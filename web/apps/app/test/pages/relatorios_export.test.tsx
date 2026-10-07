/** Relatórios: the image and the values leave the project only after asking; the year-end report; states. */
import { Dec, charts, exporting, formatBrl } from "@opesvault/domain";
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { annualReportData } from "../../src/pages/relatorios/annual.ts";
import { REPORTS, buildChart, valuesCsv } from "../../src/pages/relatorios/reports.ts";
import { choose, setViewport } from "../dom.ts";
import { openPrint, openReport, openReports, paramsOf } from "./relatorios_harness.tsx";
import { cellText } from "../../src/pages/visao-geral/report.ts";
import { addressSettles } from "../navigations.ts";

afterEach(() => vi.restoreAllMocks());

/** Collects what the page offers to save (a link click with a name, or a blob). */
function captureSaves() {
  const names: string[] = [];
  const blobs: Blob[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    names.push(this.download);
  });
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    blobs.push(blob as Blob);
    return "blob:test";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  return { names, blobs };
}

const ask = () => screen.findByRole("alertdialog");

describe("Relatórios: exporting", () => {
  it("asks before saving the image of the chart, then downloads it named after the chart", async () => {
    const saves = captureSaves();
    const { user } = await openReports();
    await user.click(screen.getByRole("button", { name: "Exportar imagem…" }));
    const dialog = await ask();
    expect(within(dialog).getAllByText(/sem criptografia/).length).toBeGreaterThan(0);
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(saves.names).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Exportar imagem…" }));
    await user.click(within(await ask()).getByRole("button", { name: "Exportar" }));
    expect(saves.names).toEqual(["Entradas e saidas mensais.png"]);
    expect(await screen.findByText(/Imagem do gráfico gerada/)).toBeTruthy();
  });

  it("names the image after the report that is open", async () => {
    const saves = captureSaves();
    const { user } = await openReports();
    await openReport(user, "Patrimônio");
    await user.click(screen.getByRole("button", { name: "Exportar imagem…" }));
    await user.click(within(await ask()).getByRole("button", { name: "Exportar" }));
    expect(saves.names).toHaveLength(1);
    expect(saves.names[0]).toMatch(/\.png$/);
  });

  it("says what to do when the chart section is folded", async () => {
    const saves = captureSaves();
    const { user } = await openReports();
    await user.click(screen.getByRole("button", { name: /^Entradas e saídas mensais$/, expanded: true }));
    await user.click(screen.getByRole("button", { name: "Exportar imagem…" }));
    await user.click(within(await ask()).getByRole("button", { name: "Exportar" }));
    expect(await screen.findByText("Abra a seção do gráfico para exportar a imagem.")).toBeTruthy();
    expect(saves.names).toEqual([]);
  });

  it("asks before saving the table as CSV, with the domain's values", async () => {
    const saves = captureSaves();
    const { ledger, now, workspace, user } = await openReports();
    await user.click(screen.getByRole("button", { name: "Exportar valores…" }));
    await user.click(within(await ask()).getByRole("button", { name: "Cancelar" }));
    expect(saves.blobs).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Exportar valores…" }));
    await user.click(within(await ask()).getByRole("button", { name: "Exportar" }));
    expect(saves.names).toEqual(["valores-in_out.csv"]);
    const chart = buildChart(ledger, "in_out", paramsOf(now, workspace.today()));
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await saves.blobs[0]!.arrayBuffer());
    expect(text).toBe(valuesCsv(chart));
    const lines = text.split("\n").filter(Boolean);
    expect(lines[0]).toBe("\uFEFFitem;Entradas;Saídas");
    expect(lines[1]).toMatch(/^\d{4}-\d{2};\d+(\.\d+)?;\d+(\.\d+)?$/);
    expect(lines.at(-2)).toMatch(/^Total;/);
    expect(lines.at(-1)).toMatch(/^Média;/);
  });

  it("neutralizes formulas in the names and items of the CSV, not in the values", () => {
    const { chart, point, series } = charts.data;
    const made = chart("t", "BRL", [
      series("+Série", [point("=cmd()", Dec.parse("-10.50")), point("2026-01", Dec.parse("3"))]),
    ]);
    const lines = valuesCsv(made).replace("\uFEFF", "").split("\n");
    expect(lines[0]).toBe("item;'+Série");
    expect(lines).toContain("'=cmd();-10.50");
    expect(lines).toContain("2026-01;3");
  });
});

describe("Relatórios: the year-end closing", () => {
  const escape = (text: string) =>
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#x27;");

  it("has the same figures as the domain's HTML report, section by section", async () => {
    const { ledger } = await openReports();
    for (const year of [2026, 2025]) {
      const html = exporting.annualReportHtml(ledger, year);
      const data = annualReportData(ledger, year);
      expect(html).toContain(`${escape(data.project)} — fechamento de ${year}`);
      expect(html).toContain(escape(`${data.warning} ${data.notice}`));
      for (const table of [data.balances, data.income, data.investments]) {
        expect(html).toContain(`<h2>${table.title}</h2>`);
        for (const row of table.rows)
          for (const c of row) expect(html, table.title).toContain(`>${escape(cellText(c))}</td>`);
      }
      expect(html).toContain(`Patrimônio líquido em 31/12/${year}: <b>${formatBrl(data.netWorth)}</b>`);
      expect(html).toContain("<h2>Despesas dedutíveis</h2>");
      expect(html).toContain(escape(data.deductibleNotice));
      for (const group of data.deductibles) {
        expect(html).toContain(`<b>${escape(group.title)}: ${formatBrl(group.total)}</b>`);
        for (const row of group.table.rows) for (const c of row) expect(html).toContain(`>${escape(cellText(c))}</td>`);
      }
      if (data.incomplete) expect(html).toContain(data.incomplete);
      else expect(html).not.toContain("ficaram fora dos ganhos");
    }
    // the demonstration project has a year with deductible expenses
    expect(annualReportData(ledger, 2026).deductibles.length).toBeGreaterThan(0);
  });

  it("opens the print view for the year chosen, which prints and downloads the same report", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    const saves = captureSaves();
    const { ledger, router, user } = await openReports();
    await openReport(user, "Fechamento do ano");
    await choose(user, "Ano", "Ano de 2025");
    await user.click(screen.getByRole("button", { name: "Relatório anual (PDF)…" }));
    const data = annualReportData(ledger, 2025);
    await screen.findByRole("heading", { level: 1, name: `${data.project} — fechamento de 2025` });
    expect(router.state.location.pathname).toBe("/imprimir/relatorio-anual");
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await addressSettles(router, { ano: "2025" });
    for (const title of [
      `Bens e dívidas em 31/12/2025`,
      "Receitas do ano por categoria",
      "Investimentos",
      "Despesas dedutíveis",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeTruthy();
    }
    for (const row of data.balances.rows) expect(screen.getAllByText(String(row[0])).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Imprimir ou salvar em PDF" }));
    expect(print).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Baixar como arquivo HTML" }));
    expect(saves.names).toEqual(["fechamento-2025.html"]);
    expect(await saves.blobs[0]!.text()).toBe(exporting.annualReportHtml(ledger, 2025));
    // and back to the reports, on the closing
    await user.click(screen.getByRole("button", { name: "Voltar aos Relatórios" }));
    await screen.findByRole("heading", { level: 1, name: "Relatórios" });
    await waitFor(() =>
      expect(
        within(screen.getByRole("navigation", { name: "Relatórios" }))
          .getByRole("button", { name: "Fechamento do ano" })
          .getAttribute("aria-current"),
      ).toBe("true"),
    );
  });

  it("draws the report of a year with deductible expenses, and of one with none", async () => {
    vi.stubGlobal("print", vi.fn());
    const { router, ledger } = await openPrint("/imprimir/relatorio-anual?ano=2026");
    await screen.findByRole("heading", { level: 2, name: "Despesas dedutíveis" });
    const group = annualReportData(ledger, 2026).deductibles[0]!;
    expect(screen.getByText(`${group.title}: ${formatBrl(group.total)}`)).toBeTruthy();
    await act(async () => {
      await router.navigate({ to: "/imprimir/relatorio-anual", search: { ano: "1999" } });
    });
    expect(await screen.findByText("Nenhuma despesa dedutível no ano.")).toBeTruthy();
    expect(screen.getAllByText("Nada no período.").length).toBeGreaterThan(0);
  });
});

describe("Relatórios: states", () => {
  it("shows every report of an empty project with its empty state, and nothing leaves", async () => {
    const { user } = await openReports("/relatorios", { project: "blank" });
    for (const report of REPORTS) {
      await openReport(user, report.label);
      expect(await screen.findByText("Sem dados neste relatório"), report.label).toBeTruthy();
      expect(screen.queryByRole("table", { name: /Valores de/ })).toBeNull();
      expect(screen.getByRole("button", { name: "Exportar imagem…" }).hasAttribute("disabled")).toBe(true);
      expect(screen.getByRole("button", { name: "Ver lançamentos" }).hasAttribute("disabled")).toBe(true);
    }
  });

  it("prints the closing of an empty project without breaking", async () => {
    vi.stubGlobal("print", vi.fn());
    await openPrint("/imprimir/relatorio-anual?ano=2026", { project: "blank" });
    expect(await screen.findByRole("heading", { level: 1, name: /fechamento de 2026/ })).toBeTruthy();
    expect(screen.getByText("Nenhuma despesa dedutível no ano.")).toBeTruthy();
  });

  it("chooses the report from a list on a phone", async () => {
    const { ledger, now, workspace, user } = await openReports("/relatorios", { width: 390 });
    expect(screen.queryByRole("navigation", { name: "Relatórios" })).toBeNull();
    await choose(user, "Relatório", "Patrimônio");
    const chart = buildChart(ledger, "net_worth", paramsOf(now, workspace.today()));
    expect(await screen.findByRole("table", { name: `Valores de ${chart.title}` })).toBeTruthy();
    setViewport(1600);
  });
});
