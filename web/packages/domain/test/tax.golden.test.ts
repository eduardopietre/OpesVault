/**
 * Parity with scripts/golden/cases_tax.py: the income tax sheets, the checklist, the
 * simplified/itemized simulation, renda variável, bank accounts and investment characteristics,
 * replayed from the same records and commands and compared as JSON (decimals as text).
 */
import { describe, expect, it } from "vitest";

import { investmentCodes } from "../src/catalogs/irpf.ts";
import * as banking from "../src/domain/banking.ts";
import { DomainError, Ledger, type LedgerRecord } from "../src/domain/ledger.ts";
import { AccountType } from "../src/domain/model.ts";
import * as queries from "../src/domain/queries.ts";
import { type IsoDate, makeDate, ymStr } from "../src/lib/dates.ts";
import { Dec } from "../src/lib/dec.ts";
import type { Id } from "../src/lib/ids.ts";
import * as prof from "../src/investments/profile.ts";
import { getOrKeyError, positions } from "../src/investments/service.ts";
import * as checklist from "../src/tax/checklist.ts";
import * as declaration from "../src/tax/declaration.ts";
import {
  BucketRuleSchema,
  DeclaredAssetSchema,
  type FilingSubject,
  type IncomeKind,
  type IncomeNature,
  NatureSubject,
  PaymentPurpose,
  type PaymentPurpose as Purpose,
  ReportLineSchema,
  type ReportSource,
  TaxParametersSchema,
  type TaxSubject,
} from "../src/tax/model.ts";
import * as records from "../src/tax/records.ts";
import * as simulation from "../src/tax/simulation.ts";
import * as variableIncome from "../src/tax/variable_income.ts";
import { golden, j } from "./golden.ts";
import { INVESTMENT_COMMANDS } from "./investment_commands.ts";
import { asDate, type CommandTable, dumpOrNull, knownIds, norm, runCommands, type Scenario } from "./w5_golden.ts";

interface File {
  investment_codes: string[][];
  scenarios: Scenario[];
}

const data = golden<File>("tax");
const Y = 2025;
const TODAY = "2026-10-05" as IsoDate;

type O = Record<string, unknown>;
const s = (v: unknown) => v as string;
const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

