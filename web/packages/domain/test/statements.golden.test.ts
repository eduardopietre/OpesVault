/**
 * Parity with scripts/golden/cases_statements.py: reading an informe de rendimentos (lines, PDF
 * and CSV bytes, seeded mutations of the text) and checking saved informes against the records.
 */
import { describe, expect, it } from "vitest";

import { Ledger, type LedgerRecord } from "../src/domain/ledger.ts";
import { dump } from "../src/domain/model.ts";
import { j, golden } from "./golden.ts";
import { positions } from "../src/investments/service.ts";
import type { Id } from "../src/lib/ids.ts";
import {
  type IncomeKind,
  type IncomeNature,
  type NatureSubject,
  ReportLineSchema,
  ReportSource,
} from "../src/tax/model.ts";
import * as records from "../src/tax/records.ts";
import * as statements from "../src/tax/statements.ts";
import { bytesOf, extractor } from "./importing_helpers.ts";
import { INVESTMENT_COMMANDS } from "./investment_commands.ts";
import { asDate, type CommandTable, knownIds, norm, runCommands, type Scenario } from "./w5_golden.ts";

type Parsed = { year: unknown; payer_tax_id: unknown; payer_name: unknown; lines: unknown[]; skipped: string[] };
interface File {
  parse: { name: string; lines: string[]; result: Parsed }[];
  read: { name: string; bytes: string; result: { ok?: Parsed; error?: string } }[];
  scenarios: Scenario<{ reports: unknown[] }>[];
}
const data = golden<File>("statements");
const s = (v: unknown) => v as string;
const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

function parsedJson(p: statements.ParsedReport): Parsed {
  return {
    year: p.year,
    payer_tax_id: p.payerTaxId,
    payer_name: p.payerName,
    lines: p.lines.map((l) => dump(l)),
    skipped: [...p.skipped],
  };
}

const COMMANDS: CommandTable = {
  ...INVESTMENT_COMMANDS,
  income: (l, [acc, cat, amount, on, desc, member]) =>
    l.recordIncome(s(acc), s(cat), amount, asDate(on), s(desc), { member_id: orNull(member) as Id | null }),
  opening: (l, [acc, amount, on]) => l.recordOpeningBalance(s(acc), amount, asDate(on)),
  classify: (l, [subject, ref, nature]) =>
    records.classify(l, subject as NatureSubject, s(ref), (nature as IncomeNature | null) || null),
  set_income_detail: (l, [op, kind, gross, withheld, ss]) =>
    records.setIncomeDetail(l, s(op), kind as IncomeKind, orNull(gross), orNull(withheld), orNull(ss)),
  save_report: (l, [year, source, sourceId, lines], o) =>
    records.saveReport(
      l,
      year as number,
      source as ReportSource,
      s(sourceId),
      (lines as unknown[]).map((x) => ReportLineSchema.parse(x)),
      o as records.SaveReportOptions,
    ),
  cancel: (l, [op, reason]) => l.cancelOperation(s(op), s(reason)),
  report_on_position_account: (l, [year, pos, lines]) =>
    records.saveReport(
      l,
      year as number,
      ReportSource.ACCOUNT,
      positions(l).get(s(pos))!.account_id,
      (lines as unknown[]).map((x) => ReportLineSchema.parse(x)),
    ),
};

function snapshot(ledger: Ledger, known: ReadonlySet<string>): unknown {
  return {
    reports: [...records.reports(ledger).values()].map((report) => ({
      report: norm(dump(report), known),
      totals: Object.fromEntries([...statements.totals(report)].map(([k, v]) => [k, j(v)])),
      recorded: Object.fromEntries([...statements.recorded(ledger, report)].map(([k, v]) => [k, j(v)])),
      checks: statements.check(ledger, report).map((c) => ({
        field: c.field,
        informed: j(c.informed),
        recorded: j(c.recorded),
        note: c.note,
        difference: j(statements.difference(c)),
        matches: statements.matches(c),
      })),
      differences: statements.differences(ledger, report).map((c) => c.field),
    })),
  };
}

describe("informe reader", () => {
  it.each(data.parse)("parses $name", (c) => {
    expect(parsedJson(statements.parse(c.lines))).toEqual(c.result);
  });

  it.each(data.read)("reads $name", async (c) => {
    try {
      const parsed = await statements.read(bytesOf(c.bytes), extractor);
      expect(c.result.error).toBeUndefined();
      expect(parsedJson(parsed)).toEqual(c.result.ok);
    } catch (error) {
      if (c.result.error === undefined) throw error;
      expect((error as Error).name).toBe(c.result.error);
    }
  });
});

describe("informes checked against the records", () => {
  it.each(data.scenarios)("$name", (scenario) => {
    const recordsIn = scenario.records as LedgerRecord[];
    const ledger = Ledger.fromRecords(recordsIn);
    const known = knownIds(recordsIn);
    expect(runCommands(ledger, scenario.commands, scenario.names, COMMANDS, known)).toEqual(scenario.results);
    expect(snapshot(ledger, known)).toEqual(scenario.snapshot);
  });
});
