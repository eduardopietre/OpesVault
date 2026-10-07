import { dom, exporting, formatBrl, ymOf, type Ledger } from "@opesvault/domain";
import { memoryPreferences } from "@opesvault/ui";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { alertLink, filterRef } from "../../src/data/links.ts";
import { pageById } from "../../src/pages.tsx";
import { ALERTS_HIDDEN_KEY } from "../../src/pages/visao-geral/index.tsx";
import { cellText, monthlyReportData } from "../../src/pages/visao-geral/report.ts";
import { backupNotices } from "../../src/pages/configuracoes/backup_state.ts";
import { MAX_VISIBLE } from "../../src/pages/visao-geral/alerts_panel.tsx";
import {
  categoryRows,
  comparisonRows,
  indicatorRows,
  latestActivityMonth,
  monthFigures,
} from "../../src/pages/visao-geral/rows.ts";
import { mountPage } from "./overview_calendar_helpers.tsx";
import { addressSettles, navigations, wentTo } from "../navigations.ts";

vi.mock("../../../../packages/ui/src/chart/echarts.ts", () => import("./fake_echarts.ts"));

afterEach(() => vi.restoreAllMocks());

const heading = () => screen.findByRole("heading", { level: 1, name: "Visão geral" });

function monthOf(ledger: Ledger, today: string) {
  return latestActivityMonth(ledger, today as never)!;
}

