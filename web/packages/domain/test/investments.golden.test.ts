/**
 * Parity with scripts/golden/cases_investments.py: docs/06 examples A-F and seeded portfolios,
 * replayed from the same records and commands; every query compared as JSON, decimals as text.
 */
import { describe, expect, it } from "vitest";

import { DomainError, Ledger, type LedgerRecord } from "../src/domain/ledger.ts";
import * as queries from "../src/domain/queries.ts";
import { addDays, type IsoDate } from "../src/lib/dates.ts";
import { Dec } from "../src/lib/dec.ts";
import type { Id } from "../src/lib/ids.ts";
import { sortedBy } from "../src/lib/text.ts";
import { realizedGain, type TaxRule, ValueNature as Nature } from "../src/investments/model.ts";
import * as performance from "../src/investments/performance.ts";
import * as returns from "../src/investments/returns.ts";
import * as service from "../src/investments/service.ts";
import * as simulation from "../src/investments/simulation.ts";
import * as trades from "../src/investments/trades.ts";
import { golden, j, outcome } from "./golden.ts";
import { INVESTMENT_COMMANDS, RULES } from "./investment_commands.ts";
import { dumpOrNull, knownIds, norm, runCommands, type Scenario } from "./w5_golden.ts";

interface File {
  rules: unknown[];
  brackets: unknown[];
  xirr: { flows: [string, { $dec: string }][]; rate: unknown; reason: string }[];
  scenarios: Scenario[];
}

const data = golden<File>("investments");

function observed(o: performance.Observed | null, known: ReadonlySet<string>): unknown {
  return o === null ? null : { valuation: norm(dumpOrNull(o.valuation), known), age_days: o.age_days };
}

function probesOf(ledger: Ledger, positionId: Id): IsoDate[] {
  const pos = service.positions(ledger).get(positionId)!;
  const dates = new Set<IsoDate>([pos.opened_on]);
  for (const v of service.valuationsOf(ledger, positionId)) dates.add(v.on);
  for (const e of service.eventsOf(ledger, positionId)) dates.add(e.on);
  return [...dates].sort().slice(0, 10);
}

function windowsOf(probes: IsoDate[]): [IsoDate, IsoDate][] {
  const out: [IsoDate, IsoDate][] = [];
  for (let i = 0; i + 1 < probes.length; i++) out.push([probes[i]!, probes[i + 1]!]);
  if (probes.length > 2) {
    out.push([probes[0]!, probes[probes.length - 1]!]);
    out.push([probes[0]!, probes[Math.floor(probes.length / 2)]!]);
  }
  if (probes.length) out.push([probes[0]!, probes[0]!]);
  return out.slice(0, 10);
}

function sim(
  ledger: Ledger,
  positionId: Id,
  on: IsoDate,
  gross: string,
  rule: TaxRule,
  options: simulation.SimulateOptions,
): unknown {
  try {
    return { ok: j(simulation.simulate(ledger, positionId, on, gross, rule, options)) };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { error: error.message };
  }
}

