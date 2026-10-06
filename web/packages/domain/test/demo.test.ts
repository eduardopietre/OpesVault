/**
 * The demo project (src/demo.ts, port of tests/demo_vault.py): every persisted row and the figures
 * its queries give equal the desktop's (golden/demo.json), and it survives `toRecords`/`fromRecords`.
 */
import { describe, expect, it } from "vitest";

import { demoSession } from "../src/demo.ts";
import * as budget from "../src/domain/budget.ts";
import { Ledger } from "../src/domain/ledger.ts";
import * as merchants from "../src/domain/merchants.ts";
import { AccountType } from "../src/domain/model.ts";
import * as queries from "../src/domain/queries.ts";
import * as tags from "../src/domain/tags.ts";
import { makeDate, type IsoDate, type YearMonth, ymOf, ymStr } from "../src/lib/dates.ts";
import type { Id } from "../src/lib/ids.ts";
import { unrealized, valueAt } from "../src/investments/performance.ts";
import { assets, positions, remainingCost } from "../src/investments/service.ts";
import { cmpStr } from "../src/lib/text.ts";
import { golden, j } from "./golden.ts";
import { extractor } from "./importing_helpers.ts";

const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

interface File {
  today: IsoDate;
  records: unknown[];
  summary: Record<string, unknown>;
}
const data = golden<File>("demo");

class Renamer {
  private readonly seen = new Map<string, string>();
  name(text: string): string {
    if (INSTANT.test(text)) return "<instant>";
    return text.replace(UUID_TEXT, (m) => {
      if (!this.seen.has(m)) this.seen.set(m, `#${this.seen.size}`);
      return this.seen.get(m)!;
    });
  }
  value(v: unknown): unknown {
    if (typeof v === "string") return this.name(v);
    if (Array.isArray(v)) return v.map((x) => this.value(x));
    if (v !== null && typeof v === "object") {
      const record = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort(cmpStr)
          .map((k) => [
            k,
            k === "bbox" && Array.isArray(record[k])
              ? (record[k] as number[]).map((x) => Math.round(x * 1e6) / 1e6)
              : this.value(record[k]),
          ]),
      );
    }
    return v;
  }
}

function rowsOf(ledger: Ledger): unknown[] {
  const renamer = new Renamer();
  return [...ledger.toRecords()]
    .sort((a, b) => cmpStr(a.kind, b.kind))
    .map((r) => ({
      kind: r.kind,
      id: renamer.name(r.id),
      payload: renamer.value(JSON.parse(JSON.stringify(r.payload))),
    }));
}

function summary(ledger: Ledger, documents: { name: string; sha: string; size: number }[], today: IsoDate) {
  const names = new Map([...ledger.accounts.values()].map((a) => [a.id, a.name]));
  const byName = (values: ReadonlyMap<Id, unknown>) =>
    Object.fromEntries([...values].map(([k, v]) => [names.get(k)!, j(v)]));
  const months: YearMonth[] = [1, 2, 3].map((month) => ({ year: 2026, month }));
  months.push(ymOf(today));
  const statements = Object.fromEntries(
    months.map((m) => {
      const s = queries.incomeStatement(ledger, m);
      return [
        ymStr(m),
        {
          income: byName(s.income),
          expense: byName(s.expense),
          total_income: j(s.totalIncome),
          total_expense: j(s.totalExpense),
          result: j(s.result),
        },
      ];
    }),
  );
  const worth = queries.netWorth(ledger);
  const at = makeDate(2026, 3, 31);
  return {
    balances: [...ledger.accounts.values()].map((a) => [a.name, j(queries.balance(ledger, a.id))]),
    balances_at_march: byName(queries.balances(ledger, at)),
    net_worth: { assets: j(worth.assets), liabilities: j(worth.liabilities), net: j(worth.net) },
    statements,
    expenses_by_category: byName(queries.expensesByCategory(ledger, months[0]!, months[2]!)),
    budget: [budget.status(ledger, { year: 2026, month: 3 }), budget.status(ledger, ymOf(today))].map((s) => ({
      month: ymStr(s.month),
      rows: s.rows.map((r) => [r.name, j(r.planned), j(r.actual), j(r.remaining), r.state, j(r.used)]),
      planned: j(s.totalPlanned),
      actual: j(s.totalActual),
      unbudgeted: j(s.unbudgeted),
    })),
    tags: tags.summaries(ledger).map((s) => [s.tag, s.operations.length, j(s.expense)]),
    merchants: merchants
      .totals(ledger, makeDate(2026, 1, 1), today)
      .map((m) => [m.name, j(m.expense), m.count, m.approved]),
    positions: [...positions(ledger).values()].map((pos) => {
      const observed = valueAt(ledger, pos.id, at);
      return {
        name: assets(ledger).get(pos.asset_id)!.name,
        remaining_cost: j(remainingCost(ledger, pos.id)),
        unrealized: j(unrealized(ledger, pos.id, at)),
        value: j(observed ? observed.valuation.value : null),
      };
    }),
    categories: Object.fromEntries(
      [AccountType.EXPENSE, AccountType.INCOME].map((kind) => [
        kind,
        ledger
          .categories(kind)
          .map((a) => a.name)
          .sort(cmpStr),
      ]),
    ),
    row_counts: ledger.rowCounts(),
    members: [...ledger.members.values()].map((m) => [m.name, m.role, m.active]),
    meta: { family_name: ledger.meta.family_name },
    documents: documents.map((d) => [d.name, d.sha, d.size]),
    operations: ledger.operations.size,
  };
}

describe("the demo project", () => {
  it("has the desktop's rows and figures", { timeout: 60_000 }, async () => {
    const session = await demoSession({ today: data.today, extractor });
    const documents = session.documents.map((d) => ({
      name: d.meta.original_name,
      sha: d.meta.sha256,
      size: d.meta.size,
    }));
    expect(rowsOf(session.ledger)).toEqual(data.records);
    expect(JSON.parse(JSON.stringify(summary(session.ledger, documents, data.today)))).toEqual(data.summary);
  });

  it("round-trips through toRecords and fromRecords", { timeout: 60_000 }, async () => {
    const session = await demoSession({ today: data.today, extractor });
    const again = Ledger.fromRecords(session.ledger.toRecords());
    expect(rowsOf(again)).toEqual(rowsOf(session.ledger));
    expect(again.rowCounts()).toEqual(session.ledger.rowCounts());
  });
});
