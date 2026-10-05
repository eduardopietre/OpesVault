/**
 * Parity of the planning modules with the desktop (golden/planning.json, scripts/golden/cases_planning.py).
 *
 * Loads the records of each seeded ledger, recomputes every query of `queries_of()` and replays the
 * commands of `commands()`/`run()`; results are compared as Python wrote them, decimals as text.
 */
import { describe, expect, it } from "vitest";

import * as anomalies from "../src/domain/anomalies.ts";
import * as balanceChecks from "../src/domain/balance_checks.ts";
import * as budget from "../src/domain/budget.ts";
import * as cards from "../src/domain/cards.ts";
import * as comparisons from "../src/domain/comparisons.ts";
import * as deductibles from "../src/domain/deductibles.ts";
import * as goals from "../src/domain/goals.ts";
import * as indicators from "../src/domain/indicators.ts";
import { DomainError, Ledger, type LedgerRecord } from "../src/domain/ledger.ts";
import * as loans from "../src/domain/loans.ts";
import * as merchants from "../src/domain/merchants.ts";
import { AccountType, cashDate, dump } from "../src/domain/model.ts";
import * as periods from "../src/domain/periods.ts";
import * as projection from "../src/domain/projection.ts";
import * as queries from "../src/domain/queries.ts";
import * as recurrence from "../src/domain/recurrence.ts";
import * as savedFilters from "../src/domain/saved_filters.ts";
import * as settings from "../src/domain/settings.ts";
import * as sharing from "../src/domain/sharing.ts";
import * as subscriptions from "../src/domain/subscriptions.ts";
import * as tags from "../src/domain/tags.ts";
import { addDays, DateError, type IsoDate, ymAdd, ymOf, ymParse, ymStr, type YearMonth } from "../src/lib/dates.ts";
import { Dec } from "../src/lib/dec.ts";
import { cmpKeys, cmpStr } from "../src/lib/text.ts";
import { golden } from "./golden.ts";
import { anon, idSet, py, uuidsIn } from "./pyjson.ts";

interface Scenario {
  seed: number;
  records: LedgerRecord[];
  names: Record<string, string>;
  queries: Record<string, unknown>;
  commands: { cmd: string; args: unknown[] }[];
  results: unknown[];
  after: Record<string, unknown>;
  row_counts: Record<string, number>;
}

interface Pure {
  annual_to_monthly: { in: string; ok?: string; error?: string }[];
  due_date: [string, number, string][];
  schedules: { plan: Record<string, unknown>; extra: [number, string, string][]; result: unknown }[];
  bad: { plan: Record<string, unknown>; ok?: boolean; error?: string };
}

const G = golden<{ todays: string[]; start: string; pure: Pure; scenarios: Scenario[] }>("planning");
const TODAYS = G.todays as IsoDate[];
const START = G.start as IsoDate;
const MONTHS = 14;
const DESCRIPTIONS = [
  "IFD*IFOOD.COM AGENCIA",
  "IFD*IFOOD.COM AGENCIA 7781",
  "MP*LOJA DO ZE 123456",
  "PADARIA REAL LTDA BR",
  "SPOTIFY P1A2B3",
  "NETFLIX.COM",
  "TV 55 (3/10)",
  "12345",
  "  Farmácia São João  ",
  "UBER *TRIP 8812",
  "PAG*Açaí do Bairro",
  "APPLE.COM/BILL",
  "POSTO SHELL",
  "Loja.COM.BR Centro",
  "MERCADO.COMPRAS",
  "ÇA.COMÉRCIO",
  "",
  "x".repeat(70),
  "ß straße",
];

const dec = (v: Dec) => py(v);

function monthList(first: YearMonth, count: number): YearMonth[] {
  return Array.from({ length: count }, (_, i) => ymAdd(first, i));
}

function bill(b: cards.Bill): unknown {
  return {
    ...(py(b) as object),
    total: dec(b.total),
    remaining: dec(b.remaining),
    status: TODAYS.map((t) => b.status(t)),
    month: ymStr(b.cycle.month),
  };
}

function sortedBalances(found: sharing.Balance[]): unknown[] {
  return [...found]
    .sort((a, b) => cmpKeys([b.amount, a.debtorId, a.creditorId], [a.amount, b.debtorId, b.creditorId]))
    .map(py);
}

function tagSummary(s: tags.TagSummary): unknown {
  return {
    tag: s.tag,
    expense: dec(s.expense),
    income: dec(s.income),
    by_category: py(s.byCategory),
    first: s.first,
    last: s.last,
    operations: idSet(s.operations.map((o) => o.id)),
    dates: s.operations.map((o) => o.occurred_on ?? cashDate(o)),
  };
}