function positionSnapshot(ledger: Ledger, positionId: Id, known: ReadonlySet<string>): unknown {
  const pos = service.positions(ledger).get(positionId)!;
  const probes = probesOf(ledger, positionId);
  const after = probes.slice(-1).map((p) => addDays(p, 50));
  const h = trades.holding(ledger, positionId);
  const out: Record<string, unknown> = {
    position: norm(dumpOrNull(pos), known),
    asset: norm(dumpOrNull(service.assets(ledger).get(pos.asset_id)), known),
    probes,
    remaining_cost: j(service.remainingCost(ledger, positionId)),
    remaining_cost_at: probes.map((p) => j(service.remainingCost(ledger, positionId, p))),
    valuations: service.valuationsOf(ledger, positionId).map((v) => norm(dumpOrNull(v), known)),
    selected: performance.selectedSeries(ledger, positionId).map((v) => norm(v.id, known)),
    events: service.eventsOf(ledger, positionId).map((e) => ({
      event: norm(dumpOrNull(e), known),
      realized_gain: j(realizedGain(e)),
    })),
    lots: trades.lotsOf(ledger, positionId).map((lot) => norm(dumpOrNull(lot), known)),
    open_lots: trades.lotsOf(ledger, positionId, true).length,
    holding: { quantity: j(h.quantity), cost: j(h.cost), average_price: j(trades.averagePrice(h)) },
    quantity_on: probes.map((p) => j(trades.quantityOn(ledger, positionId, p))),
    value_at: [...probes, ...after].map((p) => ({
      any: observed(performance.valueAt(ledger, positionId, p), known),
      gross: observed(performance.valueAt(ledger, positionId, p, Nature.GROSS), known),
    })),
    unrealized: [...probes, ...after].map((p) => j(performance.unrealized(ledger, positionId, p))),
    realized: [...probes, null].map((p) => j(performance.realized(ledger, positionId, p))),
  };
  out["windows"] = windowsOf(probes).map(([a, b]) => ({
    start: a,
    end: b,
    flows: performance
      .externalFlows(ledger, positionId, a, b)
      .map((f) => ({ on: f.on, amount: j(f.amount), kind: f.kind, quality: f.event.quality })),
    period_result: j(performance.periodResult(ledger, positionId, a, b)),
    simple_return: j(performance.simpleReturn(ledger, positionId, a, b)),
    simple_return_no_dist: j(performance.simpleReturn(ledger, positionId, a, b, false)),
    all_methods: returns.allMethods(ledger, positionId, a, b).map((r) => j(r)),
  }));
  const sims: unknown[] = [];
  for (const p of [...probes.slice(-1), ...after]) {
    for (const gross of ["2500.50", "999999.99"]) {
      sims.push({
        on: p,
        gross,
        proportional_cost: outcome(() => service.proportionalCost(ledger, positionId, Dec.from(gross), p)),
      });
      for (const rule of RULES) {
        sims.push({
          on: p,
          gross,
          rule: rule.id,
          plain: sim(ledger, positionId, p, gross, rule, {}),
          informed: sim(ledger, positionId, p, gross, rule, {
            fees: "12.34",
            cost_attributed: "800.00",
            current_value: "3000",
          }),
          base: sim(ledger, positionId, p, gross, rule, { informed_base: "400.10" }),
        });
      }
    }
  }
  out["simulations"] = sims;
  return out;
}

function snapshot(ledger: Ledger, known: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    accounts: [...ledger.accounts.values()].map((a) => [a.name, j(queries.balance(ledger, a.id))]),
    operations: [...ledger.operations.values()].map((op) => {
      const payload = norm(dumpOrNull(op), known) as Record<string, unknown>;
      delete payload["id"];
      return payload;
    }),
    row_counts: ledger.rowCounts(),
    positions: [...service.positions(ledger).keys()].map((pid) => positionSnapshot(ledger, pid, known)),
  };
  const days = sortedBy(
    new Set([...service.positions(ledger).keys()].flatMap((pid) => probesOf(ledger, pid))),
    (d) => d,
  );
  const step = Math.max(1, Math.floor(days.length / 6));
  out["composition"] = days
    .filter((_, i) => i % step === 0)
    .map((day) => {
      const c = performance.composition(ledger, day);
      return {
        at: c.at,
        lines: norm(j(c.lines), known),
        total: j(performance.compositionTotal(c)),
        partial: performance.compositionPartial(c),
      };
    });
  return out;
}

describe("investments golden", () => {
  // XIRR samples 610 brackets with ln/exp at 40 digits: about half a second per call in decimal.js.
  it("XIRR brackets and direct cases", { timeout: 120_000 }, () => {
    expect(returns.XIRR_BRACKETS.map((b) => j(b))).toEqual(data.brackets);
    for (const c of data.xirr) {
      const flows = c.flows.map(([d, a]) => [d as IsoDate, Dec.from(a.$dec)] as const);
      const [rate, reason] = returns.xirrFromFlows(flows);
      expect({ rate: j(rate), reason }, JSON.stringify(c.flows)).toEqual({ rate: c.rate, reason: c.reason });
    }
  });

  describe.each(data.scenarios)("$name", (scenario) => {
    it("replays the commands and gives the same snapshot", { timeout: 120_000 }, () => {
      const records = scenario.records as LedgerRecord[];
      const ledger = Ledger.fromRecords(records);
      const known = knownIds(records);
      const results = runCommands(ledger, scenario.commands, scenario.names, INVESTMENT_COMMANDS, known);
      expect(results).toEqual(scenario.results);
      const snap = snapshot(ledger, known);
      const expected = scenario.snapshot as Record<string, unknown>;
      for (const key of Object.keys(expected)) expect(snap[key], key).toEqual(expected[key]);
    });
  });
});
