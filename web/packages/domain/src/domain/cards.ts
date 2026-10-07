/**
 * Card bills (faturas) and installment plans (docs/04 §5). Port of `domain/cards.py`.
 *
 * The installment calendar is a payment schedule; it is never implicitly the competence. The
 * user chooses, per purchase, whether the expense belongs to the purchase month (consumption,
 * default) or is spread over the installments.
 */
import { z } from "zod";

import {
  daysInMonth,
  type IsoDate,
  makeDate,
  ymAdd,
  ymCompare,
  ymOf,
  ymParse,
  ymStr,
  type YearMonth,
} from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { KeyError } from "../lib/py.ts";
import { zDate, zDec, zId } from "../lib/schema.ts";
import { cmpKeys } from "../lib/text.ts";
import { normalize } from "../importing/rules.ts";
import { getOrThrow } from "./error.ts";
import { DomainError, Ledger } from "./ledger.ts";
import {
  type Card,
  cashDate,
  operation,
  type Operation,
  type OperationInput,
  OperationKind,
  OperationStatus,
  zEntityId,
} from "./model.ts";
import { allocate, toDecimal, ZERO } from "./money.ts";

function clamped(year: number, month: number, day: number): IsoDate {
  return makeDate(year, month, Math.min(day, daysInMonth(year, month)));
}

/** One bill: purchases after the previous closing up to `closing` are due on `due`. */
export class Cycle {
  readonly cardId: Id;
  readonly closing: IsoDate;
  readonly due: IsoDate;

  constructor(cardId: Id, closing: IsoDate, due: IsoDate) {
    this.cardId = cardId;
    this.closing = closing;
    this.due = due;
  }

  get month(): YearMonth {
    return ymOf(this.due);
  }
}

export function cycleFor(card: Card, purchase: IsoDate): Cycle {
  const p = ymOf(purchase);
  let closing = clamped(p.year, p.month, card.closing_day);
  if (purchase > closing) {
    const nxt = ymAdd(p, 1);
    closing = clamped(nxt.year, nxt.month, card.closing_day);
  }
  const dueMonth = card.due_day > card.closing_day ? ymOf(closing) : ymAdd(ymOf(closing), 1);
  return new Cycle(card.id, closing, clamped(dueMonth.year, dueMonth.month, card.due_day));
}

export function cycleByDueMonth(card: Card, month: YearMonth): Cycle {
  const due = clamped(month.year, month.month, card.due_day);
  const closingMonth = card.due_day > card.closing_day ? month : ymAdd(month, -1);
  return new Cycle(card.id, clamped(closingMonth.year, closingMonth.month, card.closing_day), due);
}

export const CompetencePolicy = { PURCHASE: "purchase", SPREAD: "spread" } as const;
export type CompetencePolicy = (typeof CompetencePolicy)[keyof typeof CompetencePolicy];

export const InstallmentPlanSchema = z.strictObject({
  id: zEntityId,
  card_id: zId,
  description: z.string().max(500),
  purchased_on: zDate,
  total: zDec,
  amounts: z.array(zDec).readonly(),
  category_id: zId,
  policy: z.enum(["purchase", "spread"]),
  operation_ids: z.array(zId).readonly().default([]),
  first_number: z.number().int().default(1), // plans discovered mid-way (imported "03/10") start later
  count: z.number().int().min(2).max(99),
});
export type InstallmentPlan = Readonly<z.output<typeof InstallmentPlanSchema>>;

Ledger.registerKind("installment_plan", InstallmentPlanSchema);

export function plans(ledger: Ledger) {
  return ledger.entities<InstallmentPlan>("installment_plan");
}

/** Python passed explicit keywords next to `**extra`; a repeated one was a TypeError. */
const EXPLICIT = ["kind", "description", "postings", "occurred_on", "card_id", "installment"] as const;

