/**
 * Phase 5: quantities, lots, corporate events and return methods. Port of `tests/test_portfolio.py`
 * without the brokerage notes and the benchmark (they need `investments/notes` and `benchmarks`).
 */
import { describe, expect, it } from "vitest";

import { DomainError } from "../src/domain/ledger.ts";
import * as queries from "../src/domain/queries.ts";
import type { IsoDate } from "../src/lib/dates.ts";
import { Dec } from "../src/lib/dec.ts";
import { AssetClass, realizedGain, TrackingMode, ValueNature } from "../src/investments/model.ts";
import { modifiedDietz, twr, xirr, xirrFromFlows } from "../src/investments/returns.ts";
import * as inv from "../src/investments/service.ts";
import {
  averagePrice,
  bonus,
  buy,
  CostMethod,
  holding,
  lotsOf,
  openingLot,
  quantityOn,
  sell,
  split,
} from "../src/investments/trades.ts";
import { family, type Family } from "./fixtures.ts";

const D = (s: string) => Dec.from(s);
const d = (s: string) => s as IsoDate;

function stock(f: Family, assetClass: AssetClass = AssetClass.STOCK) {
  f.ledger.recordOpeningBalance(f.bank, "100000.00", d("2025-12-31"));
  return inv.createPosition(f.ledger, "PETR4", assetClass, d("2026-01-02"), {
    mode: TrackingMode.QUANTITY,
    ticker: "PETR4",
  });
}

describe("lots and trades", () => {
  it("sells at average cost", () => {
    const f = family();
    const pos = stock(f);
    buy(f.ledger, pos.id, d("2026-01-02"), "100", "10.00", f.bank, { fees: "1.00" });
    buy(f.ledger, pos.id, d("2026-02-02"), "100", "20.00", f.bank, { fees: "1.00" });
    expect(holding(f.ledger, pos.id).cost.eq("3002.00")).toBe(true);
    const event = sell(f.ledger, pos.id, d("2026-03-02"), "50", "25.00", f.bank, { fees: "0.50" });
    expect(event.cost_attributed!.eq("750.50")).toBe(true); // 3002 × 50/200
    expect(realizedGain(event)!.eq(D("1250.00").sub("750.50"))).toBe(true);
    const remaining = holding(f.ledger, pos.id);
    expect(remaining.quantity.eq("150") && remaining.cost.eq("2251.50")).toBe(true);
    expect(inv.remainingCost(f.ledger, pos.id).eq("2251.50")).toBe(true);
    expect(event.cost_method ?? "").toContain("custo médio");
  });

  it("uses lots (FIFO) for fixed income", () => {
    const f = family();
    const pos = stock(f, AssetClass.TREASURY);
    buy(f.ledger, pos.id, d("2026-01-02"), "1", "1000.00", f.bank);
    buy(f.ledger, pos.id, d("2026-02-02"), "1", "1100.00", f.bank);
    const event = sell(f.ledger, pos.id, d("2026-03-02"), "1", "1200.00", f.bank);
    expect(event.cost_attributed!.eq("1000.00")).toBe(true);
    expect(lotsOf(f.ledger, pos.id).map((lot) => lot.remaining_quantity.toString())).toEqual(["0", "1"]);
  });

  it("takes a method override and refuses short selling", () => {
    const f = family();
    const pos = stock(f, AssetClass.TREASURY);
    buy(f.ledger, pos.id, d("2026-01-02"), "2", "100.00", f.bank);
    sell(f.ledger, pos.id, d("2026-01-03"), "1", "110.00", f.bank, { method: CostMethod.AVERAGE });
    expect(() => sell(f.ledger, pos.id, d("2026-01-04"), "5", "110.00", f.bank)).toThrow(DomainError);
    expect(holding(f.ledger, pos.id).quantity.eq("1")).toBe(true);
  });

  it("keeps the cost on a split and adds quantity on a bonus", () => {
    const f = family();
    const pos = stock(f);
    buy(f.ledger, pos.id, d("2026-01-02"), "100", "10.00", f.bank);
    split(f.ledger, pos.id, d("2026-02-01"), "2");
    const h = holding(f.ledger, pos.id);
    expect(h.quantity.eq("200") && h.cost.eq("1000.00")).toBe(true);
    bonus(f.ledger, pos.id, d("2026-03-01"), "20", "0");
    expect(holding(f.ledger, pos.id).quantity.eq("220")).toBe(true);
    expect(quantityOn(f.ledger, pos.id, d("2026-02-15")).eq("200")).toBe(true);
    expect(quantityOn(f.ledger, pos.id, d("2026-01-15")).eq("100")).toBe(true);
  });

  it("an opening lot is equity, not income", () => {
    const f = family();
    const pos = stock(f);
    openingLot(f.ledger, pos.id, d("2026-01-02"), "300", "4500.00");
    expect(averagePrice(holding(f.ledger, pos.id))!.eq("15")).toBe(true);
    expect(queries.incomeStatement(f.ledger, { year: 2026, month: 1 }).totalIncome.isZero()).toBe(true);
  });

  it("a value position cannot trade quantities", () => {
    const f = family();
    f.ledger.recordOpeningBalance(f.bank, "1000", d("2025-12-31"));
    const pos = inv.createPosition(f.ledger, "CDB", AssetClass.FIXED_INCOME, d("2026-01-01"), {
      initial_cost: "100",
      from_account: f.bank,
    });
    expect(() => buy(f.ledger, pos.id, d("2026-01-02"), "1", "1", f.bank)).toThrow(DomainError);
  });
});

