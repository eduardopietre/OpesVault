import {
  charts,
  dom,
  formatBrl,
  ym,
  ymAdd,
  ymOf,
  ymStr,
  type Dec,
  type Ledger,
  type YearMonth,
} from "@opesvault/domain";
import { memoryPreferences, tableRows as chartRows, type ChartData } from "@opesvault/ui";
import { createMemoryHistory } from "@tanstack/react-router";
import { act as reactAct, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/App.tsx";
import { chooseMonth } from "../../src/data/month.ts";
import { toChartData } from "../../src/data/chart_data.ts";
import { categoryRef, cents, parseCategoryRef, summaryLine, usedPercent } from "../../src/pages/orcamento/rows.ts";
import { createAppRouter } from "../../src/router.tsx";
import { DEMO, createFakeServices } from "../../src/services/fake.ts";
import { SessionStore } from "../../src/session.tsx";
import { addressSettles, navigations, wentTo } from "../navigations.ts";

// happy-dom has no canvas: the chart itself is not drawn here (the e2e tests do); its table is.
vi.mock("../../../../packages/ui/src/chart/echarts.ts", () => ({
  echarts: {
    init: () => ({
      on: () => undefined,
      setOption: () => undefined,
      resize: () => undefined,
      dispose: () => undefined,
      dispatchAction: () => undefined,
      getDataURL: () => "",
    }),
  },
}));

async function openPage(path = "/orcamento", month?: (now: YearMonth) => YearMonth) {
  const services = createFakeServices({ seed: true });
  const session = new SessionStore();
  const account = await services.signIn(DEMO.email, DEMO.password);
  const open = await services.openProject(services.demoProjectId!, DEMO.projectPassword);
  session.update({ account, open, operatorId: open.members[0]?.id ?? null });
  const workspace = open.workspace;
  const now = ymOf(workspace.today());
  reactAct(() => chooseMonth(month ? month(now) : now));
  const router = createAppRouter({ session, history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} services={services} session={session} preferences={memoryPreferences()} />);
  await screen.findByRole("heading", { level: 1, name: "Orçamento" });
  return { router, workspace, ledger: workspace.ledger, now, user: userEvent.setup() };
}

const categoryId = (ledger: Ledger, name: string) =>
  [...ledger.accounts.values()].find((account) => account.name === name)!.id;

const lines = (ledger: Ledger, month: YearMonth) =>
  dom.budget
    .linesOf(ledger, month)
    .map((line) => [line.category_id, line.amount.toFixed()] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));

const pickRow = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  const table = await screen.findByRole("grid", { name: "Orçamento por categoria" });
  await user.click(within(table).getByText(name));
};

const flat = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

