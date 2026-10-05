/**
 * Operations that look wrong: a possible duplicate charge or a value far above the category's
 * usual (docs/09 §1.3 B). Without AI, from the family's own history. Port of `domain/anomalies.py`.
 *
 * A suspicion is a question, never a change: the user checks it and either fixes the operation or
 * marks it as reviewed, which silences that question for that operation.
 */
import { z } from "zod";

import { addDays, daysBetween, formatDateBr, type IsoDate } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { zId } from "../lib/schema.ts";
import { cmpKeys, sortedBy } from "../lib/text.ts";
import { normalize } from "../importing/rules.ts";
import { Ledger } from "./ledger.ts";
import { AccountType, cashDate, type Operation, OperationKind, zEntityId } from "./model.ts";
import { formatBrl } from "./money.ts";

export const LOOKBACK_DAYS = 60; // recent operations are checked; older ones are history
export const DUPLICATE_WINDOW_DAYS = 3;
export const OUTLIER_FACTOR = Dec.from(3);
export const OUTLIER_MIN_SAMPLES = 5;

export const SuspicionKind = { DUPLICATE: "duplicate", OUTLIER: "outlier" } as const;
export type SuspicionKind = (typeof SuspicionKind)[keyof typeof SuspicionKind];

export const ReviewedSuspicionSchema = z.strictObject({
  id: zEntityId,
  operation_id: zId,
  kind: z.enum(["duplicate", "outlier"]),
});
export type ReviewedSuspicion = Readonly<z.output<typeof ReviewedSuspicionSchema>>;

Ledger.registerKind("reviewed_suspicion", ReviewedSuspicionSchema);

export interface Suspicion {
  readonly operationId: Id;
  readonly kind: SuspicionKind;
  readonly title: string;
  readonly detail: string;
  readonly on: IsoDate;
  /** Where it was charged (bank account or card liability). */
  readonly accountId: Id;
  readonly related: readonly Id[];
}

type Charge = readonly [Id, Id, Dec];

/** (charged account, category, value) of a single-category expense or card purchase. */
export function chargeOf(ledger: Ledger, op: Operation): Charge | null {
  if ((op.kind !== OperationKind.EXPENSE && op.kind !== OperationKind.CARD_PURCHASE) || op.installment !== null) {
    return null;
  }
  const categories = op.postings.filter((p) => ledger.account(p.account_id).type === AccountType.EXPENSE);
  const sources = op.postings.filter((p) => p.amount.isNegative());
  if (categories.length !== 1 || sources.length !== 1) return null;
  return [sources[0]!.account_id, categories[0]!.account_id, categories[0]!.amount];
}

function reviewed(ledger: Ledger): Set<string> {
  return new Set(
    [...ledger.entities<ReviewedSuspicion>("reviewed_suspicion").values()].map((r) => `${r.operation_id}|${r.kind}`),
  );
}

/**
 * Python's `statistics.median` over decimals: the middle value, or the mean of the two middle
 * values (a decimal division by 2).
 */
export function median(values: readonly Dec[]): Dec {
  const data = [...values].sort((a, b) => a.cmp(b));
  const n = data.length;
  if (n === 0) throw new RangeError("no median for empty data");
  const i = Math.floor(n / 2);
  return n % 2 === 1 ? data[i]! : data[i - 1]!.add(data[i]!).div(2);
}

/**
 * Cached per ledger state: the inspector asks on every selection.
 * Python's `suspicions(..., today=None)` used `date.today()`; here `today` is explicit.
 */
export function suspicions(ledger: Ledger, today: IsoDate): Suspicion[] {
  return ledger.cached(`anomalies.suspicions:${today}`, () => find(ledger, today));
}

/** "10/03" (Python's `%d/%m`). */
function dayMonth(d: IsoDate): string {
  return formatDateBr(d).slice(0, 5);
}

/**
 * Duplicates among recent charges; outliers against the category's usual value in the year
 * before the checked period (one median per category, so 50 thousand operations stay fast).
 */
