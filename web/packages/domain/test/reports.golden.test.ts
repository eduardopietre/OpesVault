/**
 * Parity of alerts, agenda, year-end summary, tax issues, chart data and exports with the desktop
 * (golden/reports.json, scripts/golden/cases_reports.py): the TS side loads each ledger's records and
 * runs the same calls; every result is compared as JSON (decimals as text, no tolerance) and the
 * exports byte by byte (SHA-256 of the exact bytes, and the full text when it is small).
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import * as charts from "../src/charts/data/index.ts";
import * as agenda from "../src/domain/agenda.ts";
import * as alerts from "../src/domain/alerts.ts";
import * as annual from "../src/domain/annual.ts";
import { Ledger, type LedgerRecord } from "../src/domain/ledger.ts";
import {
  KIND_ORDER,
  interchangeJson,
  ledgerCsv,
  monthlyReportHtml,
  annualReportHtml,
  taxReportHtml,
} from "../src/exports.ts";
import { type IsoDate, ymParse } from "../src/lib/dates.ts";
import { head } from "../src/lib/py.ts";
import * as issues from "../src/tax/issues.ts";
import { golden, j, outcome } from "./golden.ts";
import { py } from "./pyjson.ts";

interface Call {
  fn: string;
  args: Record<string, unknown>;
  ok?: unknown;
  error?: string;
}

interface Scenario {
  name: string;
  records: LedgerRecord[];
  calls: Call[];
}

const data = golden<{ exported_at: string; kind_order: string[]; scenarios: Scenario[] }>("reports");

const dt = (v: unknown) => v as IsoDate;
const ym = (v: unknown) => ymParse(v as string);
const id = (v: unknown) => (v ? (v as string) : null);
const ids = (v: unknown) => (v === null ? null : (v as string[]));

function blob(input: Uint8Array | string): unknown {
  const raw = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(raw);
  return {
    sha256: createHash("sha256").update(raw).digest("hex"),
    length: raw.length,
    text: raw.length <= 30_000 ? text : null,
    head: head(text, 300),
  };
}

function dumpChart(c: charts.Chart): unknown {
  return {
    title: c.title,
    unit: c.unit,
    notes: c.notes,
    regime: c.regime,
    series: c.series.map((s) => ({
      name: s.name,
      style: s.style,
      marker_points: s.markerPoints,
      hidden: s.hidden,
      summable: s.summable,
      adds_up: charts.addsUp(s),
      axis: s.axis,
      points: s.points.map((p) => ({ x: p.x, is_date: p.isDate, y: j(p.y), info: p.info })),
    })),
  };
}

function chartAndTable(c: charts.Chart): unknown {
  const [headers, rows] = charts.tableRows(c);
  return {
    chart: dumpChart(c),
    headers,
    rows: rows.map((r) => ({ x: r.x, is_date: r.isDate, label: r.label, values: r.values.map(j) })),
  };
}

type Run = (ledger: Ledger, a: Record<string, unknown>) => unknown;

const RUN: Record<string, Run> = {
  // alerts
  alerts: (l, a) => py(alerts.alerts(l, dt(a["today"]), a["horizon"] as number)),
  card_alerts: (l, a) => py(alerts.cardAlerts(l, dt(a["today"]), a["horizon"] as number)),
  recurrence_alerts: (l, a) => py(alerts.recurrenceAlerts(l, dt(a["today"]), a["horizon"] as number)),
  loan_alerts: (l, a) => py(alerts.loanAlerts(l, dt(a["today"]), a["horizon"] as number)),
  maturity_alerts: (l, a) => py(alerts.maturityAlerts(l, dt(a["today"]), a["horizon"] as number)),
  tax_alerts: (l, a) => py(alerts.taxAlerts(l, dt(a["today"]), a["horizon"] as number)),
  projection_alerts: (l, a) => py(alerts.projectionAlerts(l, dt(a["today"]))),
  budget_alerts: (l, a) => py(alerts.budgetAlerts(l, dt(a["today"]))),
  suspicion_alerts: (l, a) => py(alerts.suspicionAlerts(l, dt(a["today"]))),
  import_alerts: (l) => py(alerts.importAlerts(l)),
  balance_check_alerts: (l) => py(alerts.balanceCheckAlerts(l)),
  price_alerts: (l) => py(alerts.priceAlerts(l)),
  backup_alert: (_l, a) =>
    py(alerts.backupAlert(a["last_backup"] ? dt(a["last_backup"]) : null, dt(a["today"]), a["configured"] as boolean)),
  // agenda
  agenda_events: (l, a) => py(agenda.events(l, dt(a["start"]), dt(a["end"]), dt(a["today"]))),
  month_events: (l, a) => py(agenda.monthEvents(l, ym(a["month"]), dt(a["today"]))),
  by_day: (l, a) => py(agenda.byDay(agenda.monthEvents(l, ym(a["month"]), dt(a["today"])))),
  // annual
  annual: (l, a) => {
    const summary = annual.annual(l, a["year"] as number);
    return { ...(py(summary) as object), net_worth: j(summary.netWorth) };
  },
  // tax issues
  issues: (l, a) => py(issues.issues(l, a["year"] as number, id(a["declarant"]), dt(a["today"]))),
  reminders: (l, a) => py(issues.reminders(l, dt(a["today"]), a["horizon"] as number)),
  engaged: (l) => issues.engaged(l),
  // charts
  monthly_in_out: (l, a) => chartAndTable(charts.monthlyInOut(l, ym(a["start"]), ym(a["end"]), ids(a["accounts"]))),
  monthly_result: (l, a) => chartAndTable(charts.monthlyResult(l, ym(a["start"]), ym(a["end"]), id(a["member"]))),
  cash_flow_balance: (l, a) =>
    chartAndTable(charts.cashFlowBalance(l, ym(a["start"]), ym(a["end"]), ids(a["accounts"]))),
  monthly_summary: (l, a) => chartAndTable(charts.monthlySummary(l, ym(a["start"]), ym(a["end"]))),
  projected_balance: (l, a) => chartAndTable(charts.projectedBalance(l, dt(a["today"]), a["days"] as number)),
  commitments_projection: (l, a) =>
    chartAndTable(charts.commitmentsProjection(l, ym(a["start"]), a["months"] as number)),
  annual_chart: (l, a) => chartAndTable(charts.annualChart(l, a["year"] as number)),
  expenses_by_category: (l, a) => chartAndTable(charts.expensesByCategory(l, ym(a["start"]), ym(a["end"]))),
  category_monthly: (l, a) =>
    chartAndTable(charts.categoryMonthly(l, a["category"] as string, ym(a["start"]), ym(a["end"]))),
  category_comparison_chart: (l, a) =>
    chartAndTable(charts.categoryComparisonChart(l, ym(a["month"]), a["window"] as number)),
  budget_history: (l, a) => chartAndTable(charts.budgetHistory(l, ym(a["start"]), ym(a["end"]), id(a["category"]))),
  tag_chart: (l, a) => chartAndTable(charts.tagChart(l, a["tag"] as string)),
  tags_overview: (l) => chartAndTable(charts.tagsOverview(l)),
  merchants_chart: (l, a) => chartAndTable(charts.merchantsChart(l, dt(a["start"]), dt(a["end"]), a["top"] as number)),
  net_worth_series: (l, a) => chartAndTable(charts.netWorthSeries(l, ym(a["start"]), ym(a["end"]))),
  account_balance_history: (l, a) =>
    chartAndTable(charts.accountBalanceHistory(l, a["account"] as string, ym(a["start"]), ym(a["end"]))),
  card_bills_history: (l, a) =>
    chartAndTable(charts.cardBillsHistory(l, a["card"] as string, (a["months"] as string[]).map(ym))),
  loan_chart: (l, a) => chartAndTable(charts.loanChart(l, a["plan"] as string, dt(a["today"]))),
  goal_chart: (l, a) =>
    chartAndTable(charts.goalChart(l, a["goal"] as string, ym(a["end"]), dt(a["today"]), a["months"] as number)),
  investment_evolution: (l, a) => chartAndTable(charts.investmentEvolution(l, a["position"] as string)),
  investment_result: (l, a) => chartAndTable(charts.investmentResult(l, a["position"] as string)),
  portfolio_composition: (l, a) => chartAndTable(charts.portfolioComposition(l, dt(a["at"]))),
  returns_chart: (l, a) => chartAndTable(charts.returnsChart(l, a["position"] as string, dt(a["start"]), dt(a["end"]))),
  // exports
  ledger_csv: (l) => blob(ledgerCsv(l)),
  interchange_json: (l) => blob(interchangeJson(l, data.exported_at)),
  monthly_report_html: (l, a) => blob(monthlyReportHtml(l, ym(a["month"]), dt(a["today"]), id(a["member"]))),
  annual_report_html: (l, a) => blob(annualReportHtml(l, a["year"] as number)),
  tax_report_html: (l, a) => blob(taxReportHtml(l, a["year"] as number, dt(a["today"]), id(a["declarant"]))),
};

describe("reports golden", () => {
  it("lists the kinds in the order of the desktop", () => {
    // `attachment`, `benchmark` are the desktop's and not yet kinds of the web domain
    expect([...KIND_ORDER]).toEqual(data.kind_order);
    const known = [...Ledger.kinds().keys()];
    expect(known.filter((k) => !KIND_ORDER.includes(k))).toEqual([]);
  });

  it("runs every function the golden calls", () => {
    const wanted = new Set(data.scenarios.flatMap((s) => s.calls.map((c) => c.fn)));
    expect([...wanted].filter((fn) => !(fn in RUN))).toEqual([]);
  });

  describe.each(data.scenarios)("$name", (scenario) => {
    it("recomputes every call", { timeout: 120_000 }, () => {
      const ledger = Ledger.fromRecords(scenario.records);
      const wrong: string[] = [];
      for (const [index, call] of scenario.calls.entries()) {
        const run = RUN[call.fn]!;
        const got = outcome(() => run(ledger, call.args)) as { ok?: unknown; error?: string };
        const want = call.error !== undefined ? { error: call.error } : { ok: call.ok };
        try {
          expect(got).toEqual(want);
        } catch (error) {
          wrong.push(`#${index} ${call.fn} ${JSON.stringify(call.args)}`);
          if (wrong.length === 1) throw error;
        }
      }
      expect(wrong).toEqual([]);
    });
  });
});