describe("Orçamento", () => {
  it("shows the planned, spent and remaining of each category with the state in words", async () => {
    const { ledger, now } = await openPage();
    const status = dom.budget.status(ledger, now);
    const table = await screen.findByRole("grid", { name: "Orçamento por categoria" });
    for (const row of status.rows) {
      const line = within(table).getByText(row.name).closest("[role=row]") as HTMLElement;
      expect(line, row.name).toBeTruthy();
      const text = flat(line.textContent);
      expect(text).toContain(flat(formatBrl(row.planned)));
      expect(text).toContain(flat(formatBrl(row.actual)));
      expect(text).toContain(usedPercent(row.used));
      expect(text).toContain({ ok: "Dentro", near: "Perto do limite", over: "Estourado" }[row.state]);
    }
    // the demonstration month has all three states
    expect(status.rows.map((row) => row.state).sort()).toEqual(["near", "ok", "ok", "over"]);
    const over = within(table).getByText("Estourado");
    expect(over.parentElement!.className).toContain("text-negative");
    expect(within(table).getByText("Perto do limite").parentElement!.className).toContain("text-warning");
    expect(within(table).getAllByText("Dentro")[0]!.parentElement!.className).toContain("text-positive");
    // the line under the title and the four figures
    expect(screen.getByText("1 categoria estourada · 1 perto do limite")).toBeTruthy();
    for (const label of ["Planejado", "Realizado", "Restante", "Gasto fora do plano"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("sets the planned value of one category (Alterar valor… with the row selected) and one undo reverts it", async () => {
    const { ledger, workspace, now, user } = await openPage();
    const food = categoryId(ledger, "Alimentação");
    const before = lines(ledger, now);
    await pickRow(user, "Alimentação");
    await user.click(screen.getByRole("button", { name: "Alterar valor…" }));
    const dialog = await screen.findByRole("dialog", { name: /Orçamento de/ });
    const amount = within(dialog).getByLabelText(/Planejado para o mês/) as HTMLInputElement;
    expect(amount.value).toBe("600,00");
    // the category is fixed while editing
    expect(within(dialog).getByRole("combobox", { name: "Categoria" }).hasAttribute("disabled")).toBe(true);
    await user.clear(amount);
    await user.type(amount, "1.234,56");
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Orçamento de/ })).toBeNull());
    expect(dom.budget.lineFor(ledger, food, now)!.amount.toFixed()).toBe("1234.56");
    expect(await screen.findByText(/Orçamento de .* atualizado\./)).toBeTruthy();
    expect(flat(screen.getByRole("grid", { name: "Orçamento por categoria" }).textContent)).toContain("R$ 1.234,56");
    reactAct(() => void workspace.undo());
    expect(lines(ledger, now)).toEqual(before);
  });

  it("refuses an empty or invalid value inside the dialog and keeps the project as it was", async () => {
    const { ledger, now, user } = await openPage();
    const before = lines(ledger, now);
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Definir valor…" }));
    const dialog = await screen.findByRole("dialog", { name: /Orçamento de/ });
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));
    expect(within(dialog).getByText("Escolha a categoria.")).toBeTruthy();
    await user.click(within(dialog).getByRole("combobox", { name: "Categoria" }));
    await user.click(await screen.findByRole("option", { name: "Lazer" }));
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));
    expect(within(dialog).getByText("Informe um valor positivo.")).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/Planejado para o mês/), "0,00");
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));
    expect(within(dialog).getByText("Informe um valor positivo.")).toBeTruthy();
    expect(lines(ledger, now)).toEqual(before);
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(lines(ledger, now)).toEqual(before);
  });

  it("defines a value for a category without a plan (Definir valor…) and one undo reverts it", async () => {
    const { ledger, workspace, now, user } = await openPage();
    const leisure = categoryId(ledger, "Lazer");
    expect(dom.budget.lineFor(ledger, leisure, now)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Definir valor…" }));
    const dialog = await screen.findByRole("dialog", { name: /Orçamento de/ });
    await user.click(within(dialog).getByRole("combobox", { name: "Categoria" }));
    await user.click(await screen.findByRole("option", { name: "Lazer" }));
    await user.type(within(dialog).getByLabelText(/Planejado para o mês/), "300");
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(dom.budget.lineFor(ledger, leisure, now)?.amount.toFixed()).toBe("300"));
    reactAct(() => void workspace.undo());
    expect(dom.budget.lineFor(ledger, leisure, now)).toBeNull();
  });

  it("fills the whole month in the grid, copying last month's plan into the empty fields, as one undo step", async () => {
    // April 2026 of the demonstration has no plan; March has four lines.
    const { ledger, workspace, user } = await openPage("/orcamento", () => ym(2026, 4));
    const april = ym(2026, 4);
    expect(lines(ledger, april)).toEqual([]);
    expect(await screen.findByRole("heading", { name: "Sem orçamento neste mês" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Definir o mês…" }));
    const dialog = await screen.findByRole("dialog", { name: /Orçamento de abril de 2026/ });
    const field = (name: string) => within(dialog).getByLabelText(`Planejado para ${name}`) as HTMLInputElement;
    expect(field("Alimentação").value).toBe("");
    await user.type(field("Lazer"), "250,50");
    await user.click(within(dialog).getByRole("button", { name: "Copiar do mês anterior" }));
    // only the empty fields were filled, and the typed one stayed
    expect(field("Alimentação").value).toBe("600,00");
    expect(field("Moradia").value).toBe("2.350,00");
    expect(field("Lazer").value).toBe("250,50");
    await user.clear(field("Saúde"));
    await user.click(within(dialog).getByRole("button", { name: "Salvar orçamento" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Orçamento de abril/ })).toBeNull());
    const byName = (name: string) => dom.budget.lineFor(ledger, categoryId(ledger, name), april)?.amount ?? null;
    expect(byName("Alimentação")?.eq("600")).toBe(true);
    expect(byName("Moradia")?.eq("2350")).toBe(true);
    expect(byName("Transporte")?.eq("120")).toBe(true);
    expect(byName("Lazer")?.eq("250.5")).toBe(true);
    expect(byName("Saúde")).toBeNull();
    expect(await screen.findByText("Orçamento de abril de 2026: 4 categorias alteradas.")).toBeTruthy();
    reactAct(() => void workspace.undo());
    expect(lines(ledger, april)).toEqual([]);
  });

  it("rejects a bad value in the grid with the category's name and writes nothing", async () => {
    const { ledger, now, user } = await openPage();
    const before = lines(ledger, now);
    await user.click(screen.getByRole("button", { name: "Orçamento do mês…" }));
    const dialog = await screen.findByRole("dialog", { name: /Orçamento de/ });
    await user.type(within(dialog).getByLabelText("Planejado para Lazer"), "abc");
    await user.click(within(dialog).getByRole("button", { name: "Salvar orçamento" }));
    expect(within(dialog).getByText("Lazer: informe um valor positivo ou deixe vazio.")).toBeTruthy();
    expect(lines(ledger, now)).toEqual(before);
  });

  it("saving the grid without changes writes nothing and takes no undo step", async () => {
    const { ledger, workspace, now, user } = await openPage();
    const before = lines(ledger, now);
    await user.click(screen.getByRole("button", { name: "Orçamento do mês…" }));
    const dialog = await screen.findByRole("dialog", { name: /Orçamento de/ });
    await user.click(within(dialog).getByRole("button", { name: "Salvar orçamento" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Orçamento de/ })).toBeNull());
    expect(lines(ledger, now)).toEqual(before);
    expect(workspace.undoStack.canUndo()).toBe(false);
    expect(await screen.findByText("Nenhuma alteração no orçamento.")).toBeTruthy();
  });

  it("copies the previous month from the menu and says when there is nothing to copy; one undo reverts", async () => {
    const { ledger, workspace, user } = await openPage("/orcamento", () => ym(2026, 4));
    const april = ym(2026, 4);
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Copiar do mês anterior" }));
    expect(await screen.findByText("4 categorias copiadas de março de 2026.")).toBeTruthy();
    expect(lines(ledger, april)).toEqual(lines(ledger, ym(2026, 3)).map(([id, value]) => [id, value]));
    // again: everything is already defined
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Copiar do mês anterior" }));
    expect(await screen.findByText(/Nada a copiar: março de 2026 não tem orçamento/)).toBeTruthy();
    reactAct(() => void workspace.undo()); // the second copy took no step: this reverts the first
    expect(lines(ledger, april)).toEqual([]);
  });

  it("removes the selected category, offers Desfazer and one undo brings it back", async () => {
    const { ledger, now, user } = await openPage();
    const food = categoryId(ledger, "Alimentação");
    const before = lines(ledger, now);
    await pickRow(user, "Alimentação");
    await user.click(screen.getByRole("button", { name: "Remover do orçamento" }));
    expect(dom.budget.lineFor(ledger, food, now)).toBeNull();
    expect(screen.queryByText("Selecionada:")).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Desfazer" }));
    expect(lines(ledger, now)).toEqual(before);
  });

  it("asks to select a category instead of opening a dialog when none is selected", async () => {
    const { user } = await openPage();
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Alterar valor…" }));
    expect(await screen.findByText("Selecione uma categoria na tabela.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("follows the shared month: the month picker moves it and the table follows", async () => {
    const { now, user } = await openPage();
    await user.click(screen.getByRole("button", { name: "Mês anterior" }));
    const previous = ymAdd(now, -1);
    expect(ymStr(previous)).not.toBe(ymStr(now));
    await screen.findByRole("heading", { name: "Sem orçamento neste mês" });
    await user.click(screen.getByRole("button", { name: "Próximo mês" }));
    await screen.findByRole("grid", { name: "Orçamento por categoria" });
  });

  it("draws the plan over time with the table of the same values", async () => {
    const { ledger, now, user } = await openPage();
    const chart = charts.data.budgetHistory(ledger, ymAdd(now, -5), now, null);
    const [names, rows] = charts.data.tableRows(chart);
    const section = (await screen.findAllByRole("table", { name: /Valores de Orçamento mês a mês/ }))[0]!;
    expect(
      within(section)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Período", ...names]);
    const body = within(section).getAllByRole("row").slice(1);
    // one table row per month, with the totals the domain adds for flows
    expect(body.length).toBe(rows.length);
    rows.forEach((row, index) => {
      const cells = within(body[index]!)
        .getAllByRole("cell")
        .map((cell) => flat(cell.textContent));
      expect(cells).toEqual(row.values.map((value) => (value === null ? "—" : flat(formatBrl(value)))));
    });
    // selecting a category narrows the history to it
    await pickRow(user, "Transporte");
    expect(await screen.findByRole("table", { name: "Valores de Orçamento mês a mês: Transporte" })).toBeTruthy();
  });

  it("compares the month with the recent average and the same month last year; the table equals the chart data", async () => {
    const { ledger, now } = await openPage();
    const rows = dom.comparisons.categoryComparison(ledger, now);
    expect(rows.length).toBeGreaterThan(0);
    const table = await screen.findByRole("table", { name: "Valores de Comparação com a média" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Período", ...charts.data.categoryComparisonChart(ledger, now).series.map((series) => series.name)]);
    const body = within(table).getAllByRole("row").slice(1);
    expect(body.length).toBe(rows.length);
    const money = (value: Dec | null) => (value === null ? "—" : flat(formatBrl(value)));
    rows.forEach((row, index) => {
      expect(flat(within(body[index]!).getByRole("rowheader").textContent)).toBe(row.name);
      expect(
        within(body[index]!)
          .getAllByRole("cell")
          .map((cell) => flat(cell.textContent)),
      ).toEqual([money(row.current), money(row.average), money(row.lastYear)]);
    });
  });

  it("goes to the ledger with the category and the month (Ver lançamentos)", async () => {
    const { ledger, now, router, user } = await openPage();
    const went = navigations(router);
    await pickRow(user, "Transporte");
    await user.click(screen.getByRole("button", { name: "Ver lançamentos" }));
    await wentTo(went, "/livro", { ref: `categoria:${categoryId(ledger, "Transporte")}:${ymStr(now)}` });
  });

  it("opens the category from an overview alert (ref) and selects it", async () => {
    const probe = await openPage();
    const transport = categoryId(probe.ledger, "Transporte");
    probe.router.navigate({ to: "/orcamento", search: { ref: `categoria:${transport}` } as never });
    const selection = await screen.findByText("Selecionada:");
    expect(flat(selection.parentElement!.textContent)).toContain("Transporte");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the edit dialog from a link with act=alterar and a month in the ref", async () => {
    const probe = await openPage();
    const transport = categoryId(probe.ledger, "Transporte");
    const month = ymStr(probe.now);
    probe.router.navigate({
      to: "/orcamento",
      search: { ref: `categoria:${transport}:${month}`, act: "alterar" } as never,
    });
    const dialog = await screen.findByRole("dialog", { name: /Orçamento de/ });
    expect((within(dialog).getByLabelText(/Planejado para o mês/) as HTMLInputElement).value).toBe("120,00");
    await addressSettles(probe.router, {});
  });

  it("disables every editing control while another tab or device is editing", async () => {
    const { workspace } = await openPage();
    reactAct(() => workspace.setReadOnly(true));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Orçamento do mês…" }) as HTMLButtonElement).disabled).toBe(true),
    );
    const user = userEvent.setup();
    await pickRow(user, "Alimentação");
    expect((screen.getByRole("button", { name: "Alterar valor…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remover do orçamento" }) as HTMLButtonElement).disabled).toBe(true);
    // looking is still allowed
    expect((screen.getByRole("button", { name: "Ver lançamentos" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Orçamento: rows and chart data", () => {
  it("rounds the percentage of use half away from zero and sorts money by exact cents", async () => {
    const { ledger, now } = await openPage();
    const row = dom.budget.status(ledger, now).rows.find((r) => r.name === "Alimentação")!;
    expect(usedPercent(row.used)).toBe("93%");
    expect(cents(row.planned)).toBe(60000n);
  });

  it("summarises the month in words", async () => {
    const { ledger, now } = await openPage();
    expect(summaryLine(dom.budget.status(ledger, now))).toBe("1 categoria estourada · 1 perto do limite");
    expect(summaryLine(dom.budget.status(ledger, ym(2026, 4)))).toBe("");
  });

  it("writes and reads the reference other screens use", () => {
    expect(categoryRef("abc")).toBe("categoria:abc");
    expect(categoryRef("abc", ym(2026, 10))).toBe("categoria:abc:2026-10");
    expect(parseCategoryRef("categoria:abc")).toEqual({ categoryId: "abc", month: null });
    expect(parseCategoryRef("categoria:abc:2026-10")).toEqual({ categoryId: "abc", month: ym(2026, 10) });
    expect(parseCategoryRef("categoria:abc:2026-13")).toBeNull();
    expect(parseCategoryRef("conta:abc")).toBeNull();
    expect(parseCategoryRef(undefined)).toBeNull();
  });

  it("turns a domain chart into chart data without losing unknown values", async () => {
    const { ledger, now } = await openPage();
    const data: ChartData = toChartData(charts.data.budgetHistory(ledger, ymAdd(now, -5), now, null));
    expect(data.categories.length).toBe(6);
    expect(data.series.map((series) => series.name)).toEqual(["Planejado", "Realizado"]);
    // months without a plan are unknown ("—"), never zero
    expect(data.series[0]!.values.slice(0, 2)).toEqual([null, null]);
    expect(chartRows(data).at(-2)?.label).toBe("Total");
  });
});