describe("Visão geral", () => {
  it("shows the figures of the month from the domain, the accounts, the categories and the indicators", async () => {
    const { workspace } = await mountPage("/visao-geral");
    await heading();
    const ledger = workspace.ledger;
    const month = monthOf(ledger, workspace.today());
    const figures = monthFigures(ledger, month, null);
    for (const value of [figures.inflow, figures.outflow, figures.income, figures.expense, figures.assets]) {
      expect(screen.getAllByText(formatBrl(value)).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("Caixa")).toBeTruthy();
    expect(screen.getByText("Resultado por competência")).toBeTruthy();
    expect(screen.getByText("Patrimônio no fim do mês")).toBeTruthy();
    // Context line: the month is open.
    expect(screen.getByText("Mês aberto")).toBeTruthy();
    // Accounts and categories are tables whose lines open the operations.
    const categories = categoryRows(ledger, month, null);
    expect(categories.length).toBeGreaterThan(0);
    const table = screen.getByRole("table", { name: /Despesas por categoria/ });
    expect(within(table).getByRole("button", { name: new RegExp(categories[0]!.name) })).toBeTruthy();
    for (const indicator of indicatorRows(ledger, month)) {
      expect(screen.getByText(indicator.label)).toBeTruthy();
    }
    const comparison = comparisonRows(ledger, month);
    expect(comparison.map((r) => r.name).slice(0, 3)).toEqual(["Receitas", "Despesas", "Resultado"]);
    // The months side by side: the chart is drawn from the same values as its table.
    expect(screen.getByRole("heading", { name: "Mês a mês" })).toBeTruthy();
    expect(screen.getByRole("table", { name: /Valores de Mês a mês/ })).toBeTruthy();
  });

  it("opens on the latest month with activity, not on an empty current month", async () => {
    const { workspace } = await mountPage("/visao-geral");
    await heading();
    const month = monthOf(workspace.ledger, workspace.today());
    const label = screen.getByRole("button", { name: /^Mês: .*Escolher outro mês$/ });
    expect(label.textContent?.toLowerCase()).toContain(String(month.year));
  });

  describe("Atenção", () => {
    it("links every notice to the place and the action where it is resolved", async () => {
      const user = userEvent.setup();
      const { router, workspace } = await mountPage("/visao-geral");
      await heading();
      const alerts = dom.alerts.alerts(workspace.ledger, workspace.today());
      expect(alerts.length).toBeGreaterThan(MAX_VISIBLE); // the demo shows "Mostrar todos"
      const seen = new Set<string>();
      for (const alert of alerts) {
        const link = alertLink(alert);
        const page = pageById(link.page);
        expect(page, `page ${link.page}`).toBeTruthy();
        if (screen.queryByRole("button", { name: `${link.label}: ${alert.title}` }) === null) {
          await user.click(screen.getByRole("button", { name: /Mostrar todos/ }));
        }
        // The destination may consume ref/act at once (useReveal): read them from the navigation itself.
        const seenNow = navigations(router);
        await user.click(screen.getByRole("button", { name: `${link.label}: ${alert.title}` }));
        await waitFor(() => expect(router.state.location.pathname).toBe(page!.path));
        expect(seenNow[0]).toEqual({
          pathname: page!.path,
          search: { ...(link.ref ? { ref: link.ref } : {}), ...(link.act ? { act: link.act } : {}) },
        });
        seen.add(`${link.page}|${link.act ?? ""}`);
        await router.navigate({ to: "/visao-geral" });
        await heading();
      }
      // The demo has bills to pay, forecasts to link and budgets: the actions are started directly.
      expect(seen.has("contas|pagar")).toBe(true);
      expect(seen.has("recorrencias|vincular")).toBe(true);
      expect(seen.has("orcamento|")).toBe(true);
      expect(seen.has("importar|")).toBe(true);
      expect(seen.has("livro|")).toBe(true);
    });

    it("counts the notices, shows six and the rest on request", async () => {
      const user = userEvent.setup();
      const { workspace } = await mountPage("/visao-geral");
      await heading();
      // the demonstration was never backed up on this device: that notice comes after the project's own
      const alerts = [
        ...dom.alerts.alerts(workspace.ledger, workspace.today()),
        ...backupNotices(null, workspace.today(), true),
      ];
      const panel = screen.getByRole("region", { name: "Atenção" });
      expect(within(panel).getAllByRole("listitem")).toHaveLength(MAX_VISIBLE);
      await user.click(within(panel).getByRole("button", { name: `Mostrar todos (${alerts.length})` }));
      expect(within(panel).getAllByRole("listitem")).toHaveLength(alerts.length);
      await user.click(within(panel).getByRole("button", { name: "Mostrar menos" }));
      await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(MAX_VISIBLE));
      // Severity is said in words.
      expect(within(panel).getAllByText("Atrasado").length).toBeGreaterThan(0);
    });

    it("hides until the next opening: the preference holds this opening, a new one shows it again", async () => {
      const user = userEvent.setup();
      const preferences = memoryPreferences();
      const first = await mountPage("/visao-geral", { preferences });
      await heading();
      expect(screen.getByRole("region", { name: "Atenção" })).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Ocultar" }));
      await waitFor(() => expect(screen.queryByRole("region", { name: "Atenção" })).toBeNull());
      expect(preferences.get(ALERTS_HIDDEN_KEY)).toBeTruthy();
      expect(screen.getByText(/avisos ocultos até a próxima abertura/)).toBeTruthy();
      // Still hidden when the page is visited again in the same opening.
      await first.router.navigate({ to: "/livro" });
      await first.router.navigate({ to: "/visao-geral" });
      await heading();
      expect(screen.queryByRole("region", { name: "Atenção" })).toBeNull();
      // "Mostrar avisos" brings it back.
      await user.click(screen.getByRole("button", { name: "Mostrar avisos" }));
      await screen.findByRole("region", { name: "Atenção" });
      expect(preferences.get(ALERTS_HIDDEN_KEY)).toBeNull();
      // Hidden again, then the project is opened again: the panel is back.
      await user.click(screen.getByRole("button", { name: "Ocultar" }));
      await waitFor(() => expect(screen.queryByRole("region", { name: "Atenção" })).toBeNull());
      first.view.unmount();
      await mountPage("/visao-geral", { preferences });
      await heading();
      expect(screen.getByRole("region", { name: "Atenção" })).toBeTruthy();
    });
  });

  describe("closing and reopening the month", () => {
    it("closes a month without pending items at once, and one undo reopens it", async () => {
      const user = userEvent.setup();
      const { workspace } = await mountPage("/visao-geral", { empty: true });
      await heading();
      const month = ymOf(workspace.today());
      expect(screen.queryByRole("region", { name: "Antes de fechar o mês" })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Fechar mês…" }));
      await waitFor(() => expect(dom.periods.isClosed(workspace.ledger, month)).toBe(true));
      expect(await screen.findByText("Mês fechado")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Fechar mês…" })).toBeNull();
      expect(screen.getByRole("button", { name: "Reabrir mês…" })).toBeTruthy();
      expect(dom.periods.period(workspace.ledger, month)?.pending_note).toBeNull();
      workspace.undo();
      await waitFor(() => expect(dom.periods.isClosed(workspace.ledger, month)).toBe(false));
      expect(await screen.findByText("Mês aberto")).toBeTruthy();
    });

    it("asks a reason to close with pending items, listing them, and one undo reverts", async () => {
      const user = userEvent.setup();
      const { workspace } = await mountPage("/visao-geral");
      await heading();
      const month = monthOf(workspace.ledger, workspace.today());
      const pending = dom.periods.pendingItems(workspace.ledger, month);
      expect(pending.length).toBeGreaterThan(0);
      const section = screen.getByRole("region", { name: "Antes de fechar o mês" });
      for (const item of pending) expect(within(section).getByText(item)).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Fechar mês…" }));
      const dialog = await screen.findByRole("dialog", { name: "Fechar com pendências" });
      for (const item of pending) expect(within(dialog).getByText(item)).toBeTruthy();
      // A reason is required.
      await user.click(within(dialog).getByRole("button", { name: "Fechar mês" }));
      expect(await within(dialog).findByText("O motivo é obrigatório.")).toBeTruthy();
      expect(dom.periods.isClosed(workspace.ledger, month)).toBe(false);
      await user.type(within(dialog).getByLabelText(/Justificativa/), "Aluguel pago em dinheiro");
      await user.click(within(dialog).getByRole("button", { name: "Fechar mês" }));
      await waitFor(() => expect(dom.periods.isClosed(workspace.ledger, month)).toBe(true));
      expect(dom.periods.period(workspace.ledger, month)?.pending_note).toBe("Aluguel pago em dinheiro");
      expect(await screen.findByText("Mês fechado")).toBeTruthy();
      workspace.undo();
      await waitFor(() => expect(dom.periods.isClosed(workspace.ledger, month)).toBe(false));
      expect(dom.periods.period(workspace.ledger, month)).toBeNull();
    });

    it("does not close with pending items when the dialog is cancelled", async () => {
      const user = userEvent.setup();
      const { workspace } = await mountPage("/visao-geral");
      await heading();
      const month = monthOf(workspace.ledger, workspace.today());
      await user.click(screen.getByRole("button", { name: "Fechar mês…" }));
      const dialog = await screen.findByRole("dialog", { name: "Fechar com pendências" });
      await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Fechar com pendências" })).toBeNull());
      expect(dom.periods.isClosed(workspace.ledger, month)).toBe(false);
      expect(workspace.undoStack.canUndo()).toBe(false);
    });

    it("reopens a closed month only with a reason, kept in the history, and one undo closes it again", async () => {
      const user = userEvent.setup();
      const { workspace } = await mountPage("/visao-geral", { empty: true });
      await heading();
      const month = ymOf(workspace.today());
      workspace.act((ledger) => dom.periods.closeMonth(ledger, month, null));
      expect(await screen.findByText("Mês fechado")).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Reabrir mês…" }));
      const dialog = await screen.findByRole("dialog", { name: "Reabrir mês" });
      await user.click(within(dialog).getByRole("button", { name: "Reabrir mês" }));
      expect(await within(dialog).findByText("O motivo é obrigatório.")).toBeTruthy();
      expect(dom.periods.isClosed(workspace.ledger, month)).toBe(true);
      await user.type(within(dialog).getByLabelText(/Motivo/), "Faltou um recibo");
      await user.click(within(dialog).getByRole("button", { name: "Reabrir mês" }));
      await waitFor(() => expect(dom.periods.isClosed(workspace.ledger, month)).toBe(false));
      expect(dom.periods.period(workspace.ledger, month)?.reopen_reasons).toEqual(["Faltou um recibo"]);
      expect(await screen.findByText("Mês aberto")).toBeTruthy();
      workspace.undo();
      await waitFor(() => expect(dom.periods.isClosed(workspace.ledger, month)).toBe(true));
      expect(dom.periods.period(workspace.ledger, month)?.reopen_reasons).toEqual([]);
    });

    it("disables closing and reopening while another tab or device edits (read-only)", async () => {
      const { workspace } = await mountPage("/visao-geral", { readOnly: true });
      await heading();
      expect(workspace.readOnly).toBe(true);
      const close = screen.getByRole("button", { name: "Fechar mês…" }) as HTMLButtonElement;
      expect(close.disabled).toBe(true);
      expect(close.parentElement?.getAttribute("title")).toMatch(/aqui só leitura/);
    });
  });

  describe("links to the operations and other screens", () => {
    it("opens the operations of an account or a category in the Livro, for the month", async () => {
      const user = userEvent.setup();
      const { router, workspace } = await mountPage("/visao-geral");
      await heading();
      const seen = navigations(router);
      const ledger = workspace.ledger;
      const month = monthOf(ledger, workspace.today());
      const top = categoryRows(ledger, month, null)[0]!;
      const table = screen.getByRole("table", { name: /Despesas por categoria/ });
      await user.click(within(table).getByRole("button", { name: new RegExp(top.name) }));
      await wentTo(seen, "/livro", { ref: filterRef(top.id, month, null) }, { exact: true });
      expect(filterRef(top.id, month, null)).toBe(
        `filter:${top.id}:${month.year}-${String(month.month).padStart(2, "0")}`,
      );
    });

    it("goes to Relatórios from 'Comparação completa' and from the Mais menu", async () => {
      const user = userEvent.setup();
      const { router } = await mountPage("/visao-geral");
      await heading();
      await user.click(screen.getByRole("button", { name: "Comparação completa" }));
      await waitFor(() => expect(router.state.location.pathname).toBe("/relatorios"));
      // Relatórios reads the link and opens the comparison
      const open = () =>
        within(screen.getByRole("navigation", { name: "Relatórios" })).getByRole("button", {
          name: "Comparação com a média",
        });
      await waitFor(() => expect(open().getAttribute("aria-current")).toBe("true"));
      await router.navigate({ to: "/visao-geral" });
      await heading();
      await user.click(screen.getByRole("button", { name: "Mais" }));
      await user.click(await screen.findByRole("menuitem", { name: "Comparação completa (Relatórios)" }));
      await waitFor(() => expect(router.state.location.pathname).toBe("/relatorios"));
      await waitFor(() => expect(open().getAttribute("aria-current")).toBe("true"));
    });

    it("links the pending items to where they are resolved", async () => {
      const user = userEvent.setup();
      const { router, workspace } = await mountPage("/visao-geral");
      await heading();
      const month = monthOf(workspace.ledger, workspace.today());
      const pending = dom.periods.pendingItems(workspace.ledger, month);
      const forecast = pending.find((p) => p.includes("previsão"));
      expect(forecast).toBeTruthy();
      await user.click(screen.getByRole("button", { name: `Ver previsões: ${forecast}` }));
      await waitFor(() => expect(router.state.location.pathname).toBe("/recorrencias"));
    });
  });

  describe("the member's view", () => {
    it("shows a member's competence by their shares and the accounts they hold", async () => {
      const user = userEvent.setup();
      const { workspace } = await mountPage("/visao-geral");
      await heading();
      const ledger = workspace.ledger;
      const month = monthOf(ledger, workspace.today());
      const ana = [...ledger.members.values()].find((m) => m.name === "Ana")!;
      await user.click(screen.getByRole("combobox", { name: "Visão de" }));
      await user.click(await screen.findByRole("option", { name: "Ana" }));
      const mine = monthFigures(ledger, month, ana.id);
      const whole = monthFigures(ledger, month, null);
      expect(mine.expense.eq(whole.expense)).toBe(false);
      await waitFor(() => expect(screen.getAllByText(formatBrl(mine.expense)).length).toBeGreaterThan(0));
      expect(screen.getByText(/das contas de que é titular/)).toBeTruthy();
    });
  });

  describe("the month", () => {
    it("is the shared month: the picker moves it and the figures follow", async () => {
      const user = userEvent.setup();
      const { workspace } = await mountPage("/visao-geral");
      await heading();
      const ledger = workspace.ledger;
      const month = monthOf(ledger, workspace.today());
      await user.click(screen.getByRole("button", { name: "Mês anterior" }));
      const previous = {
        year: month.month === 1 ? month.year - 1 : month.year,
        month: month.month === 1 ? 12 : month.month - 1,
      };
      const figures = monthFigures(ledger, previous, null);
      await waitFor(() => expect(screen.getAllByText(formatBrl(figures.inflow)).length).toBeGreaterThan(0));
    });
  });

  describe("an empty project", () => {
    it("shows every figure, table and chart with its empty state and does not crash (TA-31)", async () => {
      await mountPage("/visao-geral", { empty: true });
      await heading();
      expect(screen.getByText("Nenhuma conta ainda. Cadastre em Contas e cartões.")).toBeTruthy();
      expect(screen.getByText("Sem despesas neste mês.")).toBeTruthy();
      expect(screen.queryByRole("region", { name: "Atenção" })).toBeNull();
      expect(screen.getAllByText("R$ 0,00").length).toBeGreaterThan(0);
    });
  });
});

describe("the report of the month", () => {
  it("has the same figures as the domain's HTML report, section by section", async () => {
    const { workspace } = await mountPage("/visao-geral");
    const ledger = workspace.ledger;
    const month = monthOf(ledger, workspace.today());
    const html = exporting.monthlyReportHtml(ledger, month, workspace.today());
    const data = monthlyReportData(ledger, month, workspace.today());
    const escape = (text: string) =>
      text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#x27;");
    expect(data.tables.map((t) => t.title)).toEqual([
      "Resumo",
      "Comparado aos meses anteriores",
      "Despesas por categoria",
      "Vencimentos do mês",
      "Indicadores",
    ]);
    for (const table of data.tables) {
      expect(html).toContain(`<h2>${table.title}</h2>`);
      for (const row of table.rows) {
        for (const cell of row)
          expect(html, `${table.title}: ${cellText(cell)}`).toContain(`>${escape(cellText(cell))}</td>`);
      }
    }
    for (const item of data.pending) expect(html).toContain(`<li>${escape(item)}</li>`);
    expect(html).toContain(escape(data.warning));
  });

  it("is printed from a print view outside the shell, and the same report downloads as HTML", async () => {
    const user = userEvent.setup();
    const print = vi.fn();
    vi.stubGlobal("print", print);
    const created: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      created.push(blob as Blob);
      return "blob:test";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const { workspace, router } = await mountPage("/visao-geral");
    await heading();
    const month = monthOf(workspace.ledger, workspace.today());
    const key = `${month.year}-${String(month.month).padStart(2, "0")}`;
    // From "Mais › Relatório do mês em PDF…": the print view opens and asks the browser to print.
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Relatório do mês em PDF…" }));
    await screen.findByRole("heading", { level: 1, name: /Projeto Teste — / });
    expect(router.state.location.pathname).toBe("/imprimir/relatorio-mensal");
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await addressSettles(router, { m: key });
    // The sheet has the sections of the report, drawn from the data.
    for (const title of [
      "Resumo",
      "Comparado aos meses anteriores",
      "Despesas por categoria",
      "Vencimentos do mês",
      "Indicadores",
      "Pendências",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeTruthy();
    }
    // The buttons: print again, download the file.
    await user.click(screen.getByRole("button", { name: "Imprimir ou salvar em PDF" }));
    expect(print).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Baixar como arquivo HTML" }));
    expect(created).toHaveLength(1);
    expect(await created[0]!.text()).toBe(exporting.monthlyReportHtml(workspace.ledger, month, workspace.today()));
    // Back to the overview.
    await user.click(screen.getByRole("button", { name: "Voltar à Visão geral" }));
    await heading();
  });
});
