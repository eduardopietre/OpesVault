/**
 * Loans and financing: SAC or Price schedules, installments and early repayment
 * (docs/09 §1.3 E). Port of `domain/loans.py`.
 *
 * The plan is the contract as the family knows it (balance, monthly rate, term, first due date);
 * the schedule is computed from it, never stored. Paying an installment records a real operation
 * that splits the amount into amortization (reduces the debt), interest and fees (expenses). An
 * early repayment amortizes the debt and either shortens the term or lowers the following
 * installments, as the contract allows.
 *
 * Bank schedules may differ by cents (rounding, insurance indexed to the balance): the liability
 * account's balance in the ledger stays the authority, and the screen shows both.
 */
import { z } from "zod";

import { daysInMonth, type IsoDate, makeDate, ymAdd, ymOf } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { KeyError } from "../lib/py.ts";
import { zDate, zDec, zId } from "../lib/schema.ts";
import { sortedBy } from "../lib/text.ts";
import * as queries from "./queries.ts";
import { DomainError, Ledger } from "./ledger.ts";
import {
  AccountSubtype,
  AccountType,
  operation,
  type Operation,
  OperationKind,
  type Posting,
  zEntityId,
} from "./model.ts";
import { isCents, roundMoney, toDecimal, ZERO } from "./money.ts";

export const RATE_PLACES = Dec.from("0.0000000001");
export const MAX_TERM = 600;

export const AmortizationSystem = { PRICE: "price", SAC: "sac" } as const;
export type AmortizationSystem = (typeof AmortizationSystem)[keyof typeof AmortizationSystem];

export const SYSTEM_LABELS: Readonly<Record<AmortizationSystem, string>> = {
  price: "Price (parcelas iguais)",
  sac: "SAC (amortização constante)",
};

export const PrepaymentMode = { REDUCE_TERM: "reduce_term", REDUCE_PAYMENT: "reduce_payment" } as const;
export type PrepaymentMode = (typeof PrepaymentMode)[keyof typeof PrepaymentMode];

export const MODE_LABELS: Readonly<Record<PrepaymentMode, string>> = {
  reduce_term: "Reduzir o prazo",
  reduce_payment: "Reduzir a parcela",
};

/**
 * A plain `Decimal` field (not `Amount`): Pydantic wrote it with `str()`, so "0E-10" stays in
 * scientific form. The parsed Dec keeps that serialization.
 */
const zRate = zDec
  .refine((d) => !d.isNegative() && d.lte(1), "rate must be between 0 and 1")
  .transform((d) => {
    const copy = Dec.fromParts(d.neg, d.coef, d.exp);
    Object.defineProperty(copy, "toJSON", { value: () => copy.toString() });
    return copy;
  });

export const LoanPlanSchema = z.strictObject({
  id: zEntityId,
  name: z.string().min(1).max(120),
  liability_account_id: zId, // subtype LOAN: the debt
  payment_account_id: zId, // where installments are paid from
  interest_category_id: zId, // expense category for interest
  fees_category_id: zId.nullable().default(null), // insurance and fees charged with each installment
  principal: zDec, // balance when the schedule starts
  monthly_rate: zRate, // 0.0099 = 0,99% a.m.
  term: z.number().int().min(1).max(MAX_TERM),
  system: z.enum(["price", "sac"]),
  first_due: zDate,
  fees_per_installment: zDec.default(() => Dec.from("0")),
  version: z.number().int().default(1),
});
export type LoanPlan = Readonly<z.output<typeof LoanPlanSchema>>;

export const LoanPaymentSchema = z.strictObject({
  id: zEntityId,
  plan_id: zId,
  number: z.number().int().min(1),
  operation_id: zId,
  paid_on: zDate,
});
export type LoanPayment = Readonly<z.output<typeof LoanPaymentSchema>>;

export const LoanPrepaymentSchema = z.strictObject({
  id: zEntityId,
  plan_id: zId,
  after_number: z.number().int().min(0), // applied after this installment (0: before the first)
  amount: zDec,
  mode: z.enum(["reduce_term", "reduce_payment"]),
  paid_on: zDate,
  operation_id: zId.nullable().default(null),
});
export type LoanPrepayment = Readonly<z.output<typeof LoanPrepaymentSchema>>;

