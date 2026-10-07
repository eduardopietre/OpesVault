import { dom, makeDate, type IsoDate } from "@opesvault/domain";
import { act as reactAct, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { alertLink, eventLink } from "../../src/data/links.ts";
import { forecastId, forecastWindow, ruleRef } from "../../src/pages/recorrencias/rows.ts";
import { flat, linkCount, openPage, rowOf, rules, seedRule } from "./recorrencias_harness.tsx";
import { addressSettles, navigations, wentTo } from "../navigations.ts";

vi.mock("../../../../packages/ui/src/chart/echarts.ts", () => import("./fake_echarts.ts"));

const day = (d: number): IsoDate => makeDate(2026, 10, d);

type Opened = Awaited<ReturnType<typeof openPage>>;

/** What another page does: `useGoTo()("recorrencias", { ref, act })`. */
async function goTo(o: Opened, search: { ref?: string; act?: string }) {
  await reactAct(async () => {
    await o.router.navigate({ to: "/recorrencias", search });
  });
}

const selected = (table: HTMLElement, id: string) => rowOf(table, id)?.getAttribute("aria-selected");

describe("Recorrências: vindo de outras páginas (useReveal)", () => {
  it("selects the forecast named by '<ruleId>:<date>' and does not act without an act", async () => {
    const o = await openPage("/recorrencias", "Recorrências");
    const rule = rules(o.ledger)[0]!;
    await goTo(o, { ref: `${rule.id}:2026-09-10` });
    const table = screen.getByRole("grid", { name: "Previsões" });
    await waitFor(() => expect(selected(table, forecastId(rule.id, "2026-09-10" as IsoDate))).toBe("true"));
    expect(screen.queryByRole("dialog")).toBeNull();
    // the link is consumed: a reload or a back does not repeat it
    await addressSettles(o.router, {});
  });

  it("'vincular' opens the link dialog on that forecast, with its candidates", async () => {
    const o = await openPage("/recorrencias", "Recorrências");
    const rule = seedRule(o.workspace, {
      description: "Posto Shell",
      amount: "145.00",
      category: "Transporte",
      day: 6,
      start: makeDate(2026, 10, 1),
    });
    await goTo(o, { ref: `${rule.id}:2026-10-06`, act: "vincular" });
    const dialog = await screen.findByRole("dialog", { name: "Vincular realizado" });
    expect(flat(dialog.textContent)).toContain("Previsão de 06/10/2026: Posto Shell");
    expect(within(dialog).getByText("06/10/2026 Posto Shell")).toBeTruthy();
    const table = screen.getByRole("grid", { name: "Previsões" });
    expect(selected(table, forecastId(rule.id, day(6)))).toBe("true");
    await o.user.click(within(dialog).getByRole("button", { name: "Vincular" }));
    await waitFor(() => expect(linkCount(o.ledger)).toBe(1));
  });

  it("'vincular' on a forecast with no candidate selects it and says so", async () => {
    const o = await openPage("/recorrencias", "Recorrências");
    const rule = rules(o.ledger)[0]!;
    await goTo(o, { ref: `${rule.id}:2026-08-10`, act: "vincular" });
    expect(await screen.findByText("Nenhum lançamento compatível (conta, valor e data).")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    const table = screen.getByRole("grid", { name: "Previsões" });
    expect(selected(table, forecastId(rule.id, "2026-08-10" as IsoDate))).toBe("true");
  });

  it("'rule:<id>' opens the subscriptions and selects the rule in both tables", async () => {
    const o = await openPage("/recorrencias", "Recorrências");
    const rule = rules(o.ledger)[0]!;
    // the person had collapsed the section: a link to a price change opens it
    await o.user.click(screen.getByRole("button", { name: "Assinaturas e contas fixas" }));
    await waitFor(() => expect(screen.queryByRole("grid", { name: "Assinaturas e contas fixas" })).toBeNull());
    await goTo(o, { ref: ruleRef(rule.id) });
    const commitments = await screen.findByRole("grid", { name: "Assinaturas e contas fixas" });
    await waitFor(() => expect(selected(commitments, rule.id)).toBe("true"));
    expect(selected(screen.getByRole("grid", { name: "Regras de recorrência" }), rule.id)).toBe("true");
    await addressSettles(o.router, {});
  });

  it("ignores a reference it does not understand and tells when the forecast left the period", async () => {
    const o = await openPage("/recorrencias", "Recorrências");
    const rule = rules(o.ledger)[0]!;
    await goTo(o, { ref: "isto-nao-e-uma-referencia", act: "vincular" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await goTo(o, { ref: `${rule.id}:2020-01-10`, act: "vincular" });
    expect(await screen.findByText("Esta previsão já não está no período mostrado.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(linkCount(o.ledger)).toBe(0);
  });

  it("is the destination the notices and calendar entries name, in the format this page reads", async () => {
    const o = await openPage("/recorrencias", "Recorrências");
    const today = o.workspace.today();
    const rule = rules(o.ledger)[0]!;
    // the notice of a late forecast
    const late = dom.alerts
      .recurrenceAlerts(o.ledger, today)
      .find((alert) => alert.severity === dom.alerts.Severity.URGENT)!;
    expect(late).toBeTruthy();
    const link = alertLink(late);
    expect(link).toMatchObject({ page: "recorrencias", act: "vincular", label: "Vincular…" });
    expect(link.ref).toMatch(new RegExp(`^${rule.id}:\\d{4}-\\d{2}-\\d{2}$`));
    const forecasts = dom.recurrence.forecasts(o.ledger, ...forecastWindow(today), today);
    expect(forecasts.some((f) => forecastId(f.ruleId, f.dueOn) === link.ref)).toBe(true);
    await goTo(o, { ref: link.ref as string, act: link.act as string });
    const table = screen.getByRole("grid", { name: "Previsões" });
    await waitFor(() => expect(selected(table, link.ref as string)).toBe("true"));

    // the calendar entry of a late recurrence
    const september = dom.agenda.monthEvents(o.ledger, { year: 2026, month: 9 }, today);
    const entry = september.find((event) => event.target === "recurrences")!;
    expect(entry.state).toBe(dom.agenda.EventState.LATE);
    expect(eventLink(entry)).toMatchObject({ page: "recorrencias", ref: `${rule.id}:2026-09-10`, act: "vincular" });
  });

  it("the projection command leaves for the report with its reference", async () => {
    const o = await openPage("/recorrencias", "Recorrências");
    const went = navigations(o.router);
    await o.user.click(screen.getByRole("button", { name: "Mais" }));
    await o.user.click(await screen.findByRole("menuitem", { name: "Projeção de compromissos (Relatórios)" }));
    await wentTo(went, "/relatorios", { ref: "projected_balance" });
  });
});