function valuePosition(f: Family) {
  f.ledger.recordOpeningBalance(f.bank, "100000.00", d("2025-12-31"));
  return inv.createPosition(f.ledger, "Fundo", AssetClass.FUND, d("2026-01-01"), {
    initial_cost: "1000",
    from_account: f.bank,
  });
}

describe("return methods", () => {
  it("TWR with valuations on flow dates", () => {
    const f = family();
    const pos = valuePosition(f);
    inv.addValuation(f.ledger, pos.id, d("2026-02-01"), "2100", ValueNature.GROSS);
    inv.contribute(f.ledger, pos.id, "1000", d("2026-02-01"), f.bank);
    inv.addValuation(f.ledger, pos.id, d("2026-03-01"), "1995", ValueNature.GROSS);
    const result = twr(f.ledger, pos.id, d("2026-01-01"), d("2026-03-01"));
    expect(result.value!.eq(D("1.1").mul("0.95").sub(1))).toBe(true);
  });

  it("TWR is unavailable without a valuation at the flow (TA-27)", () => {
    const f = family();
    const pos = valuePosition(f);
    inv.contribute(f.ledger, pos.id, "1000", d("2026-02-01"), f.bank);
    inv.addValuation(f.ledger, pos.id, d("2026-03-01"), "2100", ValueNature.GROSS);
    const result = twr(f.ledger, pos.id, d("2026-01-01"), d("2026-03-01"));
    expect(result.value).toBeNull();
    expect(result.notes[0]).toContain("interpolação");
  });

  it("Modified Dietz matches the formula", () => {
    const f = family();
    const pos = valuePosition(f);
    inv.contribute(f.ledger, pos.id, "500", d("2026-01-11"), f.bank); // 20 of 30 days remain
    inv.addValuation(f.ledger, pos.id, d("2026-01-31"), "1560", ValueNature.GROSS);
    const result = modifiedDietz(f.ledger, pos.id, d("2026-01-01"), d("2026-01-31"));
    const expected = D("1560")
      .sub("1000")
      .sub("500")
      .div(D("1000").add(D("500").mul(20).div(30)));
    expect(result.value!.eq(expected)).toBe(true);
    expect(result.quality).toBe("estimate");
  });

  it("XIRR simple case", () => {
    const [rate] = xirrFromFlows([
      [d("2025-01-01"), D("-1000")],
      [d("2026-01-01"), D("1100")],
    ]);
    expect(rate!.sub("0.1").abs().lt("1e-9")).toBe(true);
  });

  it("XIRR without a solution or with several roots is unavailable", () => {
    expect(
      xirrFromFlows([
        [d("2025-01-01"), D("100")],
        [d("2026-01-01"), D("100")],
      ])[0],
    ).toBeNull();
    // Sign changes twice: two roots (10% and 20%); no arbitrary choice.
    const [rate, reason] = xirrFromFlows([
      [d("2024-01-01"), D("-100")],
      [d("2025-01-01"), D("230")],
      [d("2026-01-01"), D("-132")],
    ]);
    expect(rate).toBeNull();
    expect(reason).toContain("Múltiplas");
  });

  it("XIRR on a position", () => {
    const f = family();
    const pos = valuePosition(f);
    inv.addValuation(f.ledger, pos.id, d("2027-01-01"), "1100", ValueNature.GROSS);
    const result = xirr(f.ledger, pos.id, d("2026-01-01"), d("2027-01-01"));
    expect(result.value!.sub("0.1").abs().lt("1e-9")).toBe(true);
  });
});
