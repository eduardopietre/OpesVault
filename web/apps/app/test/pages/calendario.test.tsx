import { dom, formatBrl, makeDate, today, ymAdd, ymOf } from "@opesvault/domain";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventLink } from "../../src/data/links.ts";
import { chooseMonth } from "../../src/data/month.ts";
import { pageById } from "../../src/pages.tsx";
import { dayLabel } from "../../src/pages/calendario/month_grid.tsx";
import { agendaFigures, dayTitle, entriesOf, monthWeeks } from "../../src/pages/calendario/rows.ts";
import { mountPage } from "./overview_calendar_helpers.tsx";

beforeEach(() => chooseMonth(ymOf(today())));
afterEach(() => vi.unstubAllGlobals());

const heading = () => screen.findByRole("heading", { level: 1, name: "Calendário" });

function monthEventsOf(ledger: Parameters<typeof dom.agenda.monthEvents>[0], today: ReturnType<typeof makeDate>) {
  return dom.agenda.monthEvents(ledger, ymOf(today), today);
}

describe("Calendário rows", () => {
  it("lays the month out Sunday first, with the days of other months empty", () => {
    const weeks = monthWeeks({ year: 2026, month: 10 }, [], makeDate(2026, 10, 6));
    // 1 October 2026 is a Thursday: four empty days, then the 1st.
    expect(weeks).toHaveLength(5);
    expect(weeks[0]!.slice(0, 4)).toEqual([null, null, null, null]);
    expect(weeks[0]![4]?.day).toBe(1);
    expect(weeks[4]!.filter((cell) => cell !== null).at(-1)?.day).toBe(31);
    const today = weeks.flat().find((cell) => cell?.isToday);
    expect(today?.date).toBe("2026-10-06");
    expect(dayTitle(makeDate(2026, 10, 8), "outubro")).toBe("Qui, 08 de outubro");
  });

  it("adds the figures: to pay, late, paid and to receive, from the entries", async () => {
    const { workspace } = await mountPage("/calendario");
    const events = monthEventsOf(workspace.ledger, workspace.today());
    const figures = agendaFigures(events);
    const outgoing = events.filter((e) => e.amount.isNegative());
    const text = (list: typeof events) => list.map((e) => e.amount.abs().toFixed()).join("+");
    const total = (list: typeof events) =>
      list.reduce((sum, e) => sum.add(e.amount.abs()), figures.paid.sub(figures.paid));
    expect(
      figures.toPay.eq(total(outgoing.filter((e) => e.state !== dom.agenda.EventState.DONE))),
      text(outgoing),
    ).toBe(true);
    expect(figures.late.eq(total(outgoing.filter((e) => e.state === dom.agenda.EventState.LATE)))).toBe(true);
    expect(figures.paid.eq(total(outgoing.filter((e) => e.state === dom.agenda.EventState.DONE)))).toBe(true);
    expect(figures.late.lte(figures.toPay)).toBe(true);
  });
});

