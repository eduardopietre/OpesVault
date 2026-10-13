/**
 * Recurring rules and forecasts (RF-11, docs/04 §3). Port of `domain/recurrence.py`.
 *
 * Forecasts are not realized records: they never change balances. A realized forecast is linked
 * to the actual operation and stops counting as pending (TA-17).
 */
import { z } from "zod";

import {
  addDays,
  daysBetween,
  daysInMonth,
  type IsoDate,
  makeDate,
  weekday,
  type YearMonth,
  ymAdd,
  ymFirstDay,
  ymOf,
} from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { KeyError } from "../lib/py.ts";
import { zDate, zDec, zId } from "../lib/schema.ts";
import { sortedBy } from "../lib/text.ts";
import { getOrThrow } from "./error.ts";
import { DomainError, Ledger } from "./ledger.ts";
import { AccountType, cashDate, type Operation, zEntityId } from "./model.ts";
import { ZERO } from "./money.ts";

/**
 * How a rule repeats (schema 3 added the last four). `semimonthly` (quinzenal) is twice a month: on `day` and
 * 15 days apart in the same month (5 and 20; 16 and 1), the later one clamped to the month's end, so a year
 * has exactly 24. `quarterly` is every 3 months and `every_n_months` every `interval_months` months, both on
 * `day` from the start month. `last_business_day` is the last Monday-to-Friday of each month: there is no
 * holiday calendar, so a holiday on that day is not skipped.
 */
export const Frequency = {
  MONTHLY: "monthly",
  YEARLY: "yearly",
  WEEKLY: "weekly",
  SEMIMONTHLY: "semimonthly",
  QUARTERLY: "quarterly",
  EVERY_N_MONTHS: "every_n_months",
  LAST_BUSINESS_DAY: "last_business_day",
} as const;
export type Frequency = (typeof Frequency)[keyof typeof Frequency];
const FREQUENCIES = Object.values(Frequency) as [Frequency, ...Frequency[]];

/** Bounds of `interval_months` (an `every_n_months` rule). */
export const MIN_INTERVAL_MONTHS = 2;
export const MAX_INTERVAL_MONTHS = 60;

export const RecurrenceRuleSchema = z.strictObject({
  id: zEntityId,
  description: z.string().min(1).max(200),
  account_id: zId, // where the money lands or leaves (bank account or card)
  counterpart_id: zId, // category or other account
  amount: zDec, // expected value, positive
  tolerance: zDec.default(() => Dec.from("0")), // accepted difference when matching
  frequency: z.enum(FREQUENCIES).default(Frequency.MONTHLY),
  // months between occurrences of an `every_n_months` rule; null for every other frequency (schema 3)
  interval_months: z.number().int().min(MIN_INTERVAL_MONTHS).max(MAX_INTERVAL_MONTHS).nullable().default(null),
  day: z.number().int().min(1).max(31),
  start: zDate,
  end: zDate.nullable().default(null),
  paused: z.boolean().default(false),
  skipped: z.array(zDate).readonly().default([]),
  window_days: z.number().int().min(0).max(31).default(5),
});
export type RecurrenceRule = Readonly<z.output<typeof RecurrenceRuleSchema>>;

export const ForecastDecision = { REALIZED: "realized", SKIPPED: "skipped" } as const;
export type ForecastDecision = (typeof ForecastDecision)[keyof typeof ForecastDecision];

export const ForecastLinkSchema = z.strictObject({
  id: zEntityId,
  rule_id: zId,
  due_on: zDate,
  decision: z.enum(["realized", "skipped"]),
  operation_id: zId.nullable().default(null),
});
export type ForecastLink = Readonly<z.output<typeof ForecastLinkSchema>>;

Ledger.registerKind("recurrence_rule", RecurrenceRuleSchema);
Ledger.registerKind("forecast_link", ForecastLinkSchema);

export function rules(ledger: Ledger) {
  return ledger.entities<RecurrenceRule>("recurrence_rule");
}

export function links(ledger: Ledger) {
  return ledger.entities<ForecastLink>("forecast_link");
}

export function addRule(ledger: Ledger, rule: RecurrenceRule): RecurrenceRule {
  if (!ledger.accounts.has(rule.account_id) || !ledger.accounts.has(rule.counterpart_id)) {
    throw new DomainError("Conta ou categoria inexistente.");
  }
  if (!rule.amount.isPositive()) throw new DomainError("Informe um valor esperado positivo.");
  if (rule.end !== null && rule.end < rule.start) throw new DomainError("Fim antes do início.");
  checkInterval(rule);
  return ledger.put("recurrence_rule", rule);
}

