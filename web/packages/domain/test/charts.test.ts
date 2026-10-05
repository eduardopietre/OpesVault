/**
 * Every chart the app draws, built on seeded ledgers and on an empty one (charts/data). Port of the
 * data parts of `tests/test_every_chart.py` (the desktop's demo vault goes through the import
 * pipeline; here the golden ledgers of `reports.json` stand in for it).
 *
 * Each builder must run without an error, keep money exact (a Dec or unknown, never a number), and its
 * table of values must say the same as its series: one row per x, the total of a flow equal to the sum
 * of its known values, and no total for positions such as balances.
 */
import { describe, expect, it } from "vitest";

import * as charts from "../src/charts/data/index.ts";
import { Ledger, type LedgerRecord } from "../src/domain/ledger.ts";
import { ZERO } from "../src/domain/money.ts";
import * as tags from "../src/domain/tags.ts";
import { Dec } from "../src/lib/dec.ts";
import { type IsoDate, ym, ymParse } from "../src/lib/dates.ts";
import { golden } from "./golden.ts";

const HELPERS = new Set(["addsUp", "chart", "datePoint", "monthName", "monthsBetween", "point", "series", "tableRows"]);

const first = (l: Ledger, kind: string) => [...l.entities(kind).keys()][0];

/** A builder per chart; null when the ledger has nothing for it to point at (a card, a goal, a tag...). */
const BUILDERS: Record<string, (ledger: Ledger) => charts.Chart | null> = {
  monthlyInOut: (l) => charts.monthlyInOut(l, ym(2026, 1), ym(2026, 6)),
  monthlyResult: (l) => charts.monthlyResult(l, ym(2026, 1), ym(2026, 6)),
  cashFlowBalance: (l) => charts.cashFlowBalance(l, ym(2026, 1), ym(2026, 6)),
  monthlySummary: (l) => charts.monthlySummary(l, ym(2026, 1), ym(2026, 6)),
  projectedBalance: (l) => charts.projectedBalance(l, "2026-03-31" as IsoDate),
  commitmentsProjection: (l) => charts.commitmentsProjection(l, ym(2026, 1)),
  annualChart: (l) => charts.annualChart(l, 2026),
  expensesByCategory: (l) => charts.expensesByCategory(l, ym(2026, 1), ym(2026, 6)),
  categoryMonthly: (l) => charts.categoryMonthly(l, l.categories("expense")[0]!.id, ym(2026, 1), ym(2026, 6)),
  categoryComparisonChart: (l) => charts.categoryComparisonChart(l, ym(2026, 3)),
  budgetHistory: (l) => charts.budgetHistory(l, ym(2026, 1), ym(2026, 6)),
  tagsOverview: (l) => charts.tagsOverview(l),
  merchantsChart: (l) => charts.merchantsChart(l, "2026-01-01" as IsoDate, "2026-06-30" as IsoDate),
  netWorthSeries: (l) => charts.netWorthSeries(l, ym(2026, 1), ym(2026, 6)),
  portfolioComposition: (l) => charts.portfolioComposition(l, "2026-03-31" as IsoDate),
  accountBalanceHistory: (l) => {
    const account = [...l.accounts.values()].find((a) => a.type === "asset");
    return account ? charts.accountBalanceHistory(l, account.id, ym(2026, 1), ym(2026, 6)) : null;
  },
  tagChart: (l) => {
    const tag = tags.allTags(l)[0];
    return tag === undefined ? null : charts.tagChart(l, tag);
  },
  cardBillsHistory: (l) => {
    const card = [...l.cards.keys()][0];
    return card === undefined ? null : charts.cardBillsHistory(l, card, [ym(2026, 1), ym(2026, 2)]);
  },
  loanChart: (l) => {
    const plan = first(l, "loan_plan");
    return plan === undefined ? null : charts.loanChart(l, plan, "2026-03-31" as IsoDate);
  },
  goalChart: (l) => {
    const goal = first(l, "goal");
    return goal === undefined ? null : charts.goalChart(l, goal, ym(2026, 6), "2026-03-31" as IsoDate);
  },
  investmentEvolution: (l) => {
    const position = first(l, "position");
    return position === undefined ? null : charts.investmentEvolution(l, position);
  },
  investmentResult: (l) => {
    const position = first(l, "position");
    return position === undefined ? null : charts.investmentResult(l, position);
  },
  returnsChart: (l) => {
    const position = first(l, "position");
    return position === undefined
      ? null
      : charts.returnsChart(l, position, "2026-01-02" as IsoDate, "2026-03-31" as IsoDate);
  },
};

function check(name: string, chart: charts.Chart): void {
  expect(chart.title && ["BRL", "%"].includes(chart.unit), name).toBeTruthy();
  for (const series of chart.series) {
    for (const p of series.points) expect(p.y === null || p.y instanceof Dec, `${name}: ${series.name}`).toBe(true);
  }
  const [headers, rows] = charts.tableRows(chart);
  expect(headers).toEqual(chart.series.map((s) => s.name));
  const data = rows.filter((r) => r.x !== null);
  const xs = new Set(chart.series.flatMap((s) => s.points.map((p) => `${p.isDate ? "d" : "s"}${p.x}`)));
  expect(data.length, `${name}: one row per x`).toBe(xs.size);
  const total = rows.find((r) => r.label === "Total");
  if (total === undefined) return;
  chart.series.forEach((series, column) => {
    const known = data.map((r) => r.values[column]).filter((v): v is Dec => v !== null && v !== undefined);
    if (charts.addsUp(series) && known.length) {
      expect(total.values[column]!.eq(Dec.sum(known, ZERO)), `${name}: ${series.name}`).toBe(true);
    } else {
      expect(total.values[column], `${name}: ${series.name} is a position, no total`).toBeNull();
    }
  });
}

describe("every chart", () => {
  it("is covered here: a new builder must be added to BUILDERS", () => {
    const exported = Object.entries(charts)
      .filter(([name, value]) => typeof value === "function" && !HELPERS.has(name))
      .map(([name]) => name);
    expect(exported.filter((name) => !(name in BUILDERS))).toEqual([]);
  });

  const data = golden<{ scenarios: { name: string; records: LedgerRecord[] }[] }>("reports");

  it.each(data.scenarios.map((s) => [s.name, s] as const))("builds and its table agrees: %s", (_name, scenario) => {
    const ledger = Ledger.fromRecords(scenario.records);
    let built = 0;
    for (const [name, build] of Object.entries(BUILDERS)) {
      const chart = build(ledger);
      if (chart === null) continue;
      check(name, chart);
      built += 1;
    }
    expect(built).toBeGreaterThanOrEqual(15);
  });

  it("builds on an empty project", () => {
    const ledger = Ledger.new("Vazio");
    for (const [name, build] of Object.entries(BUILDERS)) {
      const chart = build(ledger);
      if (chart !== null) check(name, chart);
    }
  });

  it("months between two months, and none when reversed", () => {
    expect(charts.monthsBetween(ym(2025, 11), ym(2026, 2)).map((m) => `${m.year}-${m.month}`)).toEqual([
      "2025-11",
      "2025-12",
      "2026-1",
      "2026-2",
    ]);
    expect(charts.monthsBetween(ymParse("2026-03"), ymParse("2026-01"))).toEqual([]);
    expect(charts.monthName(ym(2026, 3))).toBe("mar/2026");
  });
});