Ledger.registerKind("loan_plan", LoanPlanSchema);
Ledger.registerKind("loan_payment", LoanPaymentSchema);
Ledger.registerKind("loan_prepayment", LoanPrepaymentSchema);

export function plans(ledger: Ledger) {
  return ledger.entities<LoanPlan>("loan_plan");
}

export function payments(ledger: Ledger) {
  return ledger.entities<LoanPayment>("loan_payment");
}

export function prepayments(ledger: Ledger) {
  return ledger.entities<LoanPrepayment>("loan_prepayment");
}

/** Effective annual rate to the equivalent monthly rate: (1 + a)^(1/12) − 1. */
export function annualToMonthly(annual: unknown): Dec {
  const value = toDecimal(annual);
  if (value.isNegative()) throw new DomainError("Taxa negativa não é aceita.");
  return Dec.from(1)
    .add(value)
    .pow(Dec.from(1).div(Dec.from(12)))
    .sub(1)
    .quantize(RATE_PLACES);
}

export function dueDate(firstDue: IsoDate, number: number): IsoDate {
  const month = ymAdd(ymOf(firstDue), number - 1);
  const last = daysInMonth(month.year, month.month);
  return makeDate(month.year, month.month, Math.min(Number(firstDue.slice(8, 10)), last));
}

function pricePayment(balance: Dec, rate: Dec, count: number): Dec {
  if (count <= 0) return balance;
  if (rate.isZero()) return roundMoney(balance.div(count));
  const factor = Dec.from(1).add(rate).pow(count);
  return roundMoney(balance.mul(rate).mul(factor).div(factor.sub(1)));
}

export interface Installment {
  readonly number: number;
  readonly due: IsoDate;
  /** amortization + interest + fees */
  readonly payment: Dec;
  readonly amortization: Dec;
  readonly interest: Dec;
  readonly fees: Dec;
  /** Debt after this installment (and after a prepayment applied right after it). */
  readonly balanceAfter: Dec;
  readonly prepaidAfter: Dec;
}

export type Extra = readonly (readonly [number, Dec, PrepaymentMode])[];

/**
 * The installments of `plan`, with prepayments (after installment n, amount, mode) applied.
 *
 * Interest is charged on the outstanding balance at the monthly rate and rounded to cents (ties
 * away from zero); the last installment takes the residual so the debt ends at zero.
 */
export function schedule(plan: LoanPlan, extra: Extra | null = null): Installment[] {
  let pending = sortedBy(extra ?? [], (e) => e[0]);
  const rate = plan.monthly_rate;
  let balance = plan.principal;
  let remaining = plan.term;
  for (const [, amount] of pending.filter((e) => e[0] === 0)) balance = Dec.max(balance.sub(amount), ZERO);
  pending = pending.filter((e) => e[0] > 0);
  let payment = pricePayment(balance, rate, remaining);
  let amortization = remaining ? roundMoney(balance.div(remaining)) : balance;
  const out: Installment[] = [];
  let number = 0;
  while (balance.isPositive() && number < MAX_TERM * 2) {
    number += 1;
    const interest = roundMoney(balance.mul(rate));
    let amort: Dec;
    if (plan.system === AmortizationSystem.PRICE) {
      amort = payment.sub(interest);
      if (!amort.isPositive()) throw new DomainError("A parcela não cobre os juros: revise taxa, prazo e saldo.");
    } else {
      amort = amortization;
    }
    const last = amort.gte(balance) || remaining <= 1;
    if (last) amort = balance;
    balance = balance.sub(amort);
    remaining -= 1;
    let prepaid = ZERO;
    for (const [, amount, mode] of pending.filter((e) => e[0] === number)) {
      const cut = Dec.min(amount, balance);
      balance = balance.sub(cut);
      prepaid = prepaid.add(cut);
      if (balance.isPositive() && mode === PrepaymentMode.REDUCE_PAYMENT) {
        payment = pricePayment(balance, rate, remaining);
        amortization = remaining ? roundMoney(balance.div(remaining)) : balance;
      }
    }
    out.push({
      number,
      due: dueDate(plan.first_due, number),
      payment: amort.add(interest).add(plan.fees_per_installment),
      amortization: amort,
      interest,
      fees: plan.fees_per_installment,
      balanceAfter: balance,
      prepaidAfter: prepaid,
    });
    if (balance.isPositive() && remaining <= 0) remaining = 1; // reduce-term path never runs out; reduce-payment ends with the term
  }
  return out;
}