export function updateRule(ledger: Ledger, rule: RecurrenceRule, reason: string): RecurrenceRule {
  if (!rules(ledger).has(rule.id)) throw new DomainError("Regra inexistente.");
  checkInterval(rule);
  return ledger.put("recurrence_rule", rule, { reason });
}

/** An `every_n_months` rule says how many months; no other frequency has an interval. */
function checkInterval(rule: RecurrenceRule): void {
  if (rule.frequency === Frequency.EVERY_N_MONTHS) {
    if (rule.interval_months === null) throw new DomainError("Informe a cada quantos meses a recorrência se repete.");
  } else if (rule.interval_months !== null) {
    throw new DomainError("Só a frequência “a cada N meses” tem intervalo em meses.");
  }
}

/**
 * Deletes a rule with its decided forecasts (realized or skipped). The operations that realized it stay as
 * they are, still marked as coming from a commitment (`forecast_id`): they happened.
 */
export function removeRule(ledger: Ledger, ruleId: Id): void {
  if (!rules(ledger).has(ruleId)) throw new DomainError("Regra inexistente.");
  const decided = links(ledger);
  for (const link of [...decided.values()]) if (link.rule_id === ruleId) decided.delete(link.id);
  rules(ledger).delete(ruleId);
}

/** Months between two occurrences of a month-based rule. */
function monthStep(rule: RecurrenceRule): number {
  switch (rule.frequency) {
    case Frequency.YEARLY:
      return 12;
    case Frequency.QUARTERLY:
      return 3;
    case Frequency.EVERY_N_MONTHS:
      return rule.interval_months ?? 1;
    default:
      return 1;
  }
}

/** The last Monday-to-Friday of a month. Holidays are not known: one on that day still counts. */
export function lastBusinessDay(month: YearMonth): IsoDate {
  let when = makeDate(month.year, month.month, daysInMonth(month.year, month.month));
  while (weekday(when) >= 5) when = addDays(when, -1);
  return when;
}

/** The dates a month-based rule falls on within one month, in order. */
function datesIn(rule: RecurrenceRule, month: YearMonth): IsoDate[] {
  const last = daysInMonth(month.year, month.month);
  if (rule.frequency === Frequency.LAST_BUSINESS_DAY) return [lastBusinessDay(month)];
  if (rule.frequency === Frequency.SEMIMONTHLY) {
    const [first, second] = rule.day <= 15 ? [rule.day, rule.day + 15] : [rule.day - 15, rule.day];
    return [makeDate(month.year, month.month, first), makeDate(month.year, month.month, Math.min(second, last))];
  }
  return [makeDate(month.year, month.month, Math.min(rule.day, last))];
}

/** +1 when money enters `account_id`, −1 when it leaves. */
export function direction(ledger: Ledger, rule: RecurrenceRule): 1 | -1 {
  const counterpart = ledger.account(rule.counterpart_id);
  return counterpart.type === AccountType.INCOME ? 1 : -1;
}

export function occurrences(rule: RecurrenceRule, start: IsoDate, end: IsoDate): IsoDate[] {
  const dates: IsoDate[] = [];
  if (rule.frequency === Frequency.WEEKLY) {
    let cursor = rule.start;
    while (cursor <= end) {
      if (cursor >= start) dates.push(cursor);
      cursor = addDays(cursor, 7);
    }
  } else {
    const step = monthStep(rule);
    let month = ymOf(rule.start);
    while (ymFirstDay(month) <= end) {
      for (const when of datesIn(rule, month)) {
        if (when >= rule.start && start <= when && when <= end) dates.push(when);
      }
      month = ymAdd(month, step);
    }
  }
  return dates.filter((d) => (rule.end === null || d <= rule.end) && !rule.skipped.includes(d));
}

export const ForecastStatus = { PENDING: "pending", REALIZED: "realized", SKIPPED: "skipped", LATE: "late" } as const;
export type ForecastStatus = (typeof ForecastStatus)[keyof typeof ForecastStatus];

export interface Forecast {
  readonly ruleId: Id;
  readonly dueOn: IsoDate;
  /** Signed from the account's perspective. */
  readonly amount: Dec;
  readonly description: string;
  readonly status: ForecastStatus;
  readonly operationId: Id | null;
}

