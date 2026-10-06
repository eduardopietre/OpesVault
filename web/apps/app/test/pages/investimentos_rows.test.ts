/** Investimentos without React: the rows, the figures, the labels and the lazy calculation's cache. */
import {
  AccountSubtype,
  AccountType,
  Dec,
  LedgerAccountSchema,
  addDays,
  formatBrl,
  investments,
  makeDate,
} from "@opesvault/domain";
import { describe, expect, it } from "vitest";
import { percent } from "../../src/dialogs/investment_forms.ts";
import {
  assembleReturns,
  daysText,
  figures,
  noteRows,
  parseReveal,
  periodDates,
  planReturns,
  portfolioRows,
  profileSummary,
  returnRows,
  summaryLine,
} from "../../src/pages/investimentos/rows.ts";
import { Workspace } from "../../src/data/workspace.ts";
import { finishXirr } from "../../src/pages/investimentos/xirr.ts";

const { service, model, trades, profile, returns } = investments;

function emptyLedger() {
  return Workspace.fromRecords([], "Teste").ledger;
}

describe("rows of Investimentos", () => {
  it("shows a rate as a percentage, and a missing one as unavailable (never 0%)", () => {
    expect(percent(Dec.from("0.1234"))).toBe("12,34%");
    expect(percent(Dec.from(0))).toBe("0,00%");
    expect(percent(null)).toBe("indisponível");
  });

  it("says the days left in words", () => {
    expect(daysText(0)).toBe("hoje");
    expect(daysText(1)).toBe("em 1 dia");
    expect(daysText(12)).toBe("em 12 dias");
    expect(daysText(-1)).toBe("há 1 dia");
    expect(daysText(-30)).toBe("há 30 dias");
  });

  it("unknown is not zero: a position known only by a reference value has no cost and no gain", () => {
    const ledger = emptyLedger();
    const position = service.createPosition(ledger, "Herança", model.AssetClass.FUND, makeDate(2026, 1, 1), {
      reference_value: "9000",
    });
    const today = makeDate(2026, 6, 1);
    const [row] = portfolioRows(ledger, today);
    expect(row).toMatchObject({ cost: "desconhecido", unrealized: "indisponível", value: formatBrl(Dec.from(9000)) });
    expect(row!.costSort).toBeNull();
    expect(row!.unrealizedSort).toBeNull();
    const shown = figures(ledger, position.id, today);
    expect(shown.cost).toBe("desconhecido");
    expect(shown.unrealized).toBe("indisponível");
    expect(shown.unrealizedRaw).toBeNull();
    expect(shown.reason).toBe("Custo de aquisição desconhecido.");
    // no characteristics yet: the summary says where to add them
    expect(profileSummary(ledger, position.id)).toEqual(["Sem características (Mais › Características…)"]);
  });

  it("a position without a valuation says so, and the return needs two valuations on different dates", () => {
    const ledger = emptyLedger();
    const position = service.createPosition(ledger, "Sem valor", model.AssetClass.OTHER, makeDate(2026, 1, 1), {
      reference_value: "100",
    });
    // a reference valuation exists; delete the idea of a second one
    expect(periodDates(ledger, position.id)).toEqual(["2026-01-01"]);
    const plan = planReturns(ledger, position.id, makeDate(2026, 1, 1), makeDate(2026, 3, 1), null);
    const results = assembleReturns(plan, finishXirr(plan.xirr, null, ""));
    expect(results.every((r) => r.value === null)).toBe(true);
    const rows = returnRows(results);
    expect(
      rows.every(
        (r: { available: boolean; value: string; notes: string }) =>
          !r.available && r.value === "indisponível" && r.notes.length > 0,
      ),
    ).toBe(true);
  });

  it("the maturity is a warning inside 30 days and quiet after; a closed position has no countdown", () => {
    const ledger = emptyLedger();
    const position = service.createPosition(ledger, "CDB", model.AssetClass.FIXED_INCOME, makeDate(2026, 1, 1), {
      initial_cost: "1000",
    });
    const today = makeDate(2026, 6, 1);
    const save = (days: number) =>
      profile.saveProfile(
        ledger,
        profile.InvestmentProfileSchema.parse({
          position_id: position.id,
          irpf_group: "04",
          irpf_code: "02",
          maturity: addDays(today, days),
        }),
      );
    save(20);
    expect(figures(ledger, position.id, today)).toMatchObject({ maturityTone: "warning" });
    expect(figures(ledger, position.id, today).maturity).toContain("em 20 dias");
    save(400);
    expect(figures(ledger, position.id, today).maturityTone).toBeNull();
    save(-3);
    expect(figures(ledger, position.id, today).maturity).toContain("há 3 dias");
  });

  it("parseReveal accepts only the positions of the project", () => {
    const ledger = emptyLedger();
    const position = service.createPosition(ledger, "CDB", model.AssetClass.FIXED_INCOME, makeDate(2026, 1, 1), {
      initial_cost: "1000",
    });
    expect(parseReveal(position.id, ledger)).toBe(position.id);
    expect(parseReveal("outro", ledger)).toBeNull();
    expect(parseReveal(undefined, ledger)).toBeNull();
    expect(summaryLine(ledger)).toBe("1 em carteira");
  });

  it("groups the trades of one note and counts buys and sells", () => {
    const ledger = emptyLedger();
    const cash = ledger.addAccount(
      LedgerAccountSchema.parse({ name: "Corretora", type: AccountType.ASSET, subtype: AccountSubtype.CHECKING }),
    );
    const position = service.createPosition(ledger, "PETR4", model.AssetClass.STOCK, makeDate(2026, 1, 1), {
      mode: model.TrackingMode.QUANTITY,
      ticker: "PETR4",
    });
    trades.openingLot(ledger, position.id, makeDate(2026, 1, 1), "100", "3000");
    trades.buy(ledger, position.id, makeDate(2026, 2, 3), "10", "30.00", cash.id, { fees: "1.00", note: "nota 55" });
    trades.sell(ledger, position.id, makeDate(2026, 2, 3), "5", "31.00", cash.id, { fees: "0.50", note: "nota 55" });
    const rows = noteRows(ledger);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ number: "55", trades: "1 compra e 1 venda", assets: "PETR4", pending: false });
  });
});