function extraOf(ledger: Ledger, planId: Id): [number, Dec, PrepaymentMode][] {
  return [...prepayments(ledger).values()]
    .filter((p) => p.plan_id === planId)
    .map((p) => [p.after_number, p.amount, p.mode]);
}

function planOf(ledger: Ledger, planId: Id): LoanPlan {
  const plan = plans(ledger).get(planId);
  if (plan === undefined) throw new KeyError(planId);
  return plan;
}

export function planSchedule(ledger: Ledger, planId: Id): Installment[] {
  return schedule(planOf(ledger, planId), extraOf(ledger, planId));
}

export const InstallmentState = { PAID: "paid", OVERDUE: "overdue", PENDING: "pending" } as const;
export type InstallmentState = (typeof InstallmentState)[keyof typeof InstallmentState];

export const STATE_LABELS: Readonly<Record<InstallmentState, string>> = {
  paid: "Paga",
  overdue: "Vencida",
  pending: "A vencer",
};

export function paidNumbers(ledger: Ledger, planId: Id): Map<number, LoanPayment> {
  const out = new Map<number, LoanPayment>();
  for (const payment of payments(ledger).values()) {
    const op = ledger.operations.get(payment.operation_id);
    if (payment.plan_id === planId && op !== undefined && op.status === "active") out.set(payment.number, payment);
  }
  return out;
}

export function stateOf(ledger: Ledger, planId: Id, item: Installment, today: IsoDate): InstallmentState {
  if (paidNumbers(ledger, planId).has(item.number)) return InstallmentState.PAID;
  return item.due < today ? InstallmentState.OVERDUE : InstallmentState.PENDING;
}

export interface LoanStatus {
  readonly plan: LoanPlan;
  readonly installments: Installment[];
  readonly paid: number;
  readonly overdue: number;
  readonly nextDue: Installment | null;
  /** By the schedule, after the paid installments and prepayments. */
  readonly outstanding: Dec;
  /** The liability account's balance in the ledger. */
  readonly ledgerBalance: Dec;
  readonly interestToCome: Dec;
  readonly end: IsoDate | null;
}

/** Python's `status(..., today=None)` used `date.today()`; here `today` is explicit. */
export function status(ledger: Ledger, planId: Id, today: IsoDate): LoanStatus {
  const plan = planOf(ledger, planId);
  const items = planSchedule(ledger, planId);
  const paid = paidNumbers(ledger, planId);
  const unpaid = items.filter((i) => !paid.has(i.number));
  let outstanding = plan.principal.sub(
    Dec.sum(
      items.filter((i) => paid.has(i.number)).map((i) => i.amortization.add(i.prepaidAfter)),
      ZERO,
    ),
  );
  // A prepayment made before any installment is applied to the starting balance.
  const upfront = [...prepayments(ledger).values()]
    .filter((p) => p.plan_id === planId && p.after_number === 0)
    .map((p) => p.amount);
  outstanding = outstanding.sub(Dec.sum(upfront, ZERO));
  return {
    plan,
    installments: items,
    paid: paid.size,
    overdue: unpaid.filter((i) => i.due < today).length,
    nextDue: unpaid[0] ?? null,
    outstanding: Dec.max(outstanding, ZERO),
    ledgerBalance: queries.balance(ledger, plan.liability_account_id),
    interestToCome: Dec.sum(
      unpaid.map((i) => i.interest),
      ZERO,
    ),
    end: items.length ? items[items.length - 1]!.due : null,
  };
}

function checkAccounts(ledger: Ledger, plan: LoanPlan): void {
  const liability = ledger.accounts.get(plan.liability_account_id);
  if (liability === undefined || liability.subtype !== AccountSubtype.LOAN) {
    throw new DomainError("Escolha uma conta de empréstimo ou financiamento.");
  }
  const paying = ledger.accounts.get(plan.payment_account_id);
  if (paying === undefined || paying.type !== AccountType.ASSET) {
    throw new DomainError("Escolha a conta de onde saem as parcelas.");
  }
  for (const categoryId of [plan.interest_category_id, plan.fees_category_id]) {
    if (categoryId === null) continue;
    const category = ledger.accounts.get(categoryId);
    if (category === undefined || category.type !== AccountType.EXPENSE) {
      throw new DomainError("Juros e encargos são categorias de despesa.");
    }
  }
  if (!plan.principal.isPositive() || !isCents(plan.principal)) {
    throw new DomainError("Informe o saldo devedor em reais e centavos.");
  }
  if (plan.fees_per_installment.isNegative() || !isCents(plan.fees_per_installment)) {
    throw new DomainError("Encargos por parcela inválidos.");
  }
  if (plan.fees_per_installment.isPositive() && plan.fees_category_id === null) {
    throw new DomainError("Escolha a categoria dos encargos.");
  }
}