/** Python's `forecasts(..., today=None)` used `date.today()`; here `today` is explicit. */
export function forecasts(ledger: Ledger, start: IsoDate, end: IsoDate, today: IsoDate): Forecast[] {
  const decided = new Map<string, ForecastLink>();
  for (const link of links(ledger).values()) decided.set(`${link.rule_id}|${link.due_on}`, link);
  const out: Forecast[] = [];
  for (const rule of rules(ledger).values()) {
    if (rule.paused) continue;
    const sign = direction(ledger, rule);
    const amount = Dec.from(sign).mul(rule.amount);
    for (const when of occurrences(rule, start, end)) {
      const link = decided.get(`${rule.id}|${when}`);
      if (link !== undefined) {
        const status = link.decision === ForecastDecision.REALIZED ? ForecastStatus.REALIZED : ForecastStatus.SKIPPED;
        out.push({
          ruleId: rule.id,
          dueOn: when,
          amount,
          description: rule.description,
          status,
          operationId: link.operation_id,
        });
      } else {
        const status = addDays(when, rule.window_days) < today ? ForecastStatus.LATE : ForecastStatus.PENDING;
        out.push({ ruleId: rule.id, dueOn: when, amount, description: rule.description, status, operationId: null });
      }
    }
  }
  return sortedBy(out, (f) => f.dueOn);
}

function opValueOn(op: Operation, accountId: Id): Dec {
  return Dec.sum(
    op.postings.filter((p) => p.account_id === accountId).map((p) => p.amount),
    ZERO,
  );
}

/**
 * Operations that may realize a forecast: same accounts, value within tolerance, date in window.
 * The user confirms; nothing is linked automatically (docs/05 §6).
 */
export function candidates(ledger: Ledger, forecast: Forecast): Operation[] {
  const rule = rules(ledger).get(forecast.ruleId);
  if (rule === undefined) throw new KeyError(forecast.ruleId);
  const linkedOps = new Set<Id>();
  for (const link of links(ledger).values()) if (link.operation_id) linkedOps.add(link.operation_id);
  const out: Operation[] = [];
  for (const op of ledger.activeOperations()) {
    if (linkedOps.has(op.id)) continue;
    const when = cashDate(op);
    if (when === null || Math.abs(daysBetween(when, forecast.dueOn)) > rule.window_days) continue;
    const accounts = new Set(op.postings.map((p) => p.account_id));
    if (!accounts.has(rule.account_id) || !accounts.has(rule.counterpart_id)) continue;
    const value = opValueOn(op, rule.account_id);
    const account = ledger.account(rule.account_id);
    const natural = account.type === AccountType.ASSET ? value : value.negate();
    if (natural.sub(forecast.amount).abs().lte(rule.tolerance)) out.push(op);
  }
  return out;
}

export function realize(ledger: Ledger, ruleId: Id, dueOn: IsoDate, operationId: Id): ForecastLink {
  for (const link of links(ledger).values()) {
    if (link.rule_id === ruleId && link.due_on === dueOn) throw new DomainError("Previsão já resolvida.");
  }
  const op = getOrThrow(ledger.operations, operationId, "Operação inexistente.");
  ledger.updateOperation({ ...op, forecast_id: ruleId }, "realiza previsão recorrente");
  return ledger.put(
    "forecast_link",
    ForecastLinkSchema.parse({
      rule_id: ruleId,
      due_on: dueOn,
      decision: ForecastDecision.REALIZED,
      operation_id: operationId,
    }),
  );
}

export function skip(ledger: Ledger, ruleId: Id, dueOn: IsoDate): ForecastLink {
  return ledger.put(
    "forecast_link",
    ForecastLinkSchema.parse({ rule_id: ruleId, due_on: dueOn, decision: ForecastDecision.SKIPPED }),
  );
}

/**
 * Pending forecasts with exactly one candidate: offered to the user as one-click links.
 * `today` only decides whether each forecast reads as pending or late (Python: `date.today()`).
 */
export function autoSuggestions(ledger: Ledger, start: IsoDate, end: IsoDate, today: IsoDate): [Forecast, Operation][] {
  const out: [Forecast, Operation][] = [];
  for (const forecast of forecasts(ledger, start, end, today)) {
    if (forecast.status === ForecastStatus.PENDING || forecast.status === ForecastStatus.LATE) {
      const found = candidates(ledger, forecast);
      if (found.length === 1) out.push([forecast, found[0]!]);
    }
  }
  return out;
}
