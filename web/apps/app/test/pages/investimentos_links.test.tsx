/** Investimentos: the links into the page (maturity notices, calendar, "avaliar", "simular") and out of it. */
import { addDays, dom, investments, ymOf, type Id } from "@opesvault/domain";
import { act as reactAct, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { alertLink, eventLink } from "../../src/data/links.ts";
import { cdbOf, openInvestimentos } from "./investimentos_harness.tsx";
import { dialog, rowOf, selectedRow, table } from "../dom.ts";
import { addressSettles, navigations } from "../navigations.ts";

const { service, model, profile, trades } = investments;

type Opened = Awaited<ReturnType<typeof openInvestimentos>>;

/** Follows a link the way another page does: navigating to this one with `ref` and `act`. */
const follow = (router: Opened["router"], ref: string, act?: string) =>
  reactAct(() => router.navigate({ to: "/investimentos", search: { ref, ...(act ? { act } : {}) } as never }));

/** A second position, so that selecting it by link is visible. */
function second(opened: Opened, name = "LCI Banco Z"): Id {
  return opened.workspace.act((l) =>
    service.createPosition(l, name, model.AssetClass.FIXED_INCOME, opened.workspace.today(), {
      initial_cost: "800",
    }),
  ).id;
}

describe("Links into Investimentos", () => {
  it("a ref selects the position and shows its detail; the link is consumed", async () => {
    const opened = await openInvestimentos();
    const id = second(opened);
    await follow(opened.router, id);
    expect(await screen.findByRole("heading", { level: 2, name: "LCI Banco Z" })).toBeTruthy();
    expect(selectedRow(await table("Investimentos"))!.getAttribute("data-row-id")).toBe(id);
    await addressSettles(opened.router, {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a ref that is not a position of this project is ignored", async () => {
    const opened = await openInvestimentos();
    await follow(opened.router, "nao-existe");
    await addressSettles(opened.router, {});
    expect(selectedRow(await table("Investimentos"))!.getAttribute("data-row-id")).toBe(cdbOf(opened.ledger));
  });

  it("'avaliar' opens the new valuation of that position", async () => {
    const opened = await openInvestimentos();
    const id = second(opened);
    await follow(opened.router, id, "avaliar");
    expect(await dialog("Nova avaliação — LCI Banco Z")).toBeTruthy();
    expect(selectedRow(await table("Investimentos"))!.getAttribute("data-row-id")).toBe(id);
  });

  it("'simular' opens the simulator, or asks for a tax rule first", async () => {
    const opened = await openInvestimentos();
    const id = cdbOf(opened.ledger);
    await follow(opened.router, id, "simular");
    expect(await screen.findByText("Cadastre antes uma regra de imposto (Mais › Regra de imposto…).")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    opened.workspace.act((l) =>
      l.put(
        "tax_rule",
        model.TaxRuleSchema.parse({ name: "Regra", kind: "rate_on_positive_gain", rate: "0.15" }) as never,
      ),
    );
    await follow(opened.router, id, "simular");
    expect(await dialog("Simular resgate — CDB Banco X 2028")).toBeTruthy();
  });

  it("a maturity notice and a calendar entry, the real links, land on the position", async () => {
    const opened = await openInvestimentos();
    const today = opened.workspace.today();
    const id = second(opened, "CDB vencendo");
    opened.workspace.act((l) =>
      profile.saveProfile(
        l,
        profile.InvestmentProfileSchema.parse({
          position_id: id,
          irpf_group: "04",
          irpf_code: "02",
          maturity: addDays(today, 5),
        }),
      ),
    );
    const alerts = dom.alerts.maturityAlerts(opened.ledger, today);
    expect(alerts.length).toBeGreaterThan(0);
    const links = alerts.map(alertLink);
    links.push(
      ...dom.agenda
        .monthEvents(opened.ledger, ymOf(addDays(today, 5)), today)
        .filter((e) => e.target === "investments")
        .map(eventLink),
    );
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.page).toBe("investimentos");
      await follow(opened.router, link.ref!, link.act);
      expect(await screen.findByRole("heading", { level: 2, name: "CDB vencendo" })).toBeTruthy();
      await addressSettles(opened.router, {});
    }
    // the maturity is a warning figure with the days left
    expect(await screen.findByText(/em 5 dias/)).toBeTruthy();
  });
});

describe("Links out of Investimentos", () => {
  async function watch(opened: Opened) {
    return navigations(opened.router);
  }

  it("'Ver lançamentos' goes to the Livro filtered by the investment's account", async () => {
    const opened = await openInvestimentos();
    const seen = await watch(opened);
    const id = cdbOf(opened.ledger);
    await opened.user.click(await screen.findByRole("button", { name: "Ver lançamentos" }));
    await waitFor(() =>
      expect(seen).toContainEqual({
        pathname: "/livro",
        search: { ref: `conta:${service.position(opened.ledger, id).account_id}` },
      }),
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Livro financeiro" }, { timeout: 8000 })).toBeTruthy();
  });

  it("'Ver conta bancária' goes to Contas on the bank account that holds it", async () => {
    const opened = await openInvestimentos();
    const seen = await watch(opened);
    const bankId = profile.profileOf(opened.ledger, cdbOf(opened.ledger))!.bank_account_id!;
    await opened.user.click(await screen.findByRole("button", { name: "Ver conta bancária" }));
    await waitFor(() => expect(seen).toContainEqual({ pathname: "/contas", search: { ref: `banco:${bankId}` } }));
    expect(await screen.findByRole("heading", { level: 1, name: "Contas e cartões" }, { timeout: 8000 })).toBeTruthy();
  });

  it("a position without a bank account has no such button; 'Composição' goes to Relatórios", async () => {
    const opened = await openInvestimentos();
    const id = second(opened);
    await follow(opened.router, id);
    await screen.findByRole("heading", { level: 2, name: "LCI Banco Z" });
    expect(screen.queryByRole("button", { name: "Ver conta bancária" })).toBeNull();
    const seen = await watch(opened);
    await opened.user.click(screen.getByRole("button", { name: "Mais" }));
    await opened.user.click(await screen.findByRole("menuitem", { name: /Composição da carteira/ }));
    await waitFor(() => expect(seen).toContainEqual({ pathname: "/relatorios", search: { ref: "composition" } }));
  });

  it("the table is sorted and a row is opened for its characteristics", async () => {
    const opened = await openInvestimentos();
    second(opened);
    const grid = await table("Investimentos");
    await opened.user.dblClick(rowOf(grid, "LCI Banco Z"));
    expect(await dialog("Características do investimento")).toBeTruthy();
    expect(trades.lots(opened.ledger).size).toBe(0);
  });
});
