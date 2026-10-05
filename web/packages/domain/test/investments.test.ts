/** Normative examples A-F (docs/06 §8) and investment acceptance tests (TA-20..TA-28, TA-36). Port of `tests/test_investments.py`. */
import { describe, expect, it } from "vitest";

import { DomainError } from "../src/domain/ledger.ts";
import * as queries from "../src/domain/queries.ts";
import type { IsoDate } from "../src/lib/dates.ts";
import type { Dec } from "../src/lib/dec.ts";
import {
  AssetClass,
  EventQuality,
  realizedGain,
  TaxRuleKind,
  TaxRuleSchema,
  TrackingMode,
  ValueNature,
} from "../src/investments/model.ts";
import {
  composition,
  compositionPartial,
  compositionTotal,
  periodResult,
  Quality,
  realized,
  selectedSeries,
  simpleReturn,
  unrealized,
} from "../src/investments/performance.ts";
import * as inv from "../src/investments/service.ts";
import { simulate } from "../src/investments/simulation.ts";
import { family, type Family } from "./fixtures.ts";

const d = (s: string) => s as IsoDate;
const FICTITIOUS_15 = TaxRuleSchema.parse({
  name: "Regra fictícia 15% sobre ganho",
  kind: TaxRuleKind.RATE_ON_POSITIVE_GAIN,
  rate: "0.15",
});

function cdb(f: Family, cost = "10000.00", on = d("2026-01-01")) {
  f.ledger.recordOpeningBalance(f.bank, "100000.00", d("2025-12-31"));
  return inv.createPosition(f.ledger, "CDB Banco X", AssetClass.FIXED_INCOME, on, {
    initial_cost: cost,
    from_account: f.bank,
  });
}

/** Exact comparison of decimals by value (Python `==`). */
function eq(a: Dec | null, b: string): boolean {
  return a !== null && a.eq(b);
}

