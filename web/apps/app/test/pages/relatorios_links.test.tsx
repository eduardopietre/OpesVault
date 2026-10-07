/** Links in and out of Relatórios: a report opened by key, and "Ver lançamentos" to the Livro. */
import { AccountType, dom, ymAdd, ymFirstDay, ymLastDay, ymStr } from "@opesvault/domain";
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parseReveal } from "../../src/pages/livro/rows.ts";
import {
  REPORTS,
  buildChart,
  chosenScope,
  inspect,
  isReportKey,
  ledgerRef,
  type ReportKey,
} from "../../src/pages/relatorios/reports.ts";
import { account, choose } from "./livro_harness.tsx";
import { openReport, openReports, paramsOf, valuesTable } from "./relatorios_harness.tsx";
import { addressSettles } from "../navigations.ts";

vi.mock("../../../../packages/ui/src/chart/echarts.ts", () => import("./fake_echarts.ts"));

const current = () => {
  const list = screen.getByRole("navigation", { name: "Relatórios" });
  return within(list)
    .getAllByRole("button")
    .find((b) => b.getAttribute("aria-current") === "true")?.textContent;
};

describe("Relatórios: reports opened by link (ref)", () => {
  it("opens the projected balance and the comparison, as the notices and the overview send", async () => {
    const { router } = await openReports();
    await act(async () => {
      await router.navigate({ to: "/relatorios", search: { ref: "projected_balance" } });
    });
    await waitFor(() => expect(current()).toBe("Saldo projetado"));
    await addressSettles(router, {});
    await act(async () => {
      await router.navigate({ to: "/relatorios", search: { ref: "comparison" } });
    });
    await waitFor(() => expect(current()).toBe("Comparação com a média"));
  });

  it.each(REPORTS.map((r) => [r.key, r.label] as const))("opens %s by its key", async (key, label) => {
    const { router } = await openReports();
    await act(async () => {
      await router.navigate({ to: "/relatorios", search: { ref: key } });
    });
    await waitFor(() => expect(current()).toBe(label));
  });

  it("ignores a ref that is not a report", async () => {
    const { router } = await openReports("/relatorios?ref=nada");
    await addressSettles(router, {});
    expect(current()).toBe("Entradas e saídas mensais");
    expect(isReportKey("nada")).toBe(false);
  });

  it("can be opened with the link already in the address", async () => {
    await openReports("/relatorios?ref=annual");
    await waitFor(() => expect(current()).toBe("Fechamento do ano"));
    expect(await screen.findByRole("button", { name: "Relatório anual (PDF)…" })).toBeTruthy();
  });
});