function progress(ledger: Ledger, goal: goals.Goal, today: IsoDate): unknown {
  let p: goals.Progress;
  try {
    p = goals.progress(ledger, goal, today);
  } catch (error) {
    if (error instanceof DateError) return { error: "month out of range" };
    throw error;
  }
  return { ...(py(p) as object), reached: p.reached };
}

/** Mirrors `queries_of()` of cases_planning.py. */
function queriesOf(ledger: Ledger, n: Record<string, string>): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const first = ymOf(START);
  const months = monthList(ymAdd(first, -1), MONTHS + 3);
  const card = ledger.cards.get(n["card"]!)!;
  const end = n["end"] as IsoDate;
  // recurrence
  q["occurrences"] = Object.fromEntries(
    [...recurrence.rules(ledger)].map(([rid, r]) => [rid, recurrence.occurrences(r, START, "2026-09-30" as IsoDate)]),
  );
  q["forecasts"] = (
    [
      [START, end, TODAYS[0]],
      ["2026-03-01", "2026-08-31", TODAYS[1]],
      ["2026-07-01", "2026-07-31", TODAYS[2]],
    ] as [IsoDate, IsoDate, IsoDate][]
  ).map(([a, b, t]) => py(recurrence.forecasts(ledger, a, b, t)));
  q["candidates"] = recurrence
    .forecasts(ledger, START, end, TODAYS[1]!)
    .filter((f) => f.status === "pending" || f.status === "late")
    .map((f) => recurrence.candidates(ledger, f).map((o) => o.id));
  q["auto_suggestions"] = recurrence
    .autoSuggestions(ledger, START, end, TODAYS[1]!)
    .map(([f, o]) => [f.ruleId, f.dueOn, dec(f.amount), o.id]);
  // cards
  q["cycle_for"] = Array.from({ length: 50 }, (_, k) => {
    const c = cards.cycleFor(card, addDays(START, k * 9));
    return { ...(py(c) as object), month: ymStr(c.month) };
  });
  q["cycle_by_due_month"] = months.map((m) => py(cards.cycleByDueMonth(card, m)));
  q["bills"] = Object.fromEntries(
    ["card", "card2"].map((name) => [name, cards.bills(ledger, n[name]!, months).map(bill)]),
  );
  q["schedules"] = Object.fromEntries(
    [...cards.plans(ledger).values()].map((p) => [p.id, py(cards.schedule(ledger, p))]),
  );
  const matches: unknown[] = [];
  for (const p of cards.plans(ledger).values()) {
    let amount = Dec.from(0);
    for (const [number, desc] of [
      [p.first_number, p.description.toLowerCase()],
      [2, `${p.description} PARCELA 2/${p.count}`],
      [p.count + 1, p.description],
    ] as const) {
      amount = p.amounts[Math.min(number - 1, p.amounts.length - 1)]!;
      matches.push(py(cards.findPlanForInstallment(ledger, p.card_id, desc, number, p.count, amount)));
    }
    matches.push(py(cards.findPlanForInstallment(ledger, p.card_id, p.description, 1, p.count, amount.add(1))));
  }
  q["find_plan"] = matches;
  // periods
  q["periods"] = months.map((m) => ({
    month: ymStr(m),
    closed: periods.isClosed(ledger, m),
    pending: periods.pendingItems(ledger, m),
    summary: dump(periods.summarize(ledger, m)),
    unchanged: periods.closedFiguresUnchanged(ledger, m),
  }));
  q["months_of"] = Object.fromEntries(
    [...ledger.operations.values()].map((o) => [o.id, periods.monthsOf(o).map(ymStr).sort()]),
  );
  // budget
  q["budget"] = months.map((m) => {
    const s = budget.status(ledger, m);
    return { ...(py(s) as object), over: s.over.map((r) => r.categoryId), near: s.near.map((r) => r.categoryId) };
  });
  q["budget_lines"] = Object.fromEntries(
    months.map((m) => [ymStr(m), idSet(budget.linesOf(ledger, m).map((x) => x.category_id))]),
  );
  // balance checks
  q["checks"] = balanceChecks
    .results(ledger)
    .map((r) => ({ ...(py(r) as object), difference: dec(r.difference), matches: r.matches }));
  q["checks_bank"] = balanceChecks.results(ledger, n["bank"]).map((r) => r.check.id);
  q["checks_latest"] = Object.fromEntries([...balanceChecks.latest(ledger)].map(([k, v]) => [k, v.check.id]));
  q["checks_divergent"] = balanceChecks.divergent(ledger).map((r) => r.check.id);
  // loans
  const loanOut: Record<string, unknown> = {};
  for (const pid of loans.plans(ledger).keys()) {
    const sims = (
      [
        ["1000.00", "reduce_term"],
        ["1000.00", "reduce_payment"],
        ["0.01", "reduce_term"],
      ] as const
    ).map(([amount, mode]) => {
      const s = loans.simulatePrepayment(ledger, pid, amount, mode);
      return { ...(py(s) as object), interest_saved: dec(s.interestSaved) };
    });
    const items = loans.planSchedule(ledger, pid);
    loanOut[pid] = {
      schedule: py(items),
      plain_schedule: py(loans.schedule(loans.plans(ledger).get(pid)!)),
      status: TODAYS.map((t) => py(loans.status(ledger, pid, t))),
      simulations: sims,
      paid: [...loans.paidNumbers(ledger, pid).keys()].sort((a, b) => a - b),
      states: items.map((i) => loans.stateOf(ledger, pid, i, TODAYS[1]!)),
    };
  }
  q["loans"] = loanOut;
  q["loans_upcoming"] = loans
    .upcoming(ledger, "2026-01-01" as IsoDate, "2026-12-31" as IsoDate)
    .map(([p, i]) => [p.id, py(i)]);
  q["loan_operation_ids"] = idSet(loans.loanOperationIds(ledger));
  // deductibles
  q["deductible_kinds"] = Object.fromEntries(
    [...ledger.accounts.values()]
      .filter((a) => a.type === AccountType.EXPENSE)
      .map((a) => [a.id, deductibles.kindOf(ledger, a.id)]),
  );
  q["deductibles"] = Object.fromEntries(
    [2025, 2026, 2027].map((year) => [
      String(year),
      deductibles.annual(ledger, year).map((g) => ({
        kind: g.kind,
        member_id: g.memberId,
        total: dec(g.total),
        lines: g.lines.map((x) => [x.operation.id, x.categoryId, x.memberId, dec(x.amount)]),
      })),
    ]),
  );
  // sharing
  q["reimbursements"] = [...sharing.reimbursements(ledger).values()].map((r) => ({
    id: r.id,
    state: sharing.state(ledger, r),
    received: dec(sharing.received(ledger, r)),
  }));
  q["open_reimbursements"] = sharing.openItems(ledger).map((r) => r.id);
  q["payers"] = Object.fromEntries([...ledger.operations.values()].map((o) => [o.id, sharing.payerOf(ledger, o)]));
  q["shares"] = py(sharing.shares(ledger));
  q["shares_window"] = py(sharing.shares(ledger, "2026-01-01" as IsoDate, "2026-03-31" as IsoDate));
  q["balances"] = sortedBalances(sharing.balances(ledger));
  q["balances_window"] = sortedBalances(sharing.balances(ledger, "2026-02-01" as IsoDate, "2026-05-31" as IsoDate));
  // comparisons and indicators
  q["first_activity"] = py(comparisons.firstActivity(ledger));
  const cmp = (c: comparisons.Comparison) => ({ ...(py(c) as object), delta: py(c.delta), change: py(c.change) });
  q["comparisons"] = Object.fromEntries(
    months.map((m) => [
      ymStr(m),
      {
        categories: comparisons.categoryComparison(ledger, m).map(cmp),
        totals: comparisons.totalsComparison(ledger, m, 6).map(cmp),
      },
    ]),
  );
  q["indicators"] = Object.fromEntries(months.map((m) => [ymStr(m), py(indicators.indicators(ledger, m))]));
  // goals
  q["goals"] = goals.goals(ledger).map((g) => g.id);
  q["progress"] = goals.goals(ledger).flatMap((g) => TODAYS.map((t) => progress(ledger, g, t)));
  // tags
  q["all_tags"] = tags.allTags(ledger);
  q["tags_of"] = Object.fromEntries([...ledger.operations.keys()].map((o) => [o, [...tags.tagsOf(ledger, o)]]));
  q["operations_with"] = Object.fromEntries(
    [...tags.allTags(ledger), "VIAGEM 2026"].map((t) => [t, idSet(tags.operationsWith(ledger, t))]),
  );
  q["tag_summaries"] = tags.summaries(ledger).map(tagSummary);
  // merchants
  q["clean"] = DESCRIPTIONS.map((d) => [d, merchants.clean(d), merchants.keyOf(d), merchants.merchantOf(ledger, d)]);
  q["merchant_totals"] = (
    [
      [START, end],
      ["2026-03-01", "2026-03-31"],
    ] as [IsoDate, IsoDate][]
  ).map(([a, b]) => py(merchants.totals(ledger, a, b)));
  // anomalies
  q["suspicions"] = TODAYS.map((t) => py(anomalies.suspicions(ledger, t)));
  q["of_operation"] = ["dup", "outlier"].map((k) => py(anomalies.ofOperation(ledger, n[k]!, TODAYS[1]!)));
  // subscriptions
  q["commitments"] = subscriptions
    .commitments(ledger)
    .map((c) => ({ ...(py(c) as object), rule: c.rule.id, price_changed: c.priceChanged }));
  q["yearly_total"] = dec(subscriptions.yearlyTotal(ledger));
  q["subscription_candidates"] = TODAYS.map((t) => py(subscriptions.candidates(ledger, t)));
  // projection
  q["projection_events"] = TODAYS.map((t) => py(projection.events(ledger, t, addDays(t, 60))));
  q["projections"] = TODAYS.flatMap((t) =>
    projection.project(ledger, t).map((p) => ({
      ...(py(p) as object),
      lowest: py(p.lowest),
      first_negative: p.firstNegative,
      balance_on: dec(p.balanceOn(addDays(t, 20))),
      daily: py(p.daily(addDays(t, 10))),
    })),
  );
  q["projection_chosen"] = py(projection.project(ledger, TODAYS[1]!, 30, [n["card_account"]!, n["joint"]!]));
  q["negative_ahead"] = TODAYS.map((t) => projection.negativeAhead(ledger, t, 45).map((p) => p.accountId));
  // saved filters and settings
  q["saved_filters"] = py(savedFilters.saved(ledger));
  q["settings"] = py(settings.getSettings(ledger));
  q["balance_bank"] = dec(queries.balance(ledger, n["bank"]!));
  return q;
}