describe("docs/06 examples", () => {
  it("A: successive valuations (TA-20)", () => {
    const f = family();
    const pos = cdb(f);
    for (const [when, value] of [
      ["2026-01-31", "10100"],
      ["2026-02-28", "10250"],
      ["2026-03-31", "10400"],
    ] as const) {
      inv.addValuation(f.ledger, pos.id, d(when), value, ValueNature.GROSS);
    }
    expect(selectedSeries(f.ledger, pos.id)).toHaveLength(4);
    expect(eq(periodResult(f.ledger, pos.id, d("2026-01-01"), d("2026-03-31")).value, "400.00")).toBe(true);
    expect(eq(simpleReturn(f.ledger, pos.id, d("2026-01-01"), d("2026-03-31")).value, "0.04")).toBe(true);
    expect(eq(unrealized(f.ledger, pos.id, d("2026-03-31")).value, "400.00")).toBe(true);
  });

  it("B: a contribution is not income (TA-21)", () => {
    const f = family();
    const pos = cdb(f);
    inv.contribute(f.ledger, pos.id, "5000.00", d("2026-02-10"), f.bank);
    inv.addValuation(f.ledger, pos.id, d("2026-03-31"), "15300", ValueNature.GROSS);
    expect(eq(periodResult(f.ledger, pos.id, d("2026-01-01"), d("2026-03-31")).value, "300.00")).toBe(true);
    const ret = simpleReturn(f.ledger, pos.id, d("2026-01-01"), d("2026-03-31"));
    expect(ret.value).toBeNull();
    expect(ret.notes[0]).toContain("aportes");
    expect(queries.incomeStatement(f.ledger, { year: 2026, month: 2 }).totalIncome.isZero()).toBe(true);
  });

  it("C: total redemption with simulated tax (TA-22)", () => {
    const f = family();
    const pos = cdb(f);
    inv.addValuation(f.ledger, pos.id, d("2026-06-30"), "12000", ValueNature.GROSS);
    const before = queries.balance(f.ledger, f.bank);
    const sim = simulate(f.ledger, pos.id, d("2026-06-30"), "12000", FICTITIOUS_15, { fees: "20" });
    expect([sim.cost_attributed, sim.gain, sim.tax, sim.net, sim.net_gain].map((x) => x?.toString())).toEqual([
      "10000.00",
      "2000.00",
      "300.00",
      "11680.00",
      "1680.00",
    ]);
    expect(eq(sim.gross_return, "0.2") && eq(sim.net_return, "0.168")).toBe(true);
    expect(queries.balance(f.ledger, f.bank).eq(before)).toBe(true);
    inv.redeem(f.ledger, pos.id, d("2026-06-30"), "12000", f.bank, { tax_withheld: "300", fees: "20", final: true });
    expect(queries.balance(f.ledger, f.bank).eq(before.add("11680.00"))).toBe(true);
    expect(inv.remainingCost(f.ledger, pos.id).isZero()).toBe(true);
    expect(eq(realized(f.ledger, pos.id).value, "2000.00")).toBe(true);
  });

  it("D: partial proportional redemption (TA-23)", () => {
    const f = family();
    const pos = cdb(f);
    inv.addValuation(f.ledger, pos.id, d("2026-06-30"), "12000", ValueNature.GROSS);
    const sim = simulate(f.ledger, pos.id, d("2026-06-30"), "3000", FICTITIOUS_15, {
      fees: "10",
      current_value: "12000",
    });
    expect([sim.cost_attributed, sim.gain, sim.tax, sim.net].map((x) => x?.toString())).toEqual([
      "2500.00",
      "500.00",
      "75.00",
      "2915.00",
    ]);
    expect(eq(sim.remaining_value, "9000") && eq(sim.remaining_cost, "7500.00")).toBe(true);
    const event = inv.redeem(f.ledger, pos.id, d("2026-06-30"), "3000", f.bank, { tax_withheld: "75", fees: "10" });
    expect(eq(event.cost_attributed, "2500.00") && eq(event.net, "2915.00")).toBe(true);
    expect(eq(inv.remainingCost(f.ledger, pos.id), "7500.00")).toBe(true);
    expect(eq(realizedGain(event), "500.00")).toBe(true);
  });

  it("E: external distribution (TA-24)", () => {
    const f = family();
    const pos = cdb(f);
    inv.distribute(f.ledger, pos.id, "200.00", d("2026-02-15"), f.bank);
    inv.addValuation(f.ledger, pos.id, d("2026-03-31"), "10100", ValueNature.GROSS);
    expect(eq(periodResult(f.ledger, pos.id, d("2026-01-01"), d("2026-03-31")).value, "300.00")).toBe(true);
    const total = simpleReturn(f.ledger, pos.id, d("2026-01-01"), d("2026-03-31"));
    expect(eq(total.value, "0.03")).toBe(true);
    expect(total.notes.some((n) => n.includes("distribuições"))).toBe(true);
    expect(eq(inv.remainingCost(f.ledger, pos.id), "10000.00")).toBe(true);
  });

  it("F: unknown cost (TA-25)", () => {
    const f = family();
    const pos = inv.createPosition(f.ledger, "Fundo antigo", AssetClass.FUND, d("2026-06-01"), {
      reference_value: "50000.00",
    });
    inv.addValuation(f.ledger, pos.id, d("2026-07-01"), "50500", ValueNature.GROSS);
    expect(eq(periodResult(f.ledger, pos.id, d("2026-06-01"), d("2026-07-01")).value, "500.00")).toBe(true);
    const gain = unrealized(f.ledger, pos.id, d("2026-07-01"));
    expect(gain.value).toBeNull();
    expect(gain.quality).toBe(Quality.UNAVAILABLE);
    const sim = simulate(f.ledger, pos.id, d("2026-07-01"), "1000", FICTITIOUS_15);
    expect(sim.tax).toBeNull();
    expect(sim.gain).toBeNull();
  });
});

