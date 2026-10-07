/** Empty pages point to the next concrete action: Orçamento, Metas and Investimentos. */
import { Dec, dom, formatBrl, queries, ym, ymAdd, type Ledger } from "@opesvault/domain";
import { act as reactAct, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { chooseMonth } from "../../src/data/month.ts";
import { averageSpending } from "../../src/dialogs/budget_logic.ts";
import { goalExample } from "../../src/pages/metas/rows.ts";
import { navigations, wentTo } from "../navigations.ts";
import { mountPage } from "./overview_calendar_helpers.tsx";

vi.mock("../../../../packages/ui/src/chart/echarts.ts", () => import("./fake_echarts.ts"));

const money = (value: Dec) => formatBrl(value).replace("R$", "").trim();
const categoryId = (ledger: Ledger, name: string) =>
  [...ledger.accounts.values()].find((account) => account.name === name)!.id;

describe("Orçamento without a plan", () => {
  it("creates the month's plan from the average of the last three months, checked before saving", async () => {
    // April 2026 of the demonstration has no plan; January to March have spending.
    reactAct(() => chooseMonth(ym(2026, 4)));
    const { workspace } = await mountPage("/orcamento");
    const user = userEvent.setup();
    const ledger = workspace.ledger;
    const april = ym(2026, 4);
    await screen.findByRole("heading", { name: "Sem orçamento em abril de 2026" });
    expect(screen.getByText(/Crie o orçamento do mês a partir dos gastos dos últimos 3 meses/)).toBeTruthy();
    const primary = screen.getByRole("button", { name: "Criar a partir dos últimos 3 meses…" });
    expect(primary.getAttribute("data-variant")).toBe("primary");
    expect(screen.getByRole("button", { name: "Copiar do mês anterior" }).getAttribute("data-variant")).toBe(
      "secondary",
    );
    await user.click(primary);
    const dialog = await screen.findByRole("dialog", { name: "Orçamento de abril de 2026" });
    expect(
      within(dialog).getByText(/a média do gasto de cada categoria de janeiro de 2026 a março de 2026/),
    ).toBeTruthy();
    // each category starts with its average: the three months' spending divided by three, in cents
    const spent = queries.expensesByCategory(ledger, ym(2026, 1), ym(2026, 3));
    const expected = averageSpending(ledger, april);
    expect(expected.size).toBeGreaterThan(0);
    for (const [id, average] of expected) {
      expect(average.eq(spent.get(id)!.div(3).quantize("0.01", "ROUND_HALF_UP"))).toBe(true);
      const name = ledger.account(id).name;
      expect((within(dialog).getByLabelText(`Planejado para ${name}`) as HTMLInputElement).value).toBe(money(average));
    }
    // nothing is written before Salvar
    expect(dom.budget.linesOf(ledger, april)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Salvar orçamento" }));
    await waitFor(() => expect(dom.budget.linesOf(ledger, april)).toHaveLength(expected.size));
    expect(dom.budget.lineFor(ledger, categoryId(ledger, "Moradia"), april)?.amount.eq("2350")).toBe(true);
    expect(workspace.undoStack.undoLabel()).toBe("orçamento de abril de 2026");
  });

  it("without earlier spending, defining the month is the first step", async () => {
    reactAct(() => chooseMonth(ym(2026, 10)));
    await mountPage("/orcamento", { empty: true });
    await screen.findByRole("heading", { name: "Sem orçamento em outubro de 2026" });
    expect(screen.queryByRole("button", { name: /Criar a partir/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copiar do mês anterior" })).toBeNull();
    expect(screen.getByRole("button", { name: "Definir o mês…" }).getAttribute("data-variant")).toBe("primary");
  });
});

describe("Metas without goals", () => {
  it("the example is an emergency reserve of six months of the average spending, within a year", async () => {
    const { workspace } = await mountPage("/metas");
    const ledger = workspace.ledger;
    const on = workspace.today();
    const example = goalExample(ledger, on);
    const month = ym(Number(on.slice(0, 4)), Number(on.slice(5, 7)));
    const total = Dec.sum(queries.expensesByCategory(ledger, ymAdd(month, -3), ymAdd(month, -1)).values());
    expect(example.name).toBe("Reserva de emergência");
    if (total.isPositive()) {
      expect(example.target?.eq(total.div(3).mul(6).quantize("0.01", "ROUND_HALF_UP"))).toBe(true);
    } else {
      expect(example.target).toBeNull();
    }
    expect(example.targetDate.slice(0, 4)).toBe(String(Number(on.slice(0, 4)) + 1));
  });

  it("Definir uma meta opens the new-goal form with the example, saved only when confirmed", async () => {
    const { workspace } = await mountPage("/metas", { empty: true });
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Nenhuma meta" });
    const primary = screen.getByRole("button", { name: "Definir uma meta…" });
    expect(primary.getAttribute("data-variant")).toBe("primary");
    await user.click(primary);
    const dialog = await screen.findByRole("dialog", { name: "Nova meta" });
    expect((within(dialog).getByLabelText("Nome") as HTMLInputElement).value).toBe("Reserva de emergência");
    // an empty project has no spending: the value is left for the person (unknown is not zero)
    expect((within(dialog).getByLabelText("Valor da meta") as HTMLInputElement).value).toBe("");
    expect(within(dialog).getByText(/Um exemplo para começar/)).toBeTruthy();
    expect(workspace.ledger.entities("goal").size).toBe(0);
    await user.type(within(dialog).getByLabelText("Valor da meta"), "30.000,00");
    await user.click(within(dialog).getByRole("button", { name: "Criar meta" }));
    await waitFor(() => expect(workspace.ledger.entities("goal").size).toBe(1));
    expect(workspace.undoStack.undoLabel()).toBe("nova meta");
  });
});

describe("Investimentos without investments", () => {
  it("Cadastrar conta de investimento goes to Contas › Contas bancárias with the new-investment action", async () => {
    const { router } = await mountPage("/investimentos", { empty: true });
    const user = userEvent.setup();
    await screen.findByText("Nenhum investimento");
    const seen = navigations(router);
    const primary = screen.getByRole("button", { name: "Cadastrar conta de investimento…" });
    expect(primary.getAttribute("data-variant")).toBe("primary");
    await user.click(primary);
    await wentTo(seen, "/contas", { ref: "bancarias", act: "investimento" });
    await screen.findByRole("heading", { level: 1, name: "Contas e cartões" });
    // the empty project has no holder yet: Contas says what comes first
    expect(await screen.findByText(/Cadastre o titular na aba Integrantes/)).toBeTruthy();
  });

  it("in Contas, the action opens the new investment at the selected bank account", async () => {
    await mountPage("/contas?ref=bancarias&act=investimento");
    expect(await screen.findByRole("dialog", { name: "Novo investimento" })).toBeTruthy();
  });
});