/** Mirrors `run()` of cases_planning.py. */
function run(ledger: Ledger, cmd: string, a: unknown[]): unknown {
  const s = (i: number) => a[i] as string;
  const date = (i: number) => a[i] as IsoDate;
  switch (cmd) {
    case "expense":
      return ledger.recordExpense(s(0), s(1), s(2), date(3), s(4));
    case "update_desc": {
      const op = ledger.operations.get(s(0))!;
      return ledger.updateOperation({ ...op, description: op.description + " (nota)" }, "nota");
    }
    case "cancel":
      return ledger.cancelOperation(s(0), "erro");
    case "close":
      return periods.closeMonth(ledger, ymParse(s(0)), a[1] as string | null);
    case "reopen":
      return periods.reopenMonth(ledger, ymParse(s(0)), s(1));
    case "realize":
      return recurrence.realize(ledger, s(0), date(1), s(2));
    case "skip":
      return recurrence.skip(ledger, s(0), date(1));
    case "add_rule":
      return recurrence.addRule(
        ledger,
        recurrence.RecurrenceRuleSchema.parse({
          description: "Nova",
          account_id: s(0),
          counterpart_id: s(1),
          amount: s(2),
          day: 15,
          start: s(3),
          end: a[4] ?? null,
        }),
      );
    case "set_budget":
      return budget.setBudget(ledger, s(0), ymParse(s(1)), s(2));
    case "copy_budget":
      return budget.copyMonth(ledger, ymParse(s(0)), ymParse(s(1)), a[2] as boolean);
    case "remove_budget":
      return budget.removeBudget(ledger, s(0), ymParse(s(1)));
    case "check":
      return balanceChecks.record(ledger, s(0), date(1), s(2), a[3] as string | null);
    case "remove_check":
      return balanceChecks.remove(ledger, s(0));
    case "pay_installment":
      return loans.payInstallment(ledger, s(0), a[1] as number, date(2), a[3] as string | null);
    case "prepay":
      return loans.prepay(ledger, s(0), s(1), date(2), a[3] as loans.PrepaymentMode);
    case "update_loan": {
      const plan = loans.plans(ledger).get(s(0))!;
      return loans.updateLoan(ledger, { ...plan, monthly_rate: Dec.parse(s(1)) }, "renegociado");
    }
    case "mark":
      return deductibles.mark(ledger, s(0), (a[1] as deductibles.DeductibleKind | null) ?? null);
    case "request":
      return sharing.request(ledger, s(0), s(1), s(2));
    case "receive":
      return sharing.receive(ledger, s(0), s(1), s(2), date(3));
    case "deny":
      return sharing.deny(ledger, s(0), s(1));
    case "settle":
      return sharing.settle(ledger, s(0), s(1), s(2), date(3), a[4] as string | null);
    case "add_tag":
      return tags.addTag(ledger, a[0] as string[], s(1));
    case "set_tags":
      return tags.setTags(ledger, s(0), a[1] as string[]);
    case "rename_tag":
      return tags.renameTag(ledger, s(0), s(1));
    case "remove_tag":
      return tags.removeTag(ledger, a[0] as string[], s(1));
    case "name_merchant":
      return merchants.nameMerchant(ledger, s(0), s(1));
    case "remove_alias":
      return merchants.removeAlias(ledger, s(0));
    case "mark_reviewed":
      return anomalies.markReviewed(ledger, s(0), (a[1] as anomalies.SuspicionKind | null) ?? null);
    case "update_goal": {
      const goal = ledger.entities<goals.Goal>("goal").get(s(0))!;
      return goals.updateGoal(ledger, { ...goal, target: Dec.parse(s(1)) }, "nova meta");
    }
    case "save_filter":
      return savedFilters.saveFilter(ledger, savedFilters.SavedFilterSchema.parse({ name: s(0), period: s(1) }));
    case "delete_filter":
      return savedFilters.deleteFilter(ledger, s(0));
    case "settings":
      return settings.updateSettings(ledger, a[0] as Partial<settings.VaultSettings>);
    case "installments":
      return cards.recordInstallmentPurchase(
        ledger,
        s(0),
        s(1),
        s(2),
        date(3),
        s(4),
        a[5] as number,
        a[6] as cards.CompetencePolicy,
      );
  }
  throw new Error(cmd);
}

