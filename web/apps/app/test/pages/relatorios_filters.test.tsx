/** The filters of Relatórios: by account, member, category, tag, period, year, average and horizon. */
import { charts, dom, ymAdd } from "@opesvault/domain";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { account, category, choose } from "./livro_harness.tsx";
import { SCOPES } from "../../src/pages/relatorios/reports.ts";
import { expectTable, openReport, openReports } from "./relatorios_harness.tsx";

vi.mock("../../../../packages/ui/src/chart/echarts.ts", () => import("./fake_echarts.ts"));

const filters = () => screen.queryByRole("group", { name: "Filtros do relatório" });

describe("Relatórios: filters", () => {
  it("offers a filter only to the reports with a defined reading", async () => {
    const { user } = await openReports();
    const withFilter = new Set<string>();
    const names: Record<string, string> = {
      "Entradas e saídas mensais": "in_out",
      "Resultado mensal (competência)": "result",
      "Fluxo de caixa": "cash",
      "Saldo projetado": "projected_balance",
      "Despesas por categoria": "categories",
      "Comparação com a média": "comparison",
      Patrimônio: "net_worth",
      "Composição da carteira": "composition",
      "Projeção de compromissos": "projection",
      "Despesas por estabelecimento": "merchants",
      Marcadores: "tags",
      "Despesas dedutíveis": "deductibles",
      "Fechamento do ano": "annual",
    };
    for (const [label, key] of Object.entries(names)) {
      await openReport(user, label);
      const group = filters();
      // the period applies to monthly ranges only; the other filter to the reports in SCOPES
      const combos = group ? within(group).getAllByRole("combobox").length : 0;
      const monthly = ["in_out", "result", "cash", "categories", "net_worth", "merchants"].includes(key);
      const scoped = key in SCOPES;
      expect(combos, label).toBe((monthly ? 1 : 0) + (scoped ? 1 : 0));
      if (scoped) withFilter.add(key);
    }
    expect([...withFilter].sort()).toEqual(Object.keys(SCOPES).sort());
  });

  it("filters the entries and exits, the cash flow and the categories by account or category", async () => {
    const { ledger, now, user } = await openReports();
    const bank = account({ workspace: { ledger } } as never, "Banco A");
    await choose(user, "Conta", "Banco A");
    await expectTable(charts.data.monthlyInOut(ledger, ymAdd(now, -11), now, [bank.id]));
    await choose(user, "Conta", "Todas as contas");
    await expectTable(charts.data.monthlyInOut(ledger, ymAdd(now, -11), now, null));
    await openReport(user, "Fluxo de caixa");
    await choose(user, "Conta", "Banco A");
    await expectTable(charts.data.cashFlowBalance(ledger, ymAdd(now, -11), now, [bank.id]));
    await openReport(user, "Despesas por categoria");
    const food = category({ workspace: { ledger } } as never, "Alimentação");
    await choose(user, "Categoria", "Alimentação");
    await expectTable(charts.data.categoryMonthly(ledger, food.id, ymAdd(now, -11), now));
  });

  it("shows the result of one member", async () => {
    const { ledger, now, user } = await openReports();
    await openReport(user, "Resultado mensal (competência)");
    const bruno = [...ledger.members.values()].find((m) => m.name === "Bruno")!;
    await choose(user, "Integrante", "Bruno");
    const chart = charts.data.monthlyResult(ledger, ymAdd(now, -11), now, bruno.id);
    await expectTable(chart);
    expect(await screen.findByText(/Visão de Bruno/)).toBeTruthy();
  });

  it("changes the period of the monthly reports", async () => {
    const { ledger, now, user } = await openReports();
    await choose(user, "Período", "Últimos 6 meses");
    await expectTable(charts.data.monthlyInOut(ledger, ymAdd(now, -5), now, null));
    await choose(user, "Período", "Últimos 24 meses");
    await expectTable(charts.data.monthlyInOut(ledger, ymAdd(now, -23), now, null));
    expect(screen.getByText(/De .* a outubro de 2026/)).toBeTruthy();
  });

  it("changes the window of the comparison and the horizon of the projected balance", async () => {
    const { ledger, now, workspace, user } = await openReports();
    await openReport(user, "Comparação com a média");
    await choose(user, "Média de comparação", "Média de 6 meses");
    await expectTable(charts.data.categoryComparisonChart(ledger, now, 6));
    await openReport(user, "Saldo projetado");
    // 60 days is the default, as on the desktop
    await expectTable(charts.data.projectedBalance(ledger, workspace.today(), 60));
    await choose(user, "Horizonte", "Próximos 30 dias");
    await expectTable(charts.data.projectedBalance(ledger, workspace.today(), 30));
  });

  it("narrows the markers to one", async () => {
    const { ledger, user } = await openReports();
    await openReport(user, "Marcadores");
    await expectTable(charts.data.tagsOverview(ledger));
    const tag = dom.tags.allTags(ledger)[0]!;
    await choose(user, "Marcador", tag);
    await expectTable(charts.data.tagChart(ledger, tag));
  });

  it("follows the shared month, and the year of the closing and of the deductibles follows it", async () => {
    const { ledger, now, user } = await openReports();
    await openReport(user, "Fechamento do ano");
    await expectTable(charts.data.annualChart(ledger, now.year));
    await choose(user, "Ano", `Ano de ${now.year - 1}`);
    await expectTable(charts.data.annualChart(ledger, now.year - 1));
    await openReport(user, "Despesas dedutíveis");
    // another report: back to the shared month's year
    expect(screen.getByRole("combobox", { name: "Ano" }).textContent).toContain(String(now.year));
    await choose(user, "Ano", `Ano de ${now.year - 1}`);
    // a year with no deductible expense is an empty report, not a broken one
    expect(await screen.findByText("Sem dados neste relatório")).toBeTruthy();
    expect(screen.queryByRole("table", { name: /Valores de/ })).toBeNull();
    // the month picker of the page is the shared month: going back a year changes the year of the report
    await user.click(screen.getAllByRole("button", { name: "Mês anterior" })[0]!);
    await openReport(user, "Entradas e saídas mensais");
    expect(screen.getByText(/De .* a setembro de 2026/)).toBeTruthy();
    await expectTable(charts.data.monthlyInOut(ledger, ymAdd(now, -12), ymAdd(now, -1), null));
  });
});
