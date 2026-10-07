/**
 * Recurring rules and forecasts (RF-11, docs/04 §3). Port of `domain/recurrence.py`.
 *
 * Forecasts are not realized records: they never change balances. A realized forecast is linked
 * to the actual operation and stops counting as pending (TA-17).
 */
import { z } from "zod";

import { addDays, daysBetween, daysInMonth, type IsoDate, makeDate, ymAdd, ymFirstDay, ymOf } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { KeyError } from "../lib/py.ts";
import { zDate, zDec, zId } from "../lib/schema.ts";
import { sortedBy } from "../lib/text.ts";
import { getOrThrow } from "./error.ts";
import { DomainError, Ledger } from "./ledger.ts";
import { AccountType, cashDate, type Operation, zEntityId } from "./model.ts";
import { ZERO } from "./money.ts";

export const Frequency = { MONTHLY: "monthly", YEARLY: "yearly", WEEKLY: "weekly" } as const;
export type Frequency = (typeof Frequency)[keyof typeof Frequency];

export const RecurrenceRuleSchema = z.strictObject({
  id: zEntityId,
  description: z.string().min(1).max(200),
  account_id: zId, // where the money lands or leaves (bank account or card)
  counterpart_id: zId, // category or other account
  amount: zDec, // expected value, positive
  tolerance: zDec.default(() => Dec.from("0")), // accepted difference when matching
  frequency: z.enum(["monthly", "yearly", "weekly"]).default(Frequency.MONTHLY),
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
  return ledger.put("recurrence_rule", rule);
}

export function updateRule(ledger: Ledger, rule: RecurrenceRule, reason: string): RecurrenceRule {
  if (!rules(ledger).has(rule.id)) throw new DomainError("Regra inexistente.");
  return ledger.put("recurrence_rule", rule, { reason });
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
    const step = rule.frequency === Frequency.YEARLY ? 12 : 1;
    let month = ymOf(rule.start);
    while (ymFirstDay(month) <= end) {
      const day = Math.min(rule.day, daysInMonth(month.year, month.month));
      const when = makeDate(month.year, month.month, day);
      if (when >= rule.start && start <= when && when <= end) dates.push(when);
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
    const when = cashDate(op) ?? op.occurred_on;
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
