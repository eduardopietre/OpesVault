import { dom, formatBrl, makeDate, today, ymAdd, ymOf } from "@opesvault/domain";
import { act as reactAct, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventLink } from "../../src/data/links.ts";
import { chooseMonth } from "../../src/data/month.ts";
import { pageById } from "../../src/pages.tsx";
import { actionKind } from "../../src/pages/calendario/actions.tsx";
import { dayAfterKey, dayLabel } from "../../src/pages/calendario/month_grid.tsx";
import { agendaFigures, dayTitle, entriesOf, lateOnly, monthWeeks } from "../../src/pages/calendario/rows.ts";
import { pinToday } from "../clock.ts";
import { mountApp } from "../mount.tsx";
import { navigations, wentTo } from "../navigations.ts";
import { rowMenu, undoOnce } from "../dom.ts";
import { seedRule } from "./recorrencias_harness.tsx";

// The demonstration's agenda as seen on 6 October 2026: the rent (no operation to link) and a car installment
// are due this month; September's are late.
pinToday(2026, 10, 6);
beforeEach(() => chooseMonth(ymOf(today())));
afterEach(() => vi.unstubAllGlobals());

const heading = () => screen.findByRole("heading", { level: 1, name: "Calendário" });
const daysGrid = () => screen.getByRole("grid", { name: "Dias do mês" });

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
    const { workspace } = await mountApp("/calendario");
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

  it("moves through the days with the keys of a date grid", () => {
    // 6 October 2026 is a Tuesday
    const day = makeDate(2026, 10, 6);
    expect(dayAfterKey(day, "ArrowLeft")).toBe("2026-10-05");
    expect(dayAfterKey(day, "ArrowRight")).toBe("2026-10-07");
    expect(dayAfterKey(day, "ArrowUp")).toBe("2026-09-29");
    expect(dayAfterKey(day, "ArrowDown")).toBe("2026-10-13");
    expect(dayAfterKey(day, "Home")).toBe("2026-10-04");
    expect(dayAfterKey(day, "End")).toBe("2026-10-10");
    expect(dayAfterKey(day, "PageUp")).toBe("2026-09-06");
    expect(dayAfterKey(makeDate(2026, 10, 31), "PageDown")).toBe("2026-11-30");
    expect(dayAfterKey(day, "PageDown", true)).toBe("2027-10-06");
    expect(dayAfterKey(day, "a")).toBeNull();
  });

  it("gives a pending bill or installment 'pay', an unresolved forecast 'link', and the rest nothing", () => {
    const event = (kind: string, state: dom.agenda.EventState, ref: unknown) =>
      ({ on: makeDate(2026, 10, 6), title: "x", kind, state, ref, target: "" }) as unknown as dom.agenda.AgendaEvent;
    expect(actionKind(event("fatura", "pending", ["c", { year: 2026, month: 10 }]))).toBe("pay");
    expect(actionKind(event("financiamento", "late", ["loan", "p", 3]))).toBe("pay");
    expect(actionKind(event("recorrência", "pending", ["r", "2026-10-10"]))).toBe("link");
    expect(actionKind(event("fatura", "done", ["c", { year: 2026, month: 10 }]))).toBeNull();
    expect(actionKind(event("vencimento", "pending", "position"))).toBeNull();
  });
});