export function recordInstallmentPurchase(
  ledger: Ledger,
  cardId: Id,
  categoryId: Id,
  total: unknown,
  on: IsoDate,
  description: string,
  count: number,
  policy: CompetencePolicy = CompetencePolicy.PURCHASE,
  extra: Partial<OperationInput> = {},
): InstallmentPlan {
  const card = getOrThrow(ledger.cards, cardId, "Cartão inexistente.");
  if (count < 2) throw new DomainError("Parcelamento exige ao menos 2 parcelas.");
  const value = toDecimal(total);
  if (!value.isPositive()) throw new DomainError("Informe um valor positivo.");
  // Equal parts; residual cents go to the first installments, explicitly (docs/06 §9).
  const amounts = allocate(
    value,
    Array.from({ length: count }, () => Dec.from(1)),
  );
  const plan = InstallmentPlanSchema.parse({
    card_id: cardId,
    description,
    purchased_on: on,
    total: value,
    amounts,
    category_id: categoryId,
    policy,
    count,
  });
  const firstCycle = cycleFor(card, on);
  const rest: Partial<OperationInput> = { ...extra };
  for (const key of EXPLICIT) if (key in rest) throw new TypeError(`multiple values for ${key}`);
  const operations: Operation[] = [];
  if (policy === CompetencePolicy.PURCHASE) {
    const cardholder = rest.cardholder_id ?? null;
    delete rest.cardholder_id;
    operations.push(
      operation({
        kind: OperationKind.CARD_PURCHASE,
        description: `${description} (${count}x)`,
        postings: [
          { account_id: categoryId, amount: value },
          { account_id: card.liability_account_id, amount: value.negate() },
        ],
        occurred_on: on,
        card_id: cardId,
        cardholder_id: cardholder || card.holder_id,
        installment: { plan_id: plan.id, number: 1, total: count },
        ...rest,
      }),
    );
  } else {
    if ("cardholder_id" in rest || "accrual_month" in rest) throw new TypeError("multiple values for a keyword");
    amounts.forEach((part, index) => {
      const month = ymAdd(firstCycle.month, index);
      operations.push(
        operation({
          kind: OperationKind.CARD_PURCHASE,
          description: `${description} (${index + 1}/${count})`,
          postings: [
            { account_id: categoryId, amount: part },
            { account_id: card.liability_account_id, amount: part.negate() },
          ],
          occurred_on: on,
          accrual_month: month,
          card_id: cardId,
          cardholder_id: card.holder_id,
          installment: { plan_id: plan.id, number: index + 1, total: count },
          ...rest,
        }),
      );
    });
  }
  for (const op of operations) {
    // all or nothing: check every part before inserting any
    ledger.validateOperation(op);
    guardNew(ledger, op);
  }
  const created = operations.map((op) => ledger.addOperation(op));
  return ledger.put("installment_plan", { ...plan, operation_ids: created.map((o) => o.id) });
}

function guardNew(ledger: Ledger, op: Operation): void {
  ledger.guardNew(op);
}

export interface ScheduledInstallment {
  readonly planId: Id;
  readonly number: number;
  readonly total: number;
  readonly amount: Dec;
  readonly cycle: Cycle;
  readonly description: string;
}

export function schedule(ledger: Ledger, plan: InstallmentPlan): ScheduledInstallment[] {
  const card = ledger.cards.get(plan.card_id);
  if (card === undefined) throw new KeyError(plan.card_id);
  const first = cycleFor(card, plan.purchased_on);
  return plan.amounts.map((part, index) => {
    const number = plan.first_number + index;
    const dueMonth = ymAdd(first.month, number - plan.first_number);
    return {
      planId: plan.id,
      number,
      total: plan.count,
      amount: part,
      cycle: cycleByDueMonth(card, dueMonth),
      description: plan.description,
    };
  });
}

export const BillStatus = {
  OPEN: "open",
  CLOSED: "closed",
  PAID: "paid",
  PARTIAL: "partially_paid",
  OVERDUE: "overdue",
} as const;
export type BillStatus = (typeof BillStatus)[keyof typeof BillStatus];

export class Bill {
  cycle: Cycle;
  /** Purchases and fees of this cycle (non-installment). */
  charges: Dec = ZERO;
  /** Scheduled installments falling in this bill. */
  installments: Dec = ZERO;
  credits: Dec = ZERO;
  payments: Dec = ZERO;
  importedTotal: Dec | null = null;
  operationIds: Id[] = [];

  constructor(cycle: Cycle) {
    this.cycle = cycle;
  }

  get total(): Dec {
    return this.charges.add(this.installments).sub(this.credits);
  }

  get remaining(): Dec {
    return this.total.sub(this.payments);
  }

  status(today: IsoDate): BillStatus {
    if (today <= this.cycle.closing) return BillStatus.OPEN;
    if (this.total.isPositive() && this.payments.gte(this.total)) return BillStatus.PAID;
    if (today > this.cycle.due) return this.payments.isZero() ? BillStatus.OVERDUE : BillStatus.PARTIAL;
    return this.payments.isPositive() ? BillStatus.PARTIAL : BillStatus.CLOSED;
  }
}

/** The bill whose period contains `paidOn`: the first due date on or after it. */
function dueMonth(card: Card, paidOn: IsoDate): YearMonth {
  const month = ymOf(paidOn);
  return paidOn <= cycleByDueMonth(card, month).due ? month : ymAdd(month, 1);
}

/**
 * Bills by due month. Installment purchases under the PURCHASE policy contribute their scheduled
 * installments, not the full value, so a bill matches the bank's document.
 *
 * Payments settle overdue bills first: a payment made on day d pays, oldest first, every bill
 * already due before d that still has a balance; only what is left goes to the bill whose period
 * contains d (decision of 02/10/2026, docs/04 §5). Because an old overdue bill can absorb a
 * recent payment, the whole card history is computed, then `months` are returned.
 */
export function bills(ledger: Ledger, cardId: Id, months: readonly YearMonth[]): Bill[] {
  const card = ledger.cards.get(cardId);
  if (card === undefined) throw new KeyError(cardId);
  const byMonth = cardHistory(ledger, cardId);
  // Months outside the card's history have no charges nor payments: an empty bill each.
  return months.map((m) => byMonth.get(ymStr(m)) ?? new Bill(cycleByDueMonth(card, m)));
}

