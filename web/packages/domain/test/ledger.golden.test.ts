import { describe, expect, it } from "vitest";

import { reclassify } from "../src/domain/edits.ts";
import { DomainError, Ledger, type LedgerRecord } from "../src/domain/ledger.ts";
import { dump, isActive, type Operation, OperationKind } from "../src/domain/model.ts";
import * as queries from "../src/domain/queries.ts";
import { findOperations, operationFilter, type OperationFilter } from "../src/domain/search.ts";
import { type IsoDate, ymAdd, ymOf, ymParse } from "../src/lib/dates.ts";
import { golden, j } from "./golden.ts";

interface Scenario {
  seed: number;
  records: LedgerRecord[];
  queries: Record<string, unknown> & {
    balances: { at: IsoDate | null; values: unknown }[];
    balance: { at: IsoDate | null; account: string; value: unknown }[];
    net_worth: { at: IsoDate | null }[];
    search: { filter: Record<string, unknown>; ids: string[] }[];
    statements: { month: string; member: string | null }[];
  };
  commands: { cmd: string; args: unknown[] }[];
  results: unknown[];
  row_counts: Record<string, number>;
}

const { scenarios } = golden<{ scenarios: Scenario[] }>("ledger");
const START = "2025-11-01" as IsoDate;

function mapToObj(m: Map<string, unknown>): unknown {
  return j(Object.fromEntries(m));
}

function runCommands(ledger: Ledger, commands: Scenario["commands"]): unknown[] {
  const results: unknown[] = [];
  let last: string | null = null;
  const original = new Set(ledger.operations.keys());
  for (const c of commands) {
    const a = c.args as string[];
    try {
      let op: Operation;
      switch (c.cmd) {
        case "expense":
          op = ledger.recordExpense(a[0]!, a[1]!, a[2]!, a[3] as IsoDate, a[4]!);
          break;
        case "expense_split":
          op = ledger.recordExpense(a[0]!, c.args[1] as [string, string][], a[2]!, a[3] as IsoDate, a[4]!);
          break;
        case "transfer":
          op = ledger.recordTransfer(a[0]!, a[1]!, a[2]!, a[3] as IsoDate);
          break;
        case "income":
          op = ledger.recordIncome(a[0]!, a[1]!, a[2]!, a[3] as IsoDate, a[4]!);
          break;
        case "card_purchase":
          op = ledger.recordCardPurchase(a[0]!, a[1]!, a[2]!, a[3] as IsoDate, a[4]!);
          break;
        case "card_payment":
          op = ledger.recordCardPayment(a[0]!, a[1]!, a[2]!, a[3] as IsoDate);
          break;
        case "opening":
          op = ledger.recordOpeningBalance(a[0]!, a[1]!, a[2] as IsoDate);
          break;
        case "member": {
          const m = ledger.addMember(a[0]!);
          results.push({ ok: { name: m.name, role: m.role, active: m.active } });
          continue;
        }
        case "reclassify": {
          const ids = [...ledger.operations.values()]
            .filter((o) => isActive(o) && o.kind === OperationKind.EXPENSE && original.has(o.id))
            .map((o) => o.id)
            .sort()
            .slice(0, 12);
          const r = reclassify(ledger, ids, a[1]!, a[2]!);
          results.push({ ok: { changed: r.changed, skipped: r.skipped, errors: [...r.errors] } });
          continue;
        }
        case "cancel":
          op = ledger.cancelOperation(last!, a[1]!);
          break;
        case "reverse": {
          const target = [...ledger.operations.values()]
            .filter((o) => isActive(o) && original.has(o.id))
            .map((o) => o.id)
            .sort()[0]!;
          op = ledger.reverseOperation(target, a[1] as IsoDate, a[2]!);
          break;
        }
        default:
          throw new Error(c.cmd);
      }
      last = op.id;
      const payload = dump(op);
      delete payload["id"];
      results.push({ ok: payload });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      results.push({ error: error.message });
    }
  }
  return results;
}

describe.each(scenarios)("ledger golden (seed $seed)", (s) => {
  const ledger = Ledger.fromRecords(s.records);

  it("round-trips the records exactly", () => {
    const back = ledger.toRecords().map((r) => ({ id: r.id, kind: r.kind, payload: r.payload }));
    const sortKey = (r: LedgerRecord) => `${r.kind}:${r.id}`;
    expect([...back].sort((x, y) => sortKey(x).localeCompare(sortKey(y)))).toEqual(
      [...s.records].sort((x, y) => sortKey(x).localeCompare(sortKey(y))),
    );
  });

  it("balances and net worth", () => {
    for (const b of s.queries.balances)
      expect(mapToObj(queries.balances(ledger, b.at)), String(b.at)).toEqual(b.values);
    for (const b of s.queries.balance) expect(j(queries.balance(ledger, b.account, b.at))).toEqual(b.value);
    for (const n of s.queries.net_worth) {
      const nw = queries.netWorth(ledger, n.at);
      expect({
        at: n.at,
        assets: j(nw.assets),
        liabilities: j(nw.liabilities),
        net: j(nw.net),
        by_account: mapToObj(nw.byAccount),
      }).toEqual(n);
    }
  });

  it("cash flow, statements and categories", () => {
    const first = ymAdd(ymOf(START), -1);
    const last = ymAdd(ymOf(START), 6);
    const flows = queries.cashFlow(ledger, first, last);
    expect(
      Object.fromEntries([...flows].map(([m, f]) => [m, { in: j(f.inflow), out: j(f.outflow), net: j(f.net) }])),
    ).toEqual(s.queries["cash_flow"]);
    const bankId = (s.queries.balance[0] as { account: string }).account;
    const only = queries.cashFlow(ledger, first, last, [bankId]);
    expect(Object.fromEntries([...only].map(([m, f]) => [m, { in: j(f.inflow), out: j(f.outflow) }]))).toEqual(
      s.queries["cash_flow_bank"],
    );
    for (const st of s.queries.statements) {
      const r = queries.incomeStatement(ledger, ymParse(st.month), st.member);
      expect({
        month: st.month,
        member: st.member,
        income: mapToObj(r.income),
        expense: mapToObj(r.expense),
        total_income: j(r.totalIncome),
        total_expense: j(r.totalExpense),
        result: j(r.result),
      }).toEqual(st);
    }
    expect(mapToObj(queries.expensesByCategory(ledger, first, last))).toEqual(s.queries["by_category"]);
  });

  it("search", () => {
    for (const q of s.queries.search) {
      const f = q.filter as unknown as Partial<OperationFilter>;
      const flt = operationFilter({ ...f });
      expect(
        findOperations(ledger, flt).map((o) => o.id),
        JSON.stringify(q.filter),
      ).toEqual(q.ids);
    }
  });

  it("commands give the same results and errors", () => {
    const fresh = Ledger.fromRecords(s.records);
    expect(runCommands(fresh, s.commands)).toEqual(s.results);
    expect(fresh.rowCounts()).toEqual(s.row_counts);
  });
});
