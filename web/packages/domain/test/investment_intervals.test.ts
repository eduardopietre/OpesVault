/** Equivalent rates and the intervals between valuations (docs/06 §4–5): money result and return of each stretch. */
import { describe, expect, it } from "vitest";

import type { IsoDate } from "../src/lib/dates.ts";
import { Dec } from "../src/lib/dec.ts";
import { AssetClass, ValueNature } from "../src/investments/model.ts";
import { Quality } from "../src/investments/performance.ts";
import { equivalentRate, intervals, MONTH_DAYS, YEAR_DAYS } from "../src/investments/returns.ts";
import * as inv from "../src/investments/service.ts";
import { family } from "./fixtures.ts";

const d = (s: string) => s as IsoDate;
const close = (value: Dec | null, expected: string) => value !== null && value.sub(expected).abs().lt("0.0000000001");

describe("equivalent rates", () => {
  it("restates a yearly rate over a month and a monthly rate over a year, compounded", () => {
    // 12% a year is 0.9488793% a month: 1.12^(1/12) − 1
    expect(close(equivalentRate(Dec.from("0.12"), YEAR_DAYS, MONTH_DAYS), "0.009488792934583")).toBe(true);
    // 1% a month is 12.682503% a year: 1.01^12 − 1
    expect(close(equivalentRate(Dec.from("0.01"), MONTH_DAYS, YEAR_DAYS), "0.126825030131970")).toBe(true);
    expect(equivalentRate(Dec.from("0"), 30, MONTH_DAYS)!.isZero()).toBe(true);
  });

  it("has no answer for a total loss or a period without length", () => {
    expect(equivalentRate(Dec.from("-1"), 30, MONTH_DAYS)).toBeNull();
    expect(equivalentRate(Dec.from("0.05"), 0, MONTH_DAYS)).toBeNull();
  });
});

describe("intervals between valuations", () => {
  function cdb() {
    const f = family();
    f.ledger.recordOpeningBalance(f.bank, "100000.00", d("2025-12-31"));
    const pos = inv.createPosition(f.ledger, "CDB Banco X", AssetClass.FIXED_INCOME, d("2026-01-01"), {
      initial_cost: "10000.00",
      from_account: f.bank,
    });
    return { f, pos };
  }

  it("gives each stretch its money result and its return, with no contribution (example A)", () => {
    const { f, pos } = cdb();
    inv.addValuation(f.ledger, pos.id, d("2026-01-31"), "10100", ValueNature.GROSS);
    inv.addValuation(f.ledger, pos.id, d("2026-02-28"), "10250", ValueNature.GROSS);
    const found = intervals(f.ledger, pos.id);
    expect(found.map((i) => [i.start, i.end, i.days])).toEqual([
      ["2026-01-01", "2026-01-31", 30],
      ["2026-01-31", "2026-02-28", 28],
    ]);
    expect(found.map((i) => i.gain.value!.eq(i.end === "2026-01-31" ? "100" : "150"))).toEqual([true, true]);
    expect(found.every((i) => i.flows.isZero())).toBe(true);
    expect(found[0]!.rate.value!.eq("0.01")).toBe(true);
    expect(found[0]!.rate.quality).toBe(Quality.OBSERVED);
    // 1% in 30 days, restated over 365/12 days
    expect(close(found[0]!.monthly, Dec.from("1.01").ln().mul(MONTH_DAYS.div(30)).exp_().sub(1).toString())).toBe(true);
  });

  it("does not count a contribution as income, and estimates the return of that stretch (example B)", () => {
    const { f, pos } = cdb();
    inv.contribute(f.ledger, pos.id, "5000.00", d("2026-02-10"), f.bank);
    inv.addValuation(f.ledger, pos.id, d("2026-03-31"), "15300", ValueNature.GROSS);
    const [only] = intervals(f.ledger, pos.id);
    expect(only!.flows.eq("5000")).toBe(true);
    expect(only!.gain.value!.eq("300")).toBe(true);
    expect(only!.rate.method).toContain("Modified Dietz");
    expect(only!.rate.quality).toBe(Quality.ESTIMATE);
    expect(only!.rate.value!.isPositive()).toBe(true);
    expect(only!.monthly).not.toBeNull();
  });

  it("is empty with a single valuation", () => {
    const { f, pos } = cdb();
    expect(intervals(f.ledger, pos.id)).toEqual([]);
  });
});