describe("the internal rate of return, planned and finished", () => {
  /** The same methods, whichever way they were computed. */
  const shape = (results: readonly investments.performance.Result[]) =>
    JSON.stringify(results.map((r) => [r.method, r.value?.toFixed() ?? null, r.quality, r.notes, r.start, r.end]));

  function history() {
    const ledger = emptyLedger();
    const cash = ledger.addAccount(
      LedgerAccountSchema.parse({ name: "Caixa", type: AccountType.ASSET, subtype: AccountSubtype.CHECKING }),
    );
    ledger.recordOpeningBalance(cash.id, "100000", makeDate(2025, 1, 1));
    const position = service.createPosition(ledger, "CDB", model.AssetClass.FIXED_INCOME, makeDate(2026, 1, 2), {
      initial_cost: "1000",
      from_account: cash.id,
    });
    let value = 1000;
    for (const [month, day] of [
      [2, 2],
      [3, 2],
      [4, 2],
      [5, 4],
    ] as const) {
      service.contribute(ledger, position.id, "100", makeDate(2026, month, day), cash.id);
      value = value * 1.01 + 100;
      service.addValuation(ledger, position.id, makeDate(2026, month, day), value.toFixed(2), model.ValueNature.GROSS);
    }
    service.addValuation(ledger, position.id, makeDate(2026, 1, 2), "1000", model.ValueNature.GROSS, {
      source: "início",
    });
    return { ledger, position };
  }

  it("planned with the quick methods and finished with the solver, they equal the domain's four methods", () => {
    const { ledger, position } = history();
    const dates = periodDates(ledger, position.id);
    const [start, end] = [dates[0]!, dates[dates.length - 1]!];
    const plan = planReturns(ledger, position.id, start, end, null);
    expect(plan.xirr.settled).toBeNull();
    const [rate, reason] = returns.xirrFromFlows(plan.xirr.dated);
    const mine = assembleReturns(plan, finishXirr(plan.xirr, rate, reason));
    expect(shape(mine)).toBe(shape(returns.allMethods(ledger, position.id, start, end)));
    expect(finishXirr(plan.xirr, rate, reason).value).not.toBeNull();
  });

  it("settles at once when the data do not allow the method, with the domain's reason", () => {
    const { ledger, position } = history();
    // no valuation on these dates
    const plan = planReturns(ledger, position.id, makeDate(2026, 1, 3), makeDate(2026, 5, 4), null);
    expect(plan.xirr.settled?.notes).toEqual(["Faltam avaliações no início e no fim."]);
    expect(shape([plan.xirr.settled!])).toBe(
      shape([returns.xirr(ledger, position.id, makeDate(2026, 1, 3), makeDate(2026, 5, 4))]),
    );
  });

  it("a rate the solver could not find is unavailable with its reason, never zero", () => {
    const { ledger, position } = history();
    const plan = planReturns(ledger, position.id, makeDate(2026, 1, 2), makeDate(2026, 5, 4), null);
    const result = finishXirr(plan.xirr, null, "Múltiplas raízes possíveis; taxa não escolhida arbitrariamente.");
    expect(result.value).toBeNull();
    expect(result.quality).toBe("unavailable");
    expect(result.notes).toEqual(["Múltiplas raízes possíveis; taxa não escolhida arbitrariamente."]);
  });
});