function find(ledger: Ledger, today: IsoDate): Suspicion[] {
  const since = addDays(today, -LOOKBACK_DAYS);
  const yearBefore = addDays(since, -365);
  const seen = reviewed(ledger);
  const recent: [IsoDate, Operation, Charge][] = [];
  const usual = new Map<Id, Dec[]>();
  for (const op of ledger.activeOperations()) {
    const when = op.occurred_on ?? cashDate(op);
    if (when === null || when < yearBefore || when > today) continue;
    const found = chargeOf(ledger, op);
    if (found === null) continue;
    if (when < since) {
      const list = usual.get(found[1]);
      if (list === undefined) usual.set(found[1], [found[2]]);
      else list.push(found[2]);
    }
    if (when >= addDays(since, -DUPLICATE_WINDOW_DAYS)) recent.push([when, op, found]);
  }
  const out: Suspicion[] = [];
  // Keyed like Python's dict with a Decimal in the key: equal values (10.0 and 10.00) share a group,
  // and the group keeps the first value seen.
  const groups = new Map<string, { account: Id; value: Dec; entries: [IsoDate, Operation][] }>();
  for (const [when, op, [account, , value]] of recent) {
    const key = `${account}|${value.normalize().toString()}|${normalize(op.description)}`;
    let group = groups.get(key);
    if (group === undefined) groups.set(key, (group = { account, value, entries: [] }));
    group.entries.push([when, op]);
  }
  for (const { account, value, entries } of groups.values()) {
    entries.sort((a, b) => cmpKeys([a[0], a[1].id], [b[0], b[1].id]));
    for (let i = 1; i < entries.length; i++) {
      const [firstOn, first] = entries[i - 1]!;
      const [secondOn, second] = entries[i]!;
      if (secondOn < since || daysBetween(secondOn, firstOn) > DUPLICATE_WINDOW_DAYS) continue;
      if (seen.has(`${second.id}|${SuspicionKind.DUPLICATE}`)) continue;
      out.push({
        operationId: second.id,
        kind: SuspicionKind.DUPLICATE,
        title: `Possível cobrança duplicada: ${second.description}`,
        detail: `${formatBrl(value)} em ${dayMonth(firstOn)} e em ${dayMonth(secondOn)}`,
        on: secondOn,
        accountId: account,
        related: [first.id],
      });
    }
  }
  const typical = new Map<Id, Dec>();
  for (const [category, values] of usual)
    if (values.length >= OUTLIER_MIN_SAMPLES) typical.set(category, median(values));
  for (const [when, op, [account, category, value]] of recent) {
    const reference = typical.get(category);
    if (when < since || seen.has(`${op.id}|${SuspicionKind.OUTLIER}`) || reference === undefined) continue;
    if (reference.isPositive() && value.gt(reference.mul(OUTLIER_FACTOR))) {
      const name = ledger.account(category).name;
      out.push({
        operationId: op.id,
        kind: SuspicionKind.OUTLIER,
        title: `Valor fora do comum: ${op.description}`,
        detail: `${formatBrl(value)} em ${name}, onde o usual é ${formatBrl(reference)}; confira se não houve erro`,
        on: when,
        accountId: account,
        related: [],
      });
    }
  }
  return sortedBy(out, (s) => s.on, true);
}

/** 'Está certo': silences the question(s) about this operation. Returns how many were silenced. */
export function markReviewed(ledger: Ledger, operationId: Id, kind: SuspicionKind | null = null): number {
  const kinds = kind !== null ? [kind] : Object.values(SuspicionKind);
  const seen = reviewed(ledger);
  let added = 0;
  for (const k of kinds) {
    if (!seen.has(`${operationId}|${k}`)) {
      ledger.put("reviewed_suspicion", ReviewedSuspicionSchema.parse({ operation_id: operationId, kind: k }));
      added += 1;
    }
  }
  return added;
}

export function ofOperation(ledger: Ledger, operationId: Id, today: IsoDate): Suspicion[] {
  return suspicions(ledger, today).filter((s) => s.operationId === operationId);
}