const TAX_COMMANDS: CommandTable = {
  ...INVESTMENT_COMMANDS,
  member: (l, [name]) => l.addMember(s(name)),
  income: (l, [acc, cat, amount, on, desc, member]) =>
    l.recordIncome(s(acc), s(cat), amount, asDate(on), s(desc), { member_id: orNull(member) as Id | null }),
  expense: (l, [acc, cat, amount, on, desc, member]) =>
    l.recordExpense(s(acc), s(cat), amount, asDate(on), s(desc), { member_id: orNull(member) as Id | null }),
  opening: (l, [acc, amount, on]) => l.recordOpeningBalance(s(acc), amount, asDate(on)),
  classify: (l, [subject, ref, nature]) =>
    records.classify(l, subject as NatureSubject, s(ref), (nature as IncomeNature | null) || null),
  set_identity: (l, [subject, ref, taxId, name]) =>
    records.setIdentity(l, subject as TaxSubject, s(ref), s(taxId), orNull(name) as string | null),
  clear_identity: (l, [subject, ref]) => records.clearIdentity(l, subject as TaxSubject, s(ref)),
  set_member_info: (l, [member, cpf, birth, declaredBy, relation]) =>
    records.setMemberInfo(
      l,
      s(member),
      {
        cpf: orNull(cpf) as string | null,
        birth_date: (orNull(birth) as IsoDate | null) || null,
        declared_by: orNull(declaredBy) as Id | null,
        relation: orNull(relation) as string | null,
      },
      TODAY,
    ),
  set_income_detail: (l, [op, kind, gross, withheld, ss]) =>
    records.setIncomeDetail(l, s(op), kind as IncomeKind, orNull(gross), orNull(withheld), orNull(ss)),
  set_filing: (l, [subject, ref, group, code, text]) =>
    records.setFiling(l, subject as FilingSubject, s(ref), s(group), s(code), s(text)),
  save_declared_asset: (l, [fields, reason]) =>
    records.saveDeclaredAsset(l, DeclaredAssetSchema.parse(fields), orNull(reason) as string | null),
  update_declared_asset: (l, [assetId, changes, reason]) => {
    const current = getOrKeyError(records.declaredAssets(l), s(assetId));
    const update: O = { ...(changes as O) };
    for (const key of ["cost", "sale_value"]) {
      if (typeof update[key] === "string") update[key] = Dec.from(update[key]);
    }
    return records.saveDeclaredAsset(l, { ...current, ...update }, orNull(reason) as string | null);
  },
  remove_declared_asset: (l, [assetId]) => records.removeDeclaredAsset(l, s(assetId)),
  save_report: (l, [year, source, sourceId, lines], o) =>
    records.saveReport(
      l,
      year as number,
      source as ReportSource,
      s(sourceId),
      (lines as unknown[]).map((x) => ReportLineSchema.parse(x)),
      o as records.SaveReportOptions,
    ),
  remove_report: (l, [reportId]) => records.removeReport(l, s(reportId)),
  set_parameters: (l, [fields]) => records.setParameters(l, TaxParametersSchema.parse(fields)),
  set_variable_rules: (l, [validFrom, rules, source]) =>
    records.setVariableRules(
      l,
      asDate(validFrom),
      (rules as unknown[]).map((r) => BucketRuleSchema.parse(r)),
      s(source),
    ),
  record_payment: (l, [purpose, month, amount, on, src, member]) =>
    records.recordPayment(
      l,
      purpose as Purpose,
      month as { year: number; month: number },
      amount,
      asDate(on),
      s(src),
      orNull(member) as Id | null,
    ),
  set_mark: (l, [year, key, received, note]) =>
    records.setMark(l, year as number, s(key), received as boolean | null, orNull(note) as string | null),
  bank_create: (l, [fields, checking, savings, opening]) => {
    const item = banking.build(fields as unknown as banking.BuildFields);
    const parts = new Map(
      Object.entries(opening as Record<string, [string, string]>).map(
        ([part, [value, on]]) => [part as banking.Part, [Dec.from(value), asDate(on)] as const] as const,
      ),
    );
    return banking.create(l, item, {
      checking: checking as boolean | Id,
      savings: savings as boolean | Id,
      opening: parts,
    });
  },
  bank_update: (l, [bankId, changes, add]) => {
    const current = banking.bankAccounts(l).get(s(bankId));
    if (current === undefined) throw new DomainError("Conta bancária inexistente.");
    return banking.update(l, { ...current, ...(changes as O) }, add as banking.Part[]);
  },
  bank_archive: (l, [bankId]) => banking.archive(l, s(bankId)),
  adjust_balance: (l, [acc, on, value]) => banking.adjustBalance(l, s(acc), asDate(on), Dec.from(s(value))),
  record_values: (l, [bankId, on, values], o) =>
    banking.recordValues(l, s(bankId), asDate(on), new Map(values as [Id, unknown][]), TODAY, {
      adjust: new Set((o["adjust"] as Id[] | undefined) ?? []),
      note: orNull(o["note"]) as string | null,
    }),
  save_profile: (l, [fields]) => prof.saveProfile(l, prof.InvestmentProfileSchema.parse(fields)),
};

function sortedPeople(people: ReadonlySet<Id> | null): unknown {
  return people === null ? null : [...people].sort();
}

function yearSheets(ledger: Ledger, year: number, declarant: Id | null, known: ReadonlySet<string>): unknown {
  const people = records.peopleOf(ledger, declarant);
  const income = declaration.income(ledger, year, people);
  const comparison = simulation.compare(ledger, year, declarant);
  const rows = variableIncome.months(ledger, year, people);
  const bestModel = simulation.best(comparison);
  return {
    year,
    declarant,
    people: sortedPeople(people),
    income: norm(j(income), known),
    unclassified: declaration.unclassified(income).length,
    assets: norm(
      declaration.assets(ledger, year, people).map((r) => ({ ...(j(r) as O), group_label: declaration.groupLabel(r) })),
      known,
    ),
    debts: norm(j(declaration.debts(ledger, year, people)), known),
    payments: norm(j(declaration.payments(ledger, year, people)), known),
    dependents: norm(j(declaration.dependents(ledger, declarant)), known),
    checklist: norm(j(checklist.expected(ledger, year, people)), known),
    missing: checklist.missing(checklist.expected(ledger, year, people)).length,
    comparison: {
      ...(norm(j(comparison), known) as O),
      best: bestModel ? bestModel.name : null,
      balance_simplified: j(simulation.balanceOf(comparison, comparison.simplified)),
      balance_itemized: j(simulation.balanceOf(comparison, comparison.itemized)),
    },
    carne_leao_paid: j(simulation.carneLeaoPaid(ledger, year)),
    trades: norm(j(variableIncome.trades(ledger, people)), known),
    months: norm(
      rows.map((r) => ({ ...(j(r) as O), missing_rate: variableIncome.missingRate(r) })),
      known,
    ),
    carried_loss: j(variableIncome.carriedLoss(ledger, year, people)),
    exempt_total: j(variableIncome.exemptTotal(rows)),
    due_by_month: [...variableIncome.dueByMonth(rows).values()].map((v) => [
      ymStr(v.month),
      j(v.due),
      j(v.paid),
      v.due_date,
    ]),
  };
}

