/**
 * Projected balance per account: today's balance plus what is already known to come
 * (docs/09 §1.3 E). Port of `domain/projection.py`.
 *
 * Known future movements: pending recurrences, card bills (charges and installments already
 * registered, plus card recurrences of each cycle) paid from the card's payment account, and loan
 * installments. A projection is a forecast: it never changes balances, and what is not registered
 * (a purchase not yet made) is not guessed. Late items that may still happen are placed today.
 */
import { addDays, type IsoDate, maxDate, ymAdd, ymLte, ymOf, ymStr, type YearMonth } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { cmpStr, sortedBy } from "../lib/text.ts";
import { bills, cycleFor } from "./cards.ts";
import * as queries from "./queries.ts";
import type { Ledger } from "./ledger.ts";
import { AccountType, type Card, isLiquid } from "./model.ts";
import { upcoming } from "./loans.ts";
import { ZERO } from "./money.ts";
import { ForecastStatus, forecasts, rules } from "./recurrence.ts";

export const HORIZON_DAYS = 60;
export const ALERT_DAYS = 30; // warn when an account goes negative within this many days
export const LOOKBACK_DAYS = 31; // late items older than this are history, not projection

export interface ProjectedEvent {
  readonly on: IsoDate;
  readonly accountId: Id;
  /** Effect on the account's balance (natural sign). */
  readonly amount: Dec;
  readonly description: string;
  /** "recorrência", "fatura", "financiamento" */
  readonly source: string;
  readonly late: boolean;
}

export class AccountProjection {
  readonly accountId: Id;
  readonly start: IsoDate;
  readonly startBalance: Dec;
  events: ProjectedEvent[] = [];

  constructor(accountId: Id, start: IsoDate, startBalance: Dec) {
    this.accountId = accountId;
    this.start = start;
    this.startBalance = startBalance;
  }

  balanceOn(day: IsoDate): Dec {
    return this.startBalance.add(
      Dec.sum(
        this.events.filter((e) => e.on <= day).map((e) => e.amount),
        ZERO,
      ),
    );
  }

  daily(end: IsoDate): [IsoDate, Dec][] {
    const out: [IsoDate, Dec][] = [];
    let running = this.startBalance;
    let index = 0;
    const events = sortedBy(this.events, (e) => e.on);
    for (let day = this.start; day <= end; day = addDays(day, 1)) {
      while (index < events.length && events[index]!.on <= day) {
        running = running.add(events[index]!.amount);
        index += 1;
      }
      out.push([day, running]);
    }
    return out;
  }

  /** The lowest balance in the horizon and its first day. */
  get lowest(): [IsoDate, Dec] {
    let best: [IsoDate, Dec] = [this.start, this.startBalance];
    let running = this.startBalance;
    for (const event of sortedBy(this.events, (e) => e.on)) {
      running = running.add(event.amount);
      if (running.lt(best[1])) best = [event.on, running];
    }
    return best;
  }

  get firstNegative(): IsoDate | null {
    if (this.startBalance.isNegative()) return this.start;
    let running = this.startBalance;
    for (const event of sortedBy(this.events, (e) => e.on)) {
      running = running.add(event.amount);
      if (running.isNegative()) return event.on;
    }
    return null;
  }
}

/** Known movements between today and `end` on liquid accounts, and notes on what was left out. */
export function events(ledger: Ledger, today: IsoDate, end: IsoDate): [ProjectedEvent[], string[]] {
  const since = addDays(today, -LOOKBACK_DAYS);
  const out: ProjectedEvent[] = [];
  const notes: string[] = [];
  const cardByLiability = new Map<Id, Card>([...ledger.cards.values()].map((c) => [c.liability_account_id, c]));
  // Card recurrences (streaming on the card) enter the bill of their cycle.
  const cardExtra = new Map<string, Dec>();
  for (const forecast of forecasts(ledger, since, end, today)) {
    if (forecast.status !== ForecastStatus.PENDING && forecast.status !== ForecastStatus.LATE) continue;
    const rule = rules(ledger).get(forecast.ruleId);
    if (rule === undefined) continue;
    const account = ledger.accounts.get(rule.account_id);
    if (account === undefined) continue;
    const card = cardByLiability.get(account.id);
    if (card !== undefined) {
      if (forecast.dueOn >= today) {
        const key = `${card.id}|${ymStr(cycleFor(card, forecast.dueOn).month)}`;
        cardExtra.set(key, (cardExtra.get(key) ?? ZERO).add(forecast.amount.negate()));
      }
      continue;
    }
    if (!isLiquid(account)) continue;
    const late = forecast.dueOn < today;
    out.push({
      on: maxDate(forecast.dueOn, today),
      accountId: account.id,
      amount: forecast.amount,
      description: forecast.description,
      source: "recorrência",
      late,
    });
  }
  const months: YearMonth[] = [];
  for (let cursor = ymOf(since); ymLte(cursor, ymAdd(ymOf(end), 1)); cursor = ymAdd(cursor, 1)) months.push(cursor);
  for (const card of ledger.cards.values()) {
    const payer = card.settlement_account_id ? ledger.accounts.get(card.settlement_account_id) : undefined;
    for (const bill of bills(ledger, card.id, months)) {
      const due = bill.cycle.due;
      const extra = cardExtra.get(`${card.id}|${ymStr(bill.cycle.month)}`) ?? ZERO;
      const owed = bill.remaining.add(extra);
      if (!owed.isPositive() || !(since <= due && due <= end)) continue;
      if (payer === undefined || !isLiquid(payer)) {
        notes.push(`Fatura de ${card.name} sem conta de pagamento: fora da projeção.`);
        continue;
      }
      out.push({
        on: maxDate(due, today),
        accountId: payer.id,
        amount: owed.negate(),
        description: `Fatura ${card.name}`,
        source: "fatura",
        late: due < today,
      });
    }
  }
  for (const [plan, item] of upcoming(ledger, since, end)) {
    const account = ledger.accounts.get(plan.payment_account_id);
    if (account === undefined || !isLiquid(account)) continue;
    out.push({
      on: maxDate(item.due, today),
      accountId: account.id,
      amount: item.payment.negate(),
      description: `Parcela ${item.number} — ${plan.name}`,
      source: "financiamento",
      late: item.due < today,
    });
  }
  return [sortedBy(out, (e) => [e.on, e.description]), [...new Set(notes)].sort(cmpStr)];
}

/**
 * One projection per liquid account (or the chosen ones), from today's balance.
 * Python's `project(..., today=None)` used `date.today()`; here `today` is explicit.
 */
export function project(
  ledger: Ledger,
  today: IsoDate,
  days: number = HORIZON_DAYS,
  accounts: readonly Id[] | null = null,
): AccountProjection[] {
  const end = addDays(today, days);
  const chosen =
    accounts ??
    [...ledger.accounts.values()]
      .filter((a) => isLiquid(a) && !a.archived && a.type === AccountType.ASSET)
      .map((a) => a.id);
  const [found] = events(ledger, today, end);
  return chosen.map((accountId) => {
    const projection = new AccountProjection(accountId, today, queries.balance(ledger, accountId, today));
    projection.events = found.filter((e) => e.accountId === accountId);
    return projection;
  });
}

/** Accounts that are positive today and whose projected balance goes below zero within `days`. */
export function negativeAhead(ledger: Ledger, today: IsoDate, days: number = ALERT_DAYS): AccountProjection[] {
  const limit = addDays(today, days);
  return project(ledger, today, days).filter((projection) => {
    const first = projection.firstNegative;
    return !projection.startBalance.isNegative() && first !== null && first <= limit;
  });
}