describe("investment acceptance", () => {
  it("disagreeing sources on the same date (TA-26)", () => {
    const f = family();
    const pos = cdb(f);
    const first = inv.addValuation(f.ledger, pos.id, d("2026-01-31"), "10100", ValueNature.GROSS, {
      source: "extrato banco",
    });
    const second = inv.addValuation(f.ledger, pos.id, d("2026-01-31"), "10120", ValueNature.GROSS, { source: "app" });
    expect(first.selected && !second.selected).toBe(true);
    inv.selectValuation(f.ledger, second.id);
    const jan31 = selectedSeries(f.ledger, pos.id).filter((v) => v.on === "2026-01-31");
    expect(jan31).toHaveLength(1);
    expect(eq(jan31[0]!.value, "10120")).toBe(true);
    expect(inv.valuationsOf(f.ledger, pos.id)).toHaveLength(3);
    expect(() =>
      inv.addValuation(f.ledger, pos.id, d("2026-01-31"), "1", ValueNature.GROSS, { source: "app" }),
    ).toThrow(DomainError);
  });

  it("a valuation does not change cost or cash", () => {
    const f = family();
    const pos = cdb(f);
    const bank = queries.balance(f.ledger, f.bank);
    inv.addValuation(f.ledger, pos.id, d("2026-05-01"), "99999", ValueNature.GROSS);
    expect(eq(inv.remainingCost(f.ledger, pos.id), "10000.00")).toBe(true);
    expect(queries.balance(f.ledger, f.bank).eq(bank)).toBe(true);
  });

  it("gross and net points are not mixed", () => {
    const f = family();
    const pos = cdb(f);
    inv.addValuation(f.ledger, pos.id, d("2026-03-31"), "10300", ValueNature.NET_INFORMED);
    expect(periodResult(f.ledger, pos.id, d("2026-01-01"), d("2026-03-31")).value).toBeNull();
    expect(unrealized(f.ledger, pos.id, d("2026-03-31")).value).toBeNull();
  });

  it("tax due later reduces cash only when paid (TA-28)", () => {
    const f = family();
    const pos = cdb(f);
    inv.addValuation(f.ledger, pos.id, d("2026-06-30"), "12000", ValueNature.GROSS);
    const before = queries.balance(f.ledger, f.bank);
    inv.redeem(f.ledger, pos.id, d("2026-06-30"), "12000", f.bank, { tax_due_later: "300", final: true });
    expect(queries.balance(f.ledger, f.bank).eq(before.add("12000"))).toBe(true);
    expect(eq(queries.netWorth(f.ledger).liabilities, "300")).toBe(true);
    inv.payTax(f.ledger, "300", d("2026-07-31"), f.bank);
    expect(queries.balance(f.ledger, f.bank, d("2026-07-30")).eq(before.add("12000"))).toBe(true);
    expect(queries.balance(f.ledger, f.bank).eq(before.add("11700"))).toBe(true);
    expect(queries.incomeStatement(f.ledger, { year: 2026, month: 7 }).totalExpense.isZero()).toBe(true);
  });

  it("a net-only redemption is incomplete, then completed", () => {
    const f = family();
    const pos = cdb(f);
    inv.addValuation(f.ledger, pos.id, d("2026-06-30"), "12000", ValueNature.GROSS);
    const worth = queries.netWorth(f.ledger).net;
    const event = inv.redeemNetOnly(f.ledger, pos.id, d("2026-06-30"), "2915.00", f.bank);
    expect(event.quality).toBe(EventQuality.INCOMPLETE);
    expect(event.tax_withheld.isZero()).toBe(true);
    expect(event.gross).toBeNull();
    expect(queries.netWorth(f.ledger).net.eq(worth)).toBe(true);
    expect(periodResult(f.ledger, pos.id, d("2026-01-01"), d("2026-06-30")).quality).toBe(Quality.INCOMPLETE);
    expect(() => inv.completeRedemption(f.ledger, event.id, "3000", { tax_withheld: "80", fees: "10" })).toThrow(
      DomainError,
    );
    const done = inv.completeRedemption(f.ledger, event.id, "3000", { tax_withheld: "75", fees: "10" });
    expect(done.quality).toBe(EventQuality.COMPLETE);
    expect(eq(done.cost_attributed, "2500.00")).toBe(true);
    expect(eq(queries.balance(f.ledger, f.bank), "92915.00")).toBe(true);
  });

  it("composition is partial without a price (TA-36)", () => {
    const f = family();
    const a = cdb(f);
    inv.createPosition(f.ledger, "Ação sem preço", AssetClass.STOCK, d("2026-01-01"), { mode: TrackingMode.QUANTITY });
    inv.addValuation(f.ledger, a.id, d("2026-02-01"), "10100", ValueNature.GROSS);
    const portfolio = composition(f.ledger, d("2026-02-10"));
    expect(compositionPartial(portfolio)).toBe(true);
    expect(eq(compositionTotal(portfolio), "10100")).toBe(true);
    const line = portfolio.lines.find((l) => l.position_id === a.id)!;
    expect(line.as_of).toBe("2026-02-01");
    expect(line.age_days).toBe(9);
  });

  it("redeeming more than the cost is refused", () => {
    const f = family();
    const pos = cdb(f);
    expect(() => inv.redeem(f.ledger, pos.id, d("2026-02-01"), "100", f.bank, { cost_attributed: "20000" })).toThrow(
      DomainError,
    );
  });

  it("a simulation rule has a validity", () => {
    const f = family();
    const pos = cdb(f);
    inv.addValuation(f.ledger, pos.id, d("2026-06-30"), "12000", ValueNature.GROSS);
    const rule = { ...FICTITIOUS_15, valid_to: d("2025-12-31") };
    expect(() => simulate(f.ledger, pos.id, d("2026-06-30"), "12000", rule)).toThrow(DomainError);
  });
});