describe("Relatórios: what stands behind a point (Ver lançamentos)", () => {
  it("is disabled until a point is chosen, which is described beside the chart", async () => {
    const { ledger, now, user } = await openReports();
    const see = screen.getByRole("button", { name: "Ver lançamentos" });
    expect(see.hasAttribute("disabled")).toBe(true);
    const chart = buildChart(ledger, "in_out", paramsOf(now, "2026-10-06"));
    const table = await valuesTable(chart.title);
    const last = within(table).getByRole("button", { name: "out/26" });
    await user.click(last);
    const point = screen.getByRole("group", { name: "Dados do ponto selecionado" });
    const text = inspect(chart, 11)!;
    expect(within(point).getByText(text.title)).toBeTruthy();
    for (const line of text.values) expect(within(point).getByText(line)).toBeTruthy();
    for (const line of text.details) expect(within(point).getByText(line)).toBeTruthy();
    expect(text.values.length).toBe(2);
    expect(see.hasAttribute("disabled")).toBe(false);
    // choosing the row again clears the choice
    await user.click(last);
    expect(see.hasAttribute("disabled")).toBe(true);
  });

  it("goes to the Livro with the month of the point, of the account chosen, and keeps the filters there", async () => {
    const { user, router } = await openReports();
    await choose(user, "Conta", "Banco A");
    const table = await valuesTable("Entradas e saídas mensais");
    await user.click(within(table).getByRole("button", { name: "out/26" }));
    await user.click(screen.getByRole("button", { name: "Ver lançamentos" }));
    await screen.findByRole("heading", { level: 1, name: "Livro financeiro" });
    expect(router.state.location.pathname).toBe("/livro");
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Período" }).textContent).toContain("Outubro de 2026"),
    );
    expect(screen.getByRole("combobox", { name: "Conta ou categoria" }).textContent).toContain("Banco A");
  });

  it("goes to the Livro with a marker, from the markers report", async () => {
    const { ledger, user } = await openReports();
    await openReport(user, "Marcadores");
    const table = await valuesTable("Marcadores");
    await user.click(within(table).getAllByRole("button")[0]!);
    await user.click(screen.getByRole("button", { name: "Ver lançamentos" }));
    await screen.findByRole("heading", { level: 1, name: "Livro financeiro" });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Marcador" })).toBeTruthy());
    expect(dom.tags.allTags(ledger).length).toBeGreaterThan(0);
  });

  it("builds the Livro's ref of every report made of operations, and none for the others", async () => {
    const { ledger, now, workspace } = await openReports();
    const today = workspace.today();
    const params = (_key: ReportKey, scope: string | null = null, months = 12) =>
      paramsOf(now, today, { scope, months });
    const ref = (key: ReportKey, index: number, scope: string | null = null, months = 12) => {
      const p = params(key, scope, months);
      return ledgerRef(ledger, key, buildChart(ledger, key, p), index, p);
    };
    const bank = account({ workspace: { ledger } } as never, "Banco A").id;
    const ana = [...ledger.members.values()].find((m) => m.name === "Ana")!.id;
    const may = ymStr(ymAdd(now, -11));

    // the project in a month, then an account in a month, then a member's month
    expect(parseReveal(ref("in_out", 0)!)).toEqual({
      kind: "filter",
      id: null,
      month: ymAdd(now, -11),
      range: null,
      member: null,
    });
    expect(ref("in_out", 0, bank)).toBe(`filter:${bank}:${may}`);
    expect(ref("cash", 11, bank)).toBe(`filter:${bank}:${ymStr(now)}`);
    expect(ref("result", 11, ana)).toBe(`filter::${ymStr(now)}:${ana}`);

    // a category over the whole period, or in the month of a bar
    const chart = buildChart(ledger, "categories", params("categories"));
    const first = chart.series[0]!.points[0]!.x;
    const categoryId = ledger.categories(AccountType.EXPENSE).find((c) => c.name === first)!.id;
    const start = ymAdd(now, -11);
    expect(ref("categories", 0)).toBe(`filter:${categoryId}:${ymFirstDay(start)}..${ymLastDay(now)}`);
    const food = ledger.categories(AccountType.EXPENSE).find((c) => c.name === "Alimentação")!.id;
    expect(ref("categories", 3, food)).toBe(`filter:${food}:${ymStr(ymAdd(now, -8))}`);

    // a category in the month of the comparison
    const comparison = buildChart(ledger, "comparison", params("comparison"));
    const name = comparison.series[0]!.points[0]!.x;
    const id = ledger.categories(AccountType.EXPENSE).find((c) => c.name === name)!.id;
    expect(ref("comparison", 0)).toBe(`filter:${id}:${ymStr(now)}`);

    // a marker (the chosen one, or the point's own)
    const tag = dom.tags.allTags(ledger)[0]!;
    expect(ref("tags", 0, tag)).toBe(`marcador:${tag}`);
    expect(ref("tags", 0)).toMatch(/^marcador:/);

    // a deductible category in the whole year
    const deductible = ref("deductibles", 0)!;
    expect(deductible).toMatch(new RegExp(`^filter:[^:]+:${now.year}-01-01\\.\\.${now.year}-12-31$`));

    for (const key of ["net_worth", "composition", "projection", "merchants", "annual", "projected_balance"] as const) {
      expect(ref(key, 0), key).toBeNull();
    }
    // a point that does not exist has no origin
    expect(ref("in_out", 99)).toBeNull();
    expect(chosenScope(ledger, "in_out", params("in_out", "id-que-nao-existe"))).toBeNull();
  });
});