/**
 * Every bill of the card from its first to its last movement, cached per ledger state: alerts,
 * the projection, the calendar and the bills tab all ask for the same history.
 */
function cardHistory(ledger: Ledger, cardId: Id): Map<string, Bill> {
  return ledger.cached(`cards.history:${cardId}`, () => computeHistory(ledger, cardId));
}

function computeHistory(ledger: Ledger, cardId: Id): Map<string, Bill> {
  const card = ledger.cards.get(cardId);
  if (card === undefined) throw new KeyError(cardId);
  const planOps = new Set<Id>();
  for (const p of plans(ledger).values()) if (p.card_id === cardId) for (const oid of p.operation_ids) planOps.add(oid);
  const charges: [YearMonth, Dec, Id][] = []; // (bill month, liability change, operation)
  const payments: [IsoDate, Dec, Id][] = [];
  for (const op of ledger.operations.values()) {
    if (op.status === OperationStatus.CANCELLED || op.card_id !== cardId) continue;
    const liability = Dec.sum(
      op.postings.filter((p) => p.account_id === card.liability_account_id).map((p) => p.amount),
      ZERO,
    );
    if (liability.isZero()) continue;
    if (op.kind === OperationKind.CARD_PAYMENT) {
      const cd = cashDate(op);
      if (cd !== null) payments.push([cd, liability, op.id]);
      continue;
    }
    if (planOps.has(op.id)) continue;
    const when = op.occurred_on ?? cashDate(op);
    if (when !== null) charges.push([cycleFor(card, when).month, liability, op.id]);
  }
  const scheduled: [YearMonth, Dec][] = [];
  for (const plan of plans(ledger).values()) {
    if (plan.card_id !== cardId) continue;
    for (const item of schedule(ledger, plan)) scheduled.push([item.cycle.month, item.amount]);
  }
  const involved: YearMonth[] = [
    ...charges.map(([m]) => m),
    ...scheduled.map(([m]) => m),
    ...payments.map(([d]) => dueMonth(card, d)),
  ];
  const byMonth = new Map<string, Bill>();
  if (involved.length) {
    let cursor = involved.reduce((a, b) => (ymCompare(b, a) < 0 ? b : a));
    const last = involved.reduce((a, b) => (ymCompare(b, a) > 0 ? b : a));
    // every month in between, so no overdue bill is skipped
    while (ymCompare(cursor, last) <= 0) {
      byMonth.set(ymStr(cursor), new Bill(cycleByDueMonth(card, cursor)));
      cursor = ymAdd(cursor, 1);
    }
  }
  for (const [month, liability, opId] of charges) {
    const bill = byMonth.get(ymStr(month))!;
    if (liability.isNegative()) bill.charges = bill.charges.add(liability.negate());
    else bill.credits = bill.credits.add(liability);
    bill.operationIds.push(opId);
  }
  for (const [month, amount] of scheduled) {
    const bill = byMonth.get(ymStr(month))!;
    bill.installments = bill.installments.add(amount);
  }
  const ordered = [...byMonth.keys()].sort((a, b) => ymCompare(ymParse(a), ymParse(b))).map((k) => byMonth.get(k)!);
  const sortedPayments = [...payments].sort((a, b) => cmpKeys([a[0], a[2]], [b[0], b[2]]));
  for (const [paidOn, amount, opId] of sortedPayments) {
    let left = amount;
    for (const bill of ordered) {
      if (!left.isPositive() || bill.cycle.due >= paidOn) break;
      const openBalance = bill.remaining;
      if (openBalance.isPositive()) {
        const share = Dec.min(left, openBalance);
        bill.payments = bill.payments.add(share);
        bill.operationIds.push(opId);
        left = left.sub(share);
      }
    }
    if (left.isPositive()) {
      // on time, or more than the overdue bills owed
      const own = byMonth.get(ymStr(dueMonth(card, paidOn)))!;
      own.payments = own.payments.add(left);
      own.operationIds.push(opId);
    }
  }
  return byMonth;
}

export interface ImportedPlanMatch {
  readonly planId: Id;
  readonly operationId: Id;
}

/** An imported 'PARCELA n/N' line already covered by a registered plan is not a new expense. */
export function findPlanForInstallment(
  ledger: Ledger,
  cardId: Id,
  description: string,
  number: number,
  count: number,
  amount: Dec,
): ImportedPlanMatch | null {
  const key = normalize(description);
  for (const plan of plans(ledger).values()) {
    if (plan.card_id !== cardId || plan.count !== count) continue;
    const index = number - plan.first_number;
    if (!(index >= 0 && index < plan.amounts.length) || !plan.amounts[index]!.eq(amount)) continue;
    const own = normalize(plan.description);
    if (own.includes(key) || key.includes(own)) {
      const opId = plan.operation_ids.at(Math.min(index, plan.operation_ids.length - 1));
      if (opId === undefined) throw new RangeError("tuple index out of range");
      return { planId: plan.id, operationId: opId };
    }
  }
  return null;
}
