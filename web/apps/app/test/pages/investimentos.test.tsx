/** Investimentos: the portfolio, the selected investment's figures, charts and tables; empty and read-only projects. */
import { Dec, charts, formatBrl, formatDateBr, formatDecimalBr, investments, makeDate } from "@opesvault/domain";
import { tableRows as chartRows } from "@opesvault/ui";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { toInvestmentChart, toPercentChart } from "../../src/pages/investimentos/chart.ts";
import { cdbOf, flat, openInvestimentos, rowOf, selectedRow, snapshot, table } from "./investimentos_harness.tsx";

vi.mock("../../../../packages/ui/src/chart/echarts.ts", async () => await import("./fake_echarts.ts"));

const { performance, service, returns } = investments;

describe("Investimentos: carteira e detalhe", () => {
  it("lists each position with cost, last value, base date, unrealized and realized, equal to the domain's", async () => {
    const { ledger, workspace } = await openInvestimentos();
    const grid = await table("Investimentos");
    const id = cdbOf(ledger);
    const today = workspace.today();
    const observed = performance.valueAt(ledger, id, today)!;
    const gain = performance.unrealized(ledger, id, today);
    const text = flat(rowOf(grid, "CDB Banco X 2028").textContent);
    expect(text).toContain("Renda fixa");
    expect(text).toContain("Valor");
    expect(text).toContain(formatBrl(service.remainingCost(ledger, id)));
    expect(text).toContain(formatBrl(observed.valuation.value));
    expect(text).toContain(`${formatDateBr(observed.valuation.on)} (Bruto)`);
    expect(text).toContain(formatBrl(gain.value!));
    expect(text).toContain(formatBrl(performance.realized(ledger, id).value!));
    expect(screen.getByText("1 em carteira")).toBeTruthy();
    // the first position is selected by itself
    expect(selectedRow(grid)).toBe(rowOf(grid, "CDB Banco X 2028"));
  });

  it("shows the key figures of the selected investment: value, cost, unrealized and maturity", async () => {
    const { ledger, workspace } = await openInvestimentos();
    const id = cdbOf(ledger);
    const today = workspace.today();
    const observed = performance.valueAt(ledger, id, today)!;
    const heading = await screen.findByRole("heading", { level: 2, name: "CDB Banco X 2028" });
    const detail = heading.closest("div.flex-col")!.parentElement!;
    await waitFor(() => expect(flat(detail.textContent)).toContain(formatBrl(observed.valuation.value)));
    const text = flat(detail.textContent);
    expect(text).toContain(formatBrl(service.remainingCost(ledger, id)));
    expect(text).toContain(formatBrl(performance.unrealized(ledger, id, today).value!));
    expect(text).toContain("03/01/2028");
    // type, where it is held, yield and tax treatment come from the characteristics
    expect(text).toContain("04.02");
    expect(text).toContain("110% do CDI");
    expect(text).toContain("Retido na fonte");
    expect(text).toContain("resultado não realizado (valor observado − custo remanescente)");
  });

  it("draws the evolution with its values: gross series, same dates as the domain's chart", async () => {
    const { ledger } = await openInvestimentos();
    const id = cdbOf(ledger);
    const domainChart = charts.data.investmentEvolution(ledger, id);
    const data = toInvestmentChart(domainChart);
    const rows = chartRows(data);
    expect(rows.length).toBe(performance.selectedSeries(ledger, id).length);
    const section = await screen.findByRole("region", { name: "Evolução" });
    const values = within(section).getByRole("table", { name: /Valores de Evolução do investimento/ });
    for (const row of rows) expect(flat(values.textContent)).toContain(row.cells[0]);
    expect(flat(values.textContent)).toContain("Valor bruto");
  });

  it("keeps markers as points and joins the observed values across dates (the chart adapter)", async () => {
    const { ledger, workspace } = await openInvestimentos();
    const id = cdbOf(ledger);
    workspace.act((l) =>
      service.contribute(
        l,
        id,
        "100",
        makeDate(2026, 2, 10),
        [...l.accounts.values()].find((a) => a.name === "Banco A")!.id,
      ),
    );
    const data = toInvestmentChart(charts.data.investmentEvolution(ledger, id));
    const marker = data.series.find((s) => s.name === "Aporte")!;
    expect(marker.kind).toBe("scatter");
    expect(data.series.find((s) => s.name === "Valor bruto")!.connect).toBe(true);
    // a percent chart carries ratios: 1,23% is 0.0123, drawn as 1.23
    const [first, last] = [makeDate(2026, 1, 28), makeDate(2026, 3, 28)];
    const pct = toPercentChart(charts.data.returnsChart(ledger, id, first, last));
    const method = returns.allMethods(ledger, id, first, last).find((r) => r.value !== null)!;
    expect(pct.series[0]!.values).toContain(method.value!.mul(Dec.from(100)).toFixed());
  });

  it("shows every return method for the chosen period, computed after the screen paints", async () => {
    const { ledger } = await openInvestimentos();
    const id = cdbOf(ledger);
    const grid = await table("Rentabilidade por método");
    // the quick methods come first; the internal rate of return finishes after (in a worker, where there is one)
    await waitFor(() => expect(within(grid).queryByText("calculando…")).toBeNull());
    const dates = investments.performance.selectedSeries(ledger, id).map((v) => v.on);
    const results = returns.allMethods(ledger, id, dates[0]!, dates[dates.length - 1]!);
    expect(within(grid).getAllByRole("row").length - 1).toBe(results.length);
    for (const result of results) {
      const row = flat(rowOf(grid, result.method).textContent);
      if (result.value === null) {
        expect(row).toContain("indisponível");
        expect(row).toContain(result.notes[0]!);
      } else {
        expect(row).toContain(`${formatDecimalBr(result.value.mul(Dec.from(100)), 2)}%`);
      }
    }
  });
});

describe("Investimentos: projeto vazio e somente leitura", () => {
  it("an empty project says what to do and offers the first investment; every table and chart is empty, not broken", async () => {
    const { user } = await openInvestimentos("/investimentos", { empty: true });
    expect(await screen.findByText("Nenhum investimento")).toBeTruthy();
    expect(screen.queryByRole("grid", { name: "Investimentos" })).toBeNull();
    expect(screen.getByText("0 em carteira")).toBeTruthy();
    expect(screen.getByText("Nenhuma nota de negociação")).toBeTruthy();
    // the header menus answer instead of failing without a selection
    await user.click(screen.getByRole("button", { name: "Registrar" }));
    await user.click(await screen.findByRole("menuitem", { name: "Aporte…" }));
    expect(await screen.findByText("Selecione um investimento.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables every editing command of a read-only project, with the reason, and changes nothing", async () => {
    const { user, ledger } = await openInvestimentos("/investimentos", { readOnly: true });
    const before = snapshot(ledger);
    const button = screen.getAllByRole("button", { name: "Novo investimento…" })[0] as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("editando este projeto");
    await user.click(screen.getByRole("button", { name: "Mais" }));
    const items = await screen.findAllByRole("menuitem");
    for (const item of items) {
      const name = item.textContent ?? "";
      // going to Relatórios is not an edit
      if (name.startsWith("Composição")) expect(item.getAttribute("aria-disabled")).not.toBe("true");
      else expect(item.getAttribute("aria-disabled") ?? item.getAttribute("data-disabled"), name).not.toBeNull();
    }
    expect(snapshot(ledger)).toBe(before);
  });
});