describe("planning golden: pure functions", () => {
  it("annual to monthly rate", () => {
    for (const c of G.pure.annual_to_monthly) {
      try {
        expect({ in: c.in, ok: loans.annualToMonthly(c.in).toString() }).toEqual(c);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        expect({ in: c.in, error: error.message }).toEqual(c);
      }
    }
  });

  it("due dates", () => {
    for (const [d0, k, expected] of G.pure.due_date)
      expect(loans.dueDate(d0 as IsoDate, k), `${d0} ${k}`).toBe(expected);
  });

  it("schedules of synthetic plans", () => {
    for (const c of G.pure.schedules) {
      const plan = loans.LoanPlanSchema.parse(c.plan);
      expect(dump(plan)).toEqual(c.plan);
      const extra = c.extra.map(([k, v, m]) => [k, Dec.parse(v), m as loans.PrepaymentMode] as const);
      let result: unknown;
      try {
        result = { ok: py(loans.schedule(plan, extra)) };
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        result = { error: error.message };
      }
      expect(result, JSON.stringify(c.extra)).toEqual(c.result);
    }
    const bad = loans.LoanPlanSchema.parse(G.pure.bad.plan);
    expect(() => loans.schedule(bad)).toThrow(G.pure.bad.error);
  });
});

describe.each(G.scenarios)("planning golden (seed $seed)", (s) => {
  const known = new Set([...s.records.map((r) => r.id), ...uuidsIn(s.records.map((r) => r.payload))]);

  it("round-trips the records exactly", () => {
    const ledger = Ledger.fromRecords(s.records);
    const key = (r: LedgerRecord) => `${r.kind}:${r.id}`;
    const back = ledger.toRecords().map((r) => ({ id: r.id, kind: r.kind, payload: r.payload }));
    expect([...back].sort((x, y) => cmpStr(key(x), key(y)))).toEqual(
      [...s.records].sort((x, y) => cmpStr(key(x), key(y))),
    );
  });

  it("queries give the same results", () => {
    const ledger = Ledger.fromRecords(s.records);
    const q = queriesOf(ledger, s.names);
    for (const [name, expected] of Object.entries(s.queries)) {
      expect(anon(q[name], known, new Map()), name).toEqual(expected);
    }
    expect(Object.keys(q).sort()).toEqual(Object.keys(s.queries).sort());
  });

  it("commands give the same results, and queries after them too", () => {
    const ledger = Ledger.fromRecords(s.records);
    const seen = new Map<string, string>();
    s.commands.forEach((c, i) => {
      let result: unknown;
      try {
        result = { ok: anon(py(run(ledger, c.cmd, c.args)), known, seen) };
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        result = { error: error.message };
      }
      expect(result, `${i} ${c.cmd} ${JSON.stringify(c.args)}`).toEqual(s.results[i]);
    });
    const q = queriesOf(ledger, s.names);
    for (const [name, expected] of Object.entries(s.after)) {
      expect(anon(q[name], known, seen), name).toEqual(expected);
    }
    expect(ledger.rowCounts()).toEqual(s.row_counts);
  });
});