const KINDS = [
  "tax_identity",
  "member_tax_info",
  "income_classification",
  "income_detail",
  "asset_filing",
  "declared_asset",
  "income_report",
  "tax_parameters",
  "variable_income_rules",
  "tax_payment",
  "tax_checklist_mark",
  "bank_account",
  "investment_profile",
];

function snapshot(ledger: Ledger, known: ReadonlySet<string>): O {
  const out: O = {
    accounts: [...ledger.accounts.values()].map((a) => [a.name, j(queries.balance(ledger, a.id))]),
    account_payloads: [...ledger.accounts.values()].map((a) => norm(dumpOrNull(a), known)),
    operations: [...ledger.operations.values()].map((op) => {
      const payload = norm(dumpOrNull(op), known) as O;
      delete payload["id"];
      return payload;
    }),
    row_counts: ledger.rowCounts(),
  };
  for (const kind of KINDS) out[kind] = [...ledger.entities(kind).values()].map((e) => norm(dumpOrNull(e), known));
  out["declarants"] = norm(records.declarants(ledger), known);
  const natures: unknown[] = [];
  for (const account of ledger.accounts.values()) {
    if (account.type === AccountType.INCOME) {
      natures.push([account.name, records.natureOf(ledger, NatureSubject.CATEGORY, account.id)]);
    }
  }
  for (const pos of positions(ledger).values()) {
    const profile = prof.profileOf(ledger, pos.id);
    natures.push([
      norm(pos.id, known),
      records.natureOf(ledger, NatureSubject.POSITION, pos.id),
      records.incomeCodeOf(ledger, pos.id),
      prof.yieldText(profile),
      prof.description(ledger, pos.id),
      prof.incomeCodeLabel(profile ? profile.income_code : null),
    ]);
  }
  out["natures"] = natures;
  out["reports_of"] = Object.fromEntries(
    [Y - 1, Y, Y + 1].map((y) => [String(y), norm(records.reportsOf(ledger, y).map(dumpOrNull), known)]),
  );
  out["variable_rules"] = [null, "1999-01-01", "2024-06-30", `${Y}-03-31`, `${Y}-12-31`].map((d) =>
    norm(dumpOrNull(records.variableRules(ledger, d as IsoDate | null)), known),
  );
  const members = [...ledger.members.keys()];
  const paid: unknown[] = [];
  for (const purpose of Object.values(PaymentPurpose)) {
    for (const m of [3, 4, 8]) {
      for (const member of [null, ...members.slice(0, 2)]) {
        paid.push(j(records.paid(ledger, purpose, { year: Y, month: m }, member)));
      }
    }
  }
  out["paid"] = paid;
  out["banks"] = [...banking.bankAccounts(ledger).values()].map((item) => {
    const onDates = [makeDate(Y, 1, 1), makeDate(Y, 6, 30), makeDate(Y, 12, 31)];
    return {
      id: norm(item.id, known),
      where: banking.where(item),
      holders: norm(banking.holders(item), known),
      joint: banking.joint(item),
      components: norm(banking.components(item), known),
      positions: norm(banking.positionsOf(ledger, item.id), known),
      values: onDates.map((on) => norm(j(banking.valuesAt(ledger, item.id, on)), known)),
      totals: onDates.map((on) => j(banking.total(banking.valuesAt(ledger, item.id, on)))),
    };
  });
  out["of_account"] = [...ledger.accounts.values()].map((a) => {
    const b = banking.ofAccount(ledger, a.id);
    return norm(b ? b.id : null, known);
  });
  const sheets: unknown[] = [];
  for (const year of [Y - 1, Y, Y + 1]) {
    for (const declarant of [null, ...members]) sheets.push(yearSheets(ledger, year, declarant, known));
  }
  out["sheets"] = sheets;
  return out;
}

describe("tax golden", () => {
  it("investment codes", () => {
    expect(investmentCodes()).toEqual(data.investment_codes);
  });

  describe.each(data.scenarios)("$name", (scenario) => {
    it("replays the commands and gives the same sheets", { timeout: 60_000 }, () => {
      const recordsIn = scenario.records as LedgerRecord[];
      const ledger = Ledger.fromRecords(recordsIn);
      const known = knownIds(recordsIn);
      const results = runCommands(ledger, scenario.commands, scenario.names, TAX_COMMANDS, known);
      expect(results).toEqual(scenario.results);
      const snap = snapshot(ledger, known);
      const expected = scenario.snapshot as O;
      for (const key of Object.keys(expected)) expect(snap[key], key).toEqual(expected[key]);
    });
  });
});