describe("Calendário", () => {
  it("shows the month's entries with their state in words, the figures and the grid", async () => {
    const { workspace } = await mountApp("/calendario");
    await heading();
    const events = monthEventsOf(workspace.ledger, workspace.today());
    expect(events.length).toBeGreaterThan(0);
    expect(screen.getByText(new RegExp(`${events.length} vencimentos? em outubro de 2026`))).toBeTruthy();
    const figures = agendaFigures(events);
    for (const value of [figures.toPay, figures.paid]) {
      expect(screen.getAllByText(formatBrl(value)).length).toBeGreaterThan(0);
    }
    for (const label of ["A pagar", "Atrasado", "Já pago", "A receber"]) expect(screen.getByText(label)).toBeTruthy();
    const grid = daysGrid();
    // Every day is a cell of the grid that says how many entries it has and how much; only one is in the tab order.
    const weeks = monthWeeks(ymOf(workspace.today()), events, workspace.today());
    for (const cell of weeks.flat()) {
      if (cell) expect(within(grid).getByRole("gridcell", { name: dayLabel(cell, "outubro de 2026") })).toBeTruthy();
    }
    const tabbable = within(grid)
      .getAllByRole("gridcell")
      .filter((cell) => cell.tabIndex === 0);
    expect(tabbable.map((cell) => cell.dataset["date"])).toEqual(["2026-10-06"]);
    expect(tabbable[0]!.getAttribute("aria-current")).toBe("date");
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
    const { workspace } = await mountApp("/calendario");
    await heading();
    const events = monthEventsOf(workspace.ledger, workspace.today());
    const weeks = monthWeeks(ymOf(workspace.today()), events, workspace.today());
    const cell = weeks.flat().find((c) => c && c.events.length)!;
    const others = events.filter((e) => e.on !== cell!.date);
    expect(others.length).toBeGreaterThan(0);
    const day = within(daysGrid()).getByRole("gridcell", { name: dayLabel(cell!, "outubro de 2026") });
    await user.click(day);
    expect(day.getAttribute("aria-selected")).toBe("true");
    const shown = cell!.date.split("-").reverse().join("/");
    expect(await screen.findByRole("heading", { name: `Vencimentos de ${shown}` })).toBeTruthy();
    const table = screen.getByRole("grid", { name: "Vencimentos" });
    for (const event of entriesOf(events, cell!.date))
      expect(within(table).getAllByText(event.title).length).toBeGreaterThan(0);
    for (const event of others) {
      if (entriesOf(events, cell!.date).some((e) => e.title === event.title)) continue;
      expect(within(table).queryByText(event.title)).toBeNull();
    }
    await user.click(screen.getByRole("button", { name: "Mês inteiro" }));
    await screen.findByRole("heading", { name: "Vencimentos do mês" });
    expect(day.getAttribute("aria-selected")).toBe("false");
    // Choosing the same day twice also clears the choice.
    await user.click(day);
    await user.click(day);
    expect(await screen.findByRole("heading", { name: "Vencimentos do mês" })).toBeTruthy();
  });

  it("walks the days with the keyboard, changes month with Page Down and opens a day with Enter", async () => {
    const user = userEvent.setup();
    await mountApp("/calendario");
    await heading();
    const focused = () => document.activeElement as HTMLElement;
    const cellOf = (date: string) => daysGrid().querySelector<HTMLElement>(`[data-date="${date}"]`)!;
    cellOf("2026-10-06").focus();
    await user.keyboard("{ArrowRight}");
    expect(focused().dataset["date"]).toBe("2026-10-07");
    expect(cellOf("2026-10-07").tabIndex).toBe(0);
    expect(cellOf("2026-10-06").tabIndex).toBe(-1);
    await user.keyboard("{ArrowDown}");
    expect(focused().dataset["date"]).toBe("2026-10-14");
    await user.keyboard("{Home}");
    expect(focused().dataset["date"]).toBe("2026-10-11");
    await user.keyboard("{End}");
    expect(focused().dataset["date"]).toBe("2026-10-17");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "Vencimentos de 17/10/2026" })).toBeTruthy();
    expect(cellOf("2026-10-17").getAttribute("aria-selected")).toBe("true");
    // Page Down: the same day of the next month, which the page now shows (and the other screens share)
    await user.keyboard("{PageDown}");
    await screen.findByText(/vencimentos? em novembro de 2026/);
    await waitFor(() => expect(focused().dataset["date"]).toBe("2026-11-17"));
    // across the start of the month with the arrows
    fireEvent.keyDown(cellOf("2026-11-01") ?? focused(), { key: "ArrowLeft" });
    await screen.findByText(/vencimentos? em outubro de 2026/);
    await waitFor(() => expect(focused().dataset["date"]).toBe("2026-10-31"));
    await user.keyboard("{PageUp}");
    await screen.findByText(/vencimentos? em setembro de 2026/);
    await waitFor(() => expect(focused().dataset["date"]).toBe("2026-09-30"));
    // Space opens the day too
    await user.keyboard(" ");
    expect(await screen.findByRole("heading", { name: "Vencimentos de 30/09/2026" })).toBeTruthy();
  });

  it("pays an installment right in the calendar, and one undo takes the payment back", async () => {
    const user = userEvent.setup();
    const { router, workspace } = await mountApp("/calendario");
    await heading();
    const installment = monthEventsOf(workspace.ledger, workspace.today()).find((e) => e.kind === "financiamento")!;
    expect(installment.state).toBe("pending");
    await user.click(screen.getByRole("button", { name: `Pagar…: ${installment.title}` }));
    const box = await screen.findByRole("dialog", { name: /^Pagar parcela 10 — / });
    await user.click(within(box).getByRole("button", { name: "Registrar pagamento" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Pagar parcela/ })).toBeNull());
    expect(router.state.location.pathname).toBe("/calendario");
    expect(await screen.findByText(/Parcela 10 registrada/)).toBeTruthy();
    const paid = () => monthEventsOf(workspace.ledger, workspace.today()).find((e) => e.title === installment.title)!;
    expect(paid().state).toBe("done");
    // resolved: it only opens now
    expect(await screen.findByRole("button", { name: `Abrir: ${installment.title}` })).toBeTruthy();
    undoOnce(workspace);
    expect(paid().state).toBe("pending");
    expect(await screen.findByRole("button", { name: `Pagar…: ${installment.title}` })).toBeTruthy();
  });

  it("links a forecast right in the calendar, or says there is nothing to link", async () => {
    const user = userEvent.setup();
    const { router, workspace } = await mountApp("/calendario");
    await heading();
    // the demo's rent has no operation that realizes it
    await user.click(screen.getByRole("button", { name: "Vincular…: Aluguel" }));
    expect(await screen.findByText("Nenhum lançamento compatível (conta, valor e data).")).toBeTruthy();
    // a rule whose forecast of today has its operation
    reactAct(() => {
      seedRule(workspace, {
        description: "Posto Shell",
        amount: "145.00",
        category: "Transporte",
        day: 6,
        start: makeDate(2026, 10, 1),
      });
    });
    await user.click(await screen.findByRole("button", { name: "Vincular…: Posto Shell" }));
    const box = await screen.findByRole("dialog", { name: "Vincular realizado" });
    await user.click(within(box).getByRole("button", { name: "Vincular" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Vincular realizado" })).toBeNull());
    expect(await screen.findByText("Previsão vinculada ao lançamento.")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/calendario");
    const shell = monthEventsOf(workspace.ledger, workspace.today()).find((e) => e.title === "Posto Shell")!;
    expect(shell.state).toBe("done");
    expect(workspace.undoStack.undoLabel()).toBe("vincular previsão");
  });

  it("opens each entry's screen: its own button when it has no action here, its menu otherwise", async () => {
    const user = userEvent.setup();
    const { router, workspace } = await mountApp("/calendario");
    await heading();
    const events = monthEventsOf(workspace.ledger, workspace.today());
    for (const event of events) {
      const link = eventLink(event);
      const page = pageById(link.page)!;
      const grid = screen.getByRole("grid", { name: "Vencimentos" });
      const went = navigations(router);
      if (actionKind(event) === null) {
        await user.click(screen.getByRole("button", { name: `Abrir: ${event.title}` }));
        await wentTo(went, page.path, { ...(link.ref ? { ref: link.ref } : {}) }, { exact: true });
      } else {
        const opened = await rowMenu(user, grid, event.title);
        expect(opened.getAttribute("aria-label")).toBe(`Ações de ${event.title}`);
        const names = within(opened)
          .getAllByRole("menuitem")
          .map((item) => item.textContent);
        expect(names).toEqual([actionKind(event) === "pay" ? "Pagar…" : "Vincular…", `Abrir em ${page.title}`]);
        await user.click(within(opened).getByRole("menuitem", { name: `Abrir em ${page.title}` }));
        // the screen opens on the object, without acting: the action is done here
        await wentTo(went, page.path, { ...(link.ref ? { ref: link.ref } : {}) }, { exact: true });
      }
      await waitFor(() => expect(router.state.location.pathname).toBe(page.path));
      await router.navigate({ to: "/calendario" });
      await heading();
    }
  });

  it("opens the selected entry with 'Abrir…', by double click, and asks to select one first", async () => {
    const user = userEvent.setup();
    const { router, workspace } = await mountApp("/calendario");
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

  it("keeps only the late entries with 'Só atrasados'", async () => {
    const user = userEvent.setup();
    const { workspace } = await mountApp("/calendario");
    await heading();
    // October has nothing late yet: the filter is off and disabled
    expect(screen.getByRole("button", { name: "Só atrasados (0)" })).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Mês anterior" }));
    await screen.findByText(/vencimentos? em setembro de 2026/);
    const september = dom.agenda.monthEvents(workspace.ledger, { year: 2026, month: 9 }, workspace.today());
    const late = lateOnly(september);
    expect(late.length).toBeGreaterThan(0);
    const filter = screen.getByRole("button", { name: `Só atrasados (${late.length})` });
    await user.click(filter);
    expect(filter.getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByRole("heading", { name: "Atrasados do mês" })).toBeTruthy();
    const table = screen.getByRole("grid", { name: "Vencimentos" });
    for (const event of september) {
      if (event.state === "late") expect(within(table).getAllByText(event.title).length).toBeGreaterThan(0);
      else if (!late.some((e) => e.title === event.title)) expect(within(table).queryByText(event.title)).toBeNull();
    }
    // a day without late entries says so
    await user.click(within(daysGrid()).getByRole("gridcell", { name: /^1 de setembro/ }));
    expect(await screen.findByText("Nenhum vencimento atrasado neste período.")).toBeTruthy();
    await user.click(filter);
    expect(filter.getAttribute("aria-pressed")).toBe("false");
    expect(await screen.findByRole("heading", { name: "Vencimentos de 01/09/2026" })).toBeTruthy();
  });

  it("changes month with the picker, shared with the other screens, and never edits the project", async () => {
    const user = userEvent.setup();
    const { router, workspace } = await mountApp("/calendario");
    await heading();
    await user.click(screen.getByRole("button", { name: "Próximo mês" }));
    const next = ymAdd(ymOf(workspace.today()), 1);
    const events = dom.agenda.monthEvents(workspace.ledger, next, workspace.today());
    await screen.findByText(new RegExp(`${events.length} vencimentos? em novembro de 2026`));
    // The shared month: the overview opens on it... after its own default placement, so look at the picker.
    await router.navigate({ to: "/livro" });
    await router.navigate({ to: "/calendario" });
    await screen.findByText(new RegExp(`vencimentos? em novembro de 2026`));
    expect(workspace.undoStack.canUndo()).toBe(false);
  });

  it("becomes a list of days on phones, with each entry's action and its screen", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const { router, workspace } = await mountApp("/calendario");
    await heading();
    expect(screen.queryByRole("grid", { name: "Dias do mês" })).toBeNull();
    const list = screen.getByRole("list", { name: "Dias com vencimentos" });
    const events = monthEventsOf(workspace.ledger, workspace.today());
    for (const event of events) expect(within(list).getAllByText(event.title).length).toBeGreaterThan(0);
    const installment = events.find((e) => e.kind === "financiamento")!;
    await user.click(within(list).getByRole("button", { name: `Pagar…: ${installment.title}` }));
    const box = await screen.findByRole("dialog", { name: /^Pagar parcela/ });
    await user.click(within(box).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Pagar parcela/ })).toBeNull());
    const link = eventLink(installment);
    await user.click(
      within(list).getByRole("button", {
        name: `Abrir em ${pageById(link.page)!.title}: ${installment.title}`,
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe(pageById(link.page)!.path));
  });

  it("disables paying and linking while the project is read-only, but still opens", async () => {
    const { workspace } = await mountApp("/calendario", { readOnly: true });
    await heading();
    const installment = monthEventsOf(workspace.ledger, workspace.today()).find((e) => e.kind === "financiamento")!;
    expect(screen.getByRole("button", { name: `Pagar…: ${installment.title}` })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Vincular…: Aluguel" })).toHaveProperty("disabled", true);
    const user = userEvent.setup();
    const opened = await rowMenu(user, screen.getByRole("grid", { name: "Vencimentos" }), installment.title);
    expect(within(opened).getByRole("menuitem", { name: "Pagar…" }).getAttribute("aria-disabled")).toBe("true");
    expect(
      within(opened)
        .getByRole("menuitem", { name: /^Abrir em / })
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("shows an empty month and an empty project without crashing (TA-31)", async () => {
    await mountApp("/calendario", { project: "blank" });
    await heading();
    expect(screen.getByText(/0 vencimentos? em/)).toBeTruthy();
    expect(screen.getByText("Nenhum vencimento neste período.")).toBeTruthy();
    expect(screen.getAllByText("R$ 0,00").length).toBeGreaterThan(0);
  });
});