describe("Calendário", () => {
  it("shows the month's entries with their state in words, the figures and the grid", async () => {
    const { workspace } = await mountPage("/calendario");
    await heading();
    const events = monthEventsOf(workspace.ledger, workspace.today());
    expect(events.length).toBeGreaterThan(0);
    expect(screen.getByText(new RegExp(`${events.length} vencimento\\(s\\) em outubro de 2026`))).toBeTruthy();
    const figures = agendaFigures(events);
    for (const value of [figures.toPay, figures.paid]) {
      expect(screen.getAllByText(formatBrl(value)).length).toBeGreaterThan(0);
    }
    for (const label of ["A pagar", "Atrasado", "Já pago", "A receber"]) expect(screen.getByText(label)).toBeTruthy();
    const grid = screen.getByRole("table", { name: "Dias do mês" });
    // Every day that has entries is a button that says how many and how much.
    const weeks = monthWeeks(ymOf(workspace.today()), events, workspace.today());
    for (const cell of weeks.flat()) {
      if (cell && cell.events.length) {
        expect(within(grid).getByRole("button", { name: dayLabel(cell, "outubro de 2026") })).toBeTruthy();
      }
    }
    const table = screen.getByRole("grid", { name: "Vencimentos" });
    for (const event of events) {
      expect(within(table).getAllByText(event.title).length).toBeGreaterThan(0);
    }
    for (const event of events) {
      expect(within(table).getAllByText(dom.agenda.STATE_LABELS[event.state]).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(/Previsões não alteram saldos/)).toBeTruthy();
  });

  it("chooses a day to see only its entries, and 'Mês inteiro' shows them all again", async () => {
    const user = userEvent.setup();
    const { workspace } = await mountPage("/calendario");
    await heading();
    const events = monthEventsOf(workspace.ledger, workspace.today());
    const weeks = monthWeeks(ymOf(workspace.today()), events, workspace.today());
    const cell = weeks.flat().find((c) => c && c.events.length)!;
    const others = events.filter((e) => e.on !== cell!.date);
    expect(others.length).toBeGreaterThan(0);
    const grid = screen.getByRole("table", { name: "Dias do mês" });
    const button = within(grid).getByRole("button", { name: dayLabel(cell!, "outubro de 2026") });
    await user.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    const day = cell!.date.split("-").reverse().join("/");
    expect(await screen.findByRole("heading", { name: `Vencimentos de ${day}` })).toBeTruthy();
    const table = screen.getByRole("grid", { name: "Vencimentos" });
    for (const event of entriesOf(events, cell!.date))
      expect(within(table).getAllByText(event.title).length).toBeGreaterThan(0);
    for (const event of others) {
      if (entriesOf(events, cell!.date).some((e) => e.title === event.title)) continue;
      expect(within(table).queryByText(event.title)).toBeNull();
    }
    await user.click(screen.getByRole("button", { name: "Mês inteiro" }));
    await screen.findByRole("heading", { name: "Vencimentos do mês" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    // Choosing the same day twice also clears the choice.
    await user.click(button);
    await user.click(button);
    expect(await screen.findByRole("heading", { name: "Vencimentos do mês" })).toBeTruthy();
  });

  it("opens, from each entry, the place where it is paid or linked, ready to act", async () => {
    const user = userEvent.setup();
    const { router, workspace } = await mountPage("/calendario");
    await heading();
    const events = monthEventsOf(workspace.ledger, workspace.today());
    const seen = new Set<string>();
    for (const event of events) {
      const link = eventLink(event);
      const page = pageById(link.page)!;
      await user.click(screen.getByRole("button", { name: `${link.label}: ${event.title}` }));
      await waitFor(() => expect(router.state.location.pathname).toBe(page.path));
      expect(router.state.location.search).toEqual({
        ...(link.ref ? { ref: link.ref } : {}),
        ...(link.act ? { act: link.act } : {}),
      });
      seen.add(`${link.page}|${link.act ?? ""}`);
      await router.navigate({ to: "/calendario" });
      await heading();
    }
    // A pending bill or installment opens ready to pay; a late recurrence ready to link; a paid one only opens.
    expect(seen.has("contas|pagar") || seen.has("contas|")).toBe(true);
    expect([...seen].some((key) => key.startsWith("recorrencias"))).toBe(true);
  });

  it("opens the selected entry with 'Abrir…', by double click, and asks to select one first", async () => {
    const user = userEvent.setup();
    const { router, workspace } = await mountPage("/calendario");
    await heading();
    await user.click(screen.getByRole("button", { name: "Abrir…" }));
    expect(await screen.findByText("Selecione um vencimento.")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/calendario");
    const events = monthEventsOf(workspace.ledger, workspace.today());
    const first = events[0]!;
    const table = screen.getByRole("grid", { name: "Vencimentos" });
    const row = within(table).getAllByText(first.title)[0]!.closest("[role=row]") as HTMLElement;
    await user.click(row);
    await user.click(screen.getByRole("button", { name: "Abrir…" }));
    const link = eventLink(first);
    await waitFor(() => expect(router.state.location.pathname).toBe(pageById(link.page)!.path));
    await router.navigate({ to: "/calendario" });
    await heading();
    const again = within(screen.getByRole("grid", { name: "Vencimentos" }))
      .getAllByText(first.title)[0]!
      .closest("[role=row]") as HTMLElement;
    await user.dblClick(again);
    await waitFor(() => expect(router.state.location.pathname).toBe(pageById(link.page)!.path));
  });

  it("changes month with the picker, shared with the other screens, and never edits the project", async () => {
    const user = userEvent.setup();
    const { router, workspace } = await mountPage("/calendario");
    await heading();
    await user.click(screen.getByRole("button", { name: "Próximo mês" }));
    const next = ymAdd(ymOf(workspace.today()), 1);
    const events = dom.agenda.monthEvents(workspace.ledger, next, workspace.today());
    await screen.findByText(new RegExp(`${events.length} vencimento\\(s\\) em novembro de 2026`));
    // The shared month: the overview opens on it... after its own default placement, so look at the picker.
    await router.navigate({ to: "/livro" });
    await router.navigate({ to: "/calendario" });
    await screen.findByText(new RegExp(`vencimento\\(s\\) em novembro de 2026`));
    expect(workspace.undoStack.canUndo()).toBe(false);
  });

  it("becomes a list of days on phones, with each entry's action", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const { router, workspace } = await mountPage("/calendario");
    await heading();
    expect(screen.queryByRole("table", { name: "Dias do mês" })).toBeNull();
    const list = screen.getByRole("list", { name: "Dias com vencimentos" });
    const events = monthEventsOf(workspace.ledger, workspace.today());
    for (const event of events) expect(within(list).getAllByText(event.title).length).toBeGreaterThan(0);
    const first = events[0]!;
    const link = eventLink(first);
    await user.click(within(list).getByRole("button", { name: `${link.label}: ${first.title}` }));
    await waitFor(() => expect(router.state.location.pathname).toBe(pageById(link.page)!.path));
  });

  it("shows an empty month and an empty project without crashing (TA-31)", async () => {
    await mountPage("/calendario", { empty: true });
    await heading();
    expect(screen.getByText(/0 vencimento\(s\) em/)).toBeTruthy();
    expect(screen.getByText("Nenhum vencimento neste período.")).toBeTruthy();
    expect(screen.getAllByText("R$ 0,00").length).toBeGreaterThan(0);
  });
});
