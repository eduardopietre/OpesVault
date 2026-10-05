/**
 * Read-only views over the ledger: balances, cash, competence and net worth (docs/04 §4-6).
 * Port of `domain/queries.py`. The same facts produce every view; nothing here mutates the ledger.
 */
import { type IsoDate, type YearMonth, ymAdd, ymIndex, ymLte, ymOf, ymStr } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import type { Ledger } from "./ledger.ts";
import {
  AccountType,
  cashDate,
  competence,
  isBalanceSheet,
  isLiquid,
  type LedgerAccount,
  type Operation,
  OperationKind,
} from "./model.ts";
import { ZERO } from "./money.ts";

function naturalSign(account: LedgerAccount): 1 | -1 {
  return account.type === AccountType.ASSET || account.type === AccountType.EXPENSE ? 1 : -1;
}

function bisectRight(sorted: readonly IsoDate[], at: IsoDate): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at < sorted[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Per-ledger lookup tables, rebuilt only when the ledger changes. Balances use prefix sums per
 * account (bisect by date) and month views read pre-grouped operations.
 */
export class QueryIndex {
  readonly dates = new Map<Id, IsoDate[]>();
  readonly prefix = new Map<Id, Dec[]>();
  readonly undated = new Map<Id, Dec>();
  /** Keyed by "YYYY-MM". */
  readonly byCompetence = new Map<string, Operation[]>();
  readonly byCashMonth = new Map<string, Operation[]>();

  constructor(ledger: Ledger) {
    const dated = new Map<Id, [IsoDate, Dec][]>();
    for (const op of ledger.activeOperations()) {
      const when = cashDate(op) ?? op.occurred_on;
      for (const p of op.postings) {
        if (when === null) this.undated.set(p.account_id, (this.undated.get(p.account_id) ?? ZERO).add(p.amount));
        else {
          let list = dated.get(p.account_id);
          if (list === undefined) dated.set(p.account_id, (list = []));
          list.push([when, p.amount]);
        }
      }
      const comp = competence(op);
      if (comp !== null) push(this.byCompetence, ymStr(comp), op);
      const cd = cashDate(op);
      if (cd !== null) push(this.byCashMonth, ymStr(ymOf(cd)), op);
    }
    for (const [accountId, entries] of dated) {
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      let running = ZERO;
      const ds: IsoDate[] = [];
      const ps: Dec[] = [];
      for (const [when, amount] of entries) {
        running = running.add(amount);
        ds.push(when);
        ps.push(running);
      }
      this.dates.set(accountId, ds);
      this.prefix.set(accountId, ps);
    }
  }

  rawBalance(accountId: Id, at: IsoDate | null): Dec {
    const prefix = this.prefix.get(accountId);
    if (at === null) {
      const datedTotal = prefix && prefix.length ? prefix[prefix.length - 1]! : ZERO;
      return datedTotal.add(this.undated.get(accountId) ?? ZERO);
    }
    if (!prefix || !prefix.length) return ZERO;
    const position = bisectRight(this.dates.get(accountId)!, at);
    return position ? prefix[position - 1]! : ZERO;
  }

  /** Python's `set(prefix) | set(undated)`, in first-seen order. */
  accounts(): Id[] {
    return [...new Set([...this.prefix.keys(), ...this.undated.keys()])];
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

export function index(ledger: Ledger): QueryIndex {
  return ledger.cached("queries.index", () => new QueryIndex(ledger));
}

/**
 * Balance in the account's natural sign, by cash date, up to `at` inclusive.
 * Operations without any date count only in the undated (overall) balance.
 */
export function balance(ledger: Ledger, accountId: Id, at: IsoDate | null = null): Dec {
  const account = ledger.account(accountId);
  return index(ledger).rawBalance(accountId, at).mul(naturalSign(account));
}

export function balances(ledger: Ledger, at: IsoDate | null = null): Map<Id, Dec> {
  const idx = index(ledger);
  const out = new Map<Id, Dec>();
  for (const aid of idx.accounts()) {
    const raw = idx.rawBalance(aid, at);
    const first = idx.dates.get(aid)?.[0];
    if (!raw.isZero() || at === null || (first !== undefined && first <= at)) {
      out.set(aid, raw.mul(naturalSign(ledger.account(aid))));
    }
  }
  return out;
}

export interface NetWorth {
  assets: Dec;
  liabilities: Dec;
  byAccount: Map<Id, Dec>;
  readonly net: Dec;
}

function makeNetWorth(): NetWorth {
  return {
    assets: ZERO,
    liabilities: ZERO,
    byAccount: new Map(),
    get net() {
      return this.assets.sub(this.liabilities);
    },
  };
}

/** Joint accounts enter once: the family is one perimeter (docs/04 §6). */
export function netWorth(ledger: Ledger, at: IsoDate | null = null): NetWorth {
  const result = makeNetWorth();
  for (const [aid, value] of balances(ledger, at)) {
    const account = ledger.account(aid);
    if (account.type === AccountType.ASSET) result.assets = result.assets.add(value);
    else if (account.type === AccountType.LIABILITY) result.liabilities = result.liabilities.add(value);
    else continue;
    result.byAccount.set(aid, value);
  }
  return result;
}

export interface MonthFlow {
  inflow: Dec;
  outflow: Dec;
  readonly net: Dec;
}

export function makeMonthFlow(): MonthFlow {
  return {
    inflow: ZERO,
    outflow: ZERO,
    get net() {
      return this.inflow.sub(this.outflow);
    },
  };
}

/** Internal when money only moves between balance-sheet accounts inside the perimeter. */
export function isInternal(ledger: Ledger, op: Operation, perimeter: ReadonlySet<Id> | null = null): boolean {
  for (const p of op.postings) {
    const account = ledger.account(p.account_id);
    if (!isBalanceSheet(account) || account.type === AccountType.EQUITY) return false;
    if (perimeter !== null && !perimeter.has(p.account_id)) return false;
  }
  return true;
}

/**
 * Inflows/outflows of liquid accounts by cash date. Transfers among the selected liquid accounts
 * are excluded; paying a card bill is a real cash outflow, the purchase itself never touched cash.
 * Keyed by "YYYY-MM" in month order.
 */
export function cashFlow(
  ledger: Ledger,
  start: YearMonth,
  end: YearMonth,
  accounts: Iterable<Id> | null = null,
): Map<string, MonthFlow> {
  const selected = new Set(accounts ?? [...ledger.accounts.values()].filter(isLiquid).map((a) => a.id));
  const months = new Map<string, MonthFlow>();
  for (let cursor = start; ymLte(cursor, end); cursor = ymAdd(cursor, 1)) months.set(ymStr(cursor), makeMonthFlow());
  const idx = index(ledger);
  for (const [month, flow] of months) for (const op of idx.byCashMonth.get(month) ?? []) addFlow(flow, op, selected);
  return months;
}

function addFlow(flow: MonthFlow, op: Operation, selected: ReadonlySet<Id>): void {
  if (op.kind === OperationKind.OPENING_BALANCE) return; // an opening balance is a starting point, not a flow
  const inside = op.postings.filter((p) => selected.has(p.account_id));
  if (!inside.length) return;
  if (op.postings.every((p) => selected.has(p.account_id))) return; // internal transfer within the perimeter
  const delta = Dec.sum(
    inside.map((p) => p.amount),
    ZERO,
  );
  if (delta.isPositive()) flow.inflow = flow.inflow.add(delta);
  else if (delta.isNegative()) flow.outflow = flow.outflow.add(delta.negate());
}

export interface Statement {
  income: Map<Id, Dec>;
  expense: Map<Id, Dec>;
  readonly totalIncome: Dec;
  readonly totalExpense: Dec;
  readonly result: Dec;
}

export function makeStatement(): Statement {
  return {
    income: new Map(),
    expense: new Map(),
    get totalIncome() {
      return Dec.sum(this.income.values(), ZERO);
    },
    get totalExpense() {
      return Dec.sum(this.expense.values(), ZERO);
    },
    get result() {
      return this.totalIncome.sub(this.totalExpense);
    },
  };
}

function addTo(map: Map<Id, Dec>, key: Id, value: Dec): void {
  map.set(key, (map.get(key) ?? ZERO).add(value));
}

/** Revenues and expenses by competence. With `memberId`, only that member's rateio shares. */
export function incomeStatement(ledger: Ledger, month: YearMonth, memberId: Id | null = null): Statement {
  const statement = makeStatement();
  for (const op of index(ledger).byCompetence.get(ymStr(month)) ?? []) {
    for (const p of op.postings) {
      const account = ledger.account(p.account_id);
      if (memberId !== null && (p.member_id ?? op.member_id) !== memberId) continue;
      if (account.type === AccountType.INCOME) addTo(statement.income, account.id, p.amount.negate());
      else if (account.type === AccountType.EXPENSE) addTo(statement.expense, account.id, p.amount);
    }
  }
  return statement;
}

export function expensesByCategory(ledger: Ledger, start: YearMonth, end: YearMonth): Map<Id, Dec> {
  const totals = new Map<Id, Dec>();
  const lo = ymIndex(start);
  const hi = ymIndex(end);
  for (const [comp, ops] of index(ledger).byCompetence) {
    const i = ymIndex({ year: Number(comp.slice(0, 4)), month: Number(comp.slice(5, 7)) });
    if (i < lo || i > hi) continue;
    for (const op of ops) {
      for (const p of op.postings)
        if (ledger.account(p.account_id).type === AccountType.EXPENSE) addTo(totals, p.account_id, p.amount);
    }
  }
  return totals;
}