export const Opening = {
  NONE: "none", // the debt is already in the ledger
  OPENING_BALANCE: "opening_balance", // an existing debt enters as opening balance
  DEPOSIT: "deposit", // the money was credited to an account on the start date
} as const;
export type Opening = (typeof Opening)[keyof typeof Opening];

export function createLoan(
  ledger: Ledger,
  plan: LoanPlan,
  opening: Opening = Opening.NONE,
  options: { on?: IsoDate | null; depositAccountId?: Id | null } = {},
): LoanPlan {
  checkAccounts(ledger, plan);
  schedule(plan); // rejects contracts whose installment does not cover the interest
  const when = options.on ?? plan.first_due;
  if (opening === Opening.OPENING_BALANCE) {
    ledger.recordOpeningBalance(plan.liability_account_id, plan.principal, when);
  } else if (opening === Opening.DEPOSIT) {
    const deposit = options.depositAccountId ?? null;
    if (deposit === null) throw new DomainError("Escolha a conta que recebeu o dinheiro.");
    ledger.recordTransfer(plan.liability_account_id, deposit, plan.principal, when, `Liberação — ${plan.name}`);
  }
  return ledger.put("loan_plan", plan);
}

export function updateLoan(ledger: Ledger, plan: LoanPlan, reason: string): LoanPlan {
  const current = plans(ledger).get(plan.id);
  if (current === undefined) throw new DomainError("Financiamento inexistente.");
  checkAccounts(ledger, plan);
  schedule(plan);
  return ledger.put("loan_plan", { ...plan, version: current.version + 1 }, { reason });
}

/** Records installment `number`. Paying more than scheduled (late charges) adds the difference to interest. */
export function payInstallment(
  ledger: Ledger,
  planId: Id,
  number: number,
  on: IsoDate,
  amount: unknown = null,
  fromAccount: Id | null = null,
): Operation {
  const plan = plans(ledger).get(planId);
  if (plan === undefined) throw new DomainError("Financiamento inexistente.");
  if (paidNumbers(ledger, planId).has(number)) throw new DomainError("Esta parcela já foi paga.");
  const items = new Map(planSchedule(ledger, planId).map((i) => [i.number, i]));
  const item = items.get(number);
  if (item === undefined) throw new DomainError("Parcela inexistente.");
  const value = amount === null || amount === undefined ? item.payment : toDecimal(amount);
  if (value.lt(item.payment)) {
    throw new DomainError("O valor pago é menor que a parcela. Pagamento parcial não é registrado como parcela.");
  }
  const interest = item.interest.add(value.sub(item.payment));
  const source = fromAccount || plan.payment_account_id;
  const postings: Posting[] = [{ account_id: plan.liability_account_id, amount: item.amortization, member_id: null }];
  if (interest.isPositive())
    postings.push({ account_id: plan.interest_category_id, amount: interest, member_id: null });
  if (item.fees.isPositive() && plan.fees_category_id !== null) {
    postings.push({ account_id: plan.fees_category_id, amount: item.fees, member_id: null });
  }
  postings.push({ account_id: source, amount: value.negate(), member_id: null });
  const op = ledger.addOperation(
    operation({
      kind: OperationKind.OTHER,
      description: `Parcela ${number}/${items.size} — ${plan.name}`,
      postings,
      occurred_on: on,
      settled_on: on,
      due_on: item.due,
      accrual_month: ymOf(item.due),
    }),
  );
  ledger.put("loan_payment", LoanPaymentSchema.parse({ plan_id: planId, number, operation_id: op.id, paid_on: on }));
  return op;
}

