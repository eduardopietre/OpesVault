/**
 * Subscriptions and fixed bills: what they cost per year and when their price changed
 * (docs/09 §1.3 E). Port of `domain/subscriptions.py`.
 *
 * Registered recurrences give the yearly cost; the operations linked to them show the price
 * actually charged. Charges that repeat month after month with the same description and no
 * recurrence are offered as candidates: the user decides whether to register them.
 */
import { dayOf, type IsoDate, ym, ymAdd, ymEq, ymLt, ymOf, type YearMonth } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { cmpKeys, sortedBy } from "../lib/text.ts";
import { normalize } from "../importing/rules.ts";
import { chargeOf, median } from "./anomalies.ts";
import type { Ledger } from "./ledger.ts";
import { AccountType, cashDate, type Operation } from "./model.ts";
import { roundMoney, ZERO } from "./money.ts";
import { ForecastDecision, Frequency, links, type RecurrenceRule, rules } from "./recurrence.ts";

export const PER_YEAR: Readonly<Record<Frequency, number>> = { monthly: 12, weekly: 52, yearly: 1 };
export const CANDIDATE_MONTHS = 3; // months in a row with the same charge before suggesting it
export const CANDIDATE_SPREAD = Dec.from("0.15"); // charges may vary 15% around the typical value

export class Commitment {
  readonly rule: RecurrenceRule;
  readonly perYear: Dec;
  /** The latest realized value, or null when never linked. */
  readonly lastPaid: Dec | null;
  readonly lastPaidOn: IsoDate | null;
  readonly previousPaid: Dec | null;

  constructor(
    rule: RecurrenceRule,
    perYear: Dec,
    lastPaid: Dec | null,
    lastPaidOn: IsoDate | null,
    previousPaid: Dec | null,
  ) {
    this.rule = rule;
    this.perYear = perYear;
    this.lastPaid = lastPaid;
    this.lastPaidOn = lastPaidOn;
    this.previousPaid = previousPaid;
  }

  /** The latest charge differs from the expected value (beyond the tolerance) or from the one before. */
  get priceChanged(): boolean {
    if (this.lastPaid === null) return false;
    if (this.lastPaid.sub(this.rule.amount).abs().gt(this.rule.tolerance)) return true;
    return this.previousPaid !== null && !this.previousPaid.eq(this.lastPaid);
  }
}

function paidValue(rule: RecurrenceRule, op: Operation): Dec {
  return Dec.sum(
    op.postings.filter((p) => p.account_id === rule.counterpart_id).map((p) => p.amount),
    ZERO,
  ).abs();
}

/** Active expense recurrences, most expensive per year first. */
export function commitments(ledger: Ledger): Commitment[] {
  const paid = new Map<Id, [IsoDate, Dec][]>();
  const allRules = rules(ledger);
  for (const link of links(ledger).values()) {
    if (link.decision !== ForecastDecision.REALIZED || link.operation_id === null) continue;
    const rule = allRules.get(link.rule_id);
    const op = ledger.operations.get(link.operation_id);
    if (rule === undefined || op === undefined || op.status !== "active") continue;
    const list = paid.get(rule.id);
    const entry: [IsoDate, Dec] = [link.due_on, paidValue(rule, op)];
    if (list === undefined) paid.set(rule.id, [entry]);
    else list.push(entry);
  }
  const out: Commitment[] = [];
  for (const rule of allRules.values()) {
    const counterpart = ledger.accounts.get(rule.counterpart_id);
    if (rule.paused || counterpart === undefined || counterpart.type !== AccountType.EXPENSE) continue;
    const history = [...(paid.get(rule.id) ?? [])].sort((a, b) => cmpKeys(a, b));
    const last = history.length ? history[history.length - 1]! : null;
    const previous = history.length > 1 ? history[history.length - 2]! : null;
    out.push(
      new Commitment(
        rule,
        rule.amount.mul(PER_YEAR[rule.frequency]),
        last ? last[1] : null,
        last ? last[0] : null,
        previous ? previous[1] : null,
      ),
    );
  }
  return sortedBy(out, (c) => c.perYear, true);
}

export function yearlyTotal(ledger: Ledger): Dec {
  return Dec.sum(
    commitments(ledger).map((c) => c.perYear),
    ZERO,
  );
}

export interface Candidate {
  /** As it appears in the latest charge. */
  readonly description: string;
  /** The latest charge. */
  readonly amount: Dec;
  readonly day: number;
  /** Bank account or card liability it is charged to. */
  readonly accountId: Id;
  readonly categoryId: Id;
  /** Consecutive months found. */
  readonly months: number;
  readonly lastOn: IsoDate;
}

/** Python's `statistics.median` over whole numbers (the mean of the middle two is a float). */
function medianInt(values: readonly number[]): number {
  const data = [...values].sort((a, b) => a - b);
  const i = Math.floor(data.length / 2);
  return data.length % 2 === 1 ? data[i]! : (data[i - 1]! + data[i]!) / 2;
}

/**
 * Charges that look recurring (same description, similar value, consecutive months) and have no
 * recurrence. Python's `candidates(..., today=None)` used `date.today()`; here `today` is explicit.
 */
export function candidates(ledger: Ledger, today: IsoDate): Candidate[] {
  const oldest = ymAdd(ymOf(today), -12);
  const groups = new Map<string, [IsoDate, Operation, readonly [Id, Id, Dec]][]>();
  for (const op of ledger.activeOperations()) {
    const when = op.occurred_on ?? cashDate(op);
    if (when === null || ymLt(ymOf(when), oldest) || when > today || op.forecast_id !== null) continue;
    const found = chargeOf(ledger, op);
    if (found !== null) {
      const key = normalize(op.description);
      const list = groups.get(key);
      if (list === undefined) groups.set(key, [[when, op, found]]);
      else list.push([when, op, found]);
    }
  }
  const registered = new Set([...rules(ledger).values()].map((r) => normalize(r.description)));
  const out: Candidate[] = [];
  for (const [key, unsorted] of groups) {
    if (!key || registered.has(key) || [...registered].some((r) => r && (r.includes(key) || key.includes(r)))) continue;
    const entries = sortedBy(unsorted, (e) => e[0]);
    const monthKeys = [...new Set(entries.map((e) => e[0].slice(0, 7)))].sort();
    const months: YearMonth[] = monthKeys.map((k) => ym(Number(k.slice(0, 4)), Number(k.slice(5, 7))));
    let run = 1;
    let best = 1;
    for (let i = 1; i < months.length; i++) {
      run = ymEq(ymAdd(months[i - 1]!, 1), months[i]!) ? run + 1 : 1;
      best = Math.max(best, run);
    }
    if (best < CANDIDATE_MONTHS || ymLt(months[months.length - 1]!, ymAdd(ymOf(today), -1))) continue; // not repeating, or stopped
    const values = entries.map((e) => e[2][2]);
    const typical = median(values);
    if (values.slice(-CANDIDATE_MONTHS).some((v) => v.sub(typical).abs().gt(typical.mul(CANDIDATE_SPREAD)))) continue;
    const [lastOn, lastOp, [accountId, categoryId, value]] = entries[entries.length - 1]!;
    const days = entries.slice(-CANDIDATE_MONTHS).map((e) => dayOf(e[0]));
    out.push({
      description: lastOp.description,
      amount: roundMoney(value),
      day: Math.trunc(medianInt(days)),
      accountId,
      categoryId,
      months: best,
      lastOn,
    });
  }
  return sortedBy(out, (c) => c.amount, true);
}