/** Early repayment: the whole amount amortizes the debt (no interest), after the last paid installment. */
export function prepay(
  ledger: Ledger,
  planId: Id,
  amount: unknown,
  on: IsoDate,
  mode: PrepaymentMode,
  fromAccount: Id | null = null,
): LoanPrepayment {
  const plan = plans(ledger).get(planId);
  if (plan === undefined) throw new DomainError("Financiamento inexistente.");
  const value = toDecimal(amount);
  if (!value.isPositive() || !isCents(value)) throw new DomainError("Informe um valor positivo em reais e centavos.");
  const current = status(ledger, planId, on);
  if (value.gt(current.outstanding)) throw new DomainError("O valor passa do saldo devedor.");
  const after = Math.max(0, ...paidNumbers(ledger, planId).keys());
  const op = ledger.addOperation(
    operation({
      kind: OperationKind.OTHER,
      description: `Amortização antecipada — ${plan.name}`,
      postings: [
        { account_id: plan.liability_account_id, amount: value },
        { account_id: fromAccount || plan.payment_account_id, amount: value.negate() },
      ],
      occurred_on: on,
      settled_on: on,
    }),
  );
  return ledger.put(
    "loan_prepayment",
    LoanPrepaymentSchema.parse({
      plan_id: planId,
      after_number: after,
      amount: value,
      mode,
      paid_on: on,
      operation_id: op.id,
    }),
  );
}

export class PrepaymentSimulation {
  readonly amount: Dec;
  readonly mode: PrepaymentMode;
  /** Interest still to pay without the prepayment. */
  readonly interestBefore: Dec;
  readonly interestAfter: Dec;
  /** Unpaid installments. */
  readonly installmentsBefore: number;
  readonly installmentsAfter: number;
  readonly nextPaymentBefore: Dec | null;
  readonly nextPaymentAfter: Dec | null;

  constructor(
    amount: Dec,
    mode: PrepaymentMode,
    interestBefore: Dec,
    interestAfter: Dec,
    installmentsBefore: number,
    installmentsAfter: number,
    nextPaymentBefore: Dec | null,
    nextPaymentAfter: Dec | null,
  ) {
    this.amount = amount;
    this.mode = mode;
    this.interestBefore = interestBefore;
    this.interestAfter = interestAfter;
    this.installmentsBefore = installmentsBefore;
    this.installmentsAfter = installmentsAfter;
    this.nextPaymentBefore = nextPaymentBefore;
    this.nextPaymentAfter = nextPaymentAfter;
  }

  get interestSaved(): Dec {
    return this.interestBefore.sub(this.interestAfter);
  }
}

/** What an early repayment now would save. A simulation: nothing is recorded. */
export function simulatePrepayment(
  ledger: Ledger,
  planId: Id,
  amount: unknown,
  mode: PrepaymentMode,
): PrepaymentSimulation {
  const plan = planOf(ledger, planId);
  const value = toDecimal(amount);
  if (!value.isPositive()) throw new DomainError("Informe um valor positivo.");
  const paid = paidNumbers(ledger, planId);
  const after = Math.max(0, ...paid.keys());
  const current = extraOf(ledger, planId);
  const before = schedule(plan, current).filter((i) => !paid.has(i.number));
  const later = schedule(plan, [...current, [after, value, mode]]).filter((i) => !paid.has(i.number));
  return new PrepaymentSimulation(
    value,
    mode,
    Dec.sum(
      before.map((i) => i.interest),
      ZERO,
    ),
    Dec.sum(
      later.map((i) => i.interest),
      ZERO,
    ),
    before.length,
    later.length,
    before.length ? before[0]!.payment : null,
    later.length ? later[0]!.payment : null,
  );
}

/** Unpaid installments due between `start` and `end` (projection and calendar). */
export function upcoming(ledger: Ledger, start: IsoDate, end: IsoDate): [LoanPlan, Installment][] {
  const out: [LoanPlan, Installment][] = [];
  for (const plan of plans(ledger).values()) {
    const paid = paidNumbers(ledger, plan.id);
    for (const item of planSchedule(ledger, plan.id)) {
      if (!paid.has(item.number) && start <= item.due && item.due <= end) out.push([plan, item]);
    }
  }
  return sortedBy(out, (pair) => pair[1].due);
}

/** Operations that pay installments (fixed expenses in the indicators). */
export function loanOperationIds(ledger: Ledger): Set<Id> {
  return new Set([...payments(ledger).values()].map((p) => p.operation_id));
}
