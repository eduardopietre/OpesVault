/**
 * Reimbursements to receive and settling up between family members (docs/09 §1.3 E).
 * Port of `domain/sharing.py`.
 *
 * Reimbursement: an expense someone else will pay back (health plan, employer). When the money
 * arrives it is recorded as a refund of the same categories, so the net expense is right; the
 * refund counts in the month it is received (the expense month may be closed).
 *
 * Settling up: in a shared expense, whoever paid fronted the other members' shares. The payer is
 * the only holder of the paying account, or the holder of the card; a joint account paid for
 * everyone, so it creates no debt between members. A share is a rateio posting's member or,
 * without rateio, the operation's member. Nothing here moves money: recording a settlement only
 * says it was paid back.
 */
import { z } from "zod";

import { type IsoDate, ymOf } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { zDate, zDec, zId } from "../lib/schema.ts";
import { sortedBy } from "../lib/text.ts";
import { getOrThrow } from "./error.ts";
import { DomainError, Ledger } from "./ledger.ts";
import { AccountType, cashDate, operation, type Operation, OperationKind, type Posting, zEntityId } from "./model.ts";
import { allocate, isCents, toDecimal, ZERO } from "./money.ts";
import { amountOfType, postingsOfType } from "./queries.ts";

// ── reimbursements ───────────────────────────────────────

export const ReimbursementSchema = z.strictObject({
  id: zEntityId,
  operation_id: zId, // the expense to be paid back
  payer: z.string().min(1).max(80), // "Plano de saúde", "Empresa"
  expected: zDec,
  requested_on: zDate.nullable().default(null),
  denied: z.boolean().default(false),
  note: z.string().max(500).nullable().default(null),
  receipt_ids: z.array(zId).readonly().default([]), // refund operations
  version: z.number().int().default(1),
});
export type Reimbursement = Readonly<z.output<typeof ReimbursementSchema>>;

Ledger.registerKind("reimbursement", ReimbursementSchema);

export const ReimbursementState = {
  PENDING: "pending",
  PARTIAL: "partial",
  RECEIVED: "received",
  DENIED: "denied",
} as const;
export type ReimbursementState = (typeof ReimbursementState)[keyof typeof ReimbursementState];

export const STATE_LABELS: Readonly<Record<ReimbursementState, string>> = {
  pending: "A receber",
  partial: "Recebido em parte",
  received: "Recebido",
  denied: "Negado",
};

export function reimbursements(ledger: Ledger) {
  return ledger.entities<Reimbursement>("reimbursement");
}

function expenseParts(ledger: Ledger, op: Operation): Posting[] {
  return postingsOfType(ledger, op, AccountType.EXPENSE).filter((p) => p.amount.isPositive());
}

export function request(
  ledger: Ledger,
  operationId: Id,
  payer: string,
  expected: unknown,
  requestedOn: IsoDate | null = null,
): Reimbursement {
  const op = ledger.operations.get(operationId);
  if (op === undefined || op.status !== "active") throw new DomainError("Escolha um lançamento ativo.");
  const parts = expenseParts(ledger, op);
  if (!parts.length) throw new DomainError("Só despesas podem ter reembolso.");
  for (const r of reimbursements(ledger).values()) {
    if (r.operation_id === operationId && !r.denied) {
      throw new DomainError("Este lançamento já tem um reembolso registrado.");
    }
  }
  const value = toDecimal(expected);
  if (!value.isPositive() || !isCents(value)) throw new DomainError("Informe o valor esperado em reais e centavos.");
  if (
    value.gt(
      Dec.sum(
        parts.map((p) => p.amount),
        ZERO,
      ),
    )
  ) {
    throw new DomainError("O reembolso esperado passa do valor da despesa.");
  }
  if (!payer.trim()) throw new DomainError("Informe quem reembolsa.");
  return ledger.put(
    "reimbursement",
    ReimbursementSchema.parse({
      operation_id: operationId,
      payer: payer.trim(),
      expected: value,
      requested_on: requestedOn,
    }),
  );
}

export function received(ledger: Ledger, item: Reimbursement): Dec {
  let total = ZERO;
  for (const opId of item.receipt_ids) {
    const op = ledger.operations.get(opId);
    if (op !== undefined && op.status === "active") {
      total = total.add(
        Dec.sum(
          op.postings
            .filter((p) => ledger.account(p.account_id).type === AccountType.EXPENSE)
            .map((p) => p.amount.negate()),
          ZERO,
        ),
      );
    }
  }
  return total;
}

export function state(ledger: Ledger, item: Reimbursement): ReimbursementState {
  if (item.denied) return ReimbursementState.DENIED;
  const got = received(ledger, item);
  if (got.gte(item.expected)) return ReimbursementState.RECEIVED;
  return got.isPositive() ? ReimbursementState.PARTIAL : ReimbursementState.PENDING;
}

/** Python's `text[:n]`: by code points, not UTF-16 units. */
function head(text: string, n: number): string {
  return [...text].slice(0, n).join("");
}

/** Records the money received as a refund of the original categories, in proportion. */
export function receive(ledger: Ledger, reimbursementId: Id, accountId: Id, amount: unknown, on: IsoDate): Operation {
  const item = getOrThrow(reimbursements(ledger), reimbursementId, "Reembolso inexistente.");
  if (item.denied) throw new DomainError("Reembolso negado não recebe valores.");
  const original = ledger.operations.get(item.operation_id);
  if (original === undefined) throw new DomainError("O lançamento reembolsado não existe mais.");
  if (ledger.account(accountId).type !== AccountType.ASSET) {
    throw new DomainError("Escolha a conta que recebeu o reembolso.");
  }
  const value = toDecimal(amount);
  if (!value.isPositive() || !isCents(value)) throw new DomainError("Informe um valor positivo em reais e centavos.");
  const parts = expenseParts(ledger, original);
  const shares = allocate(
    value,
    parts.map((p) => p.amount),
  );
  const postings: Posting[] = [{ account_id: accountId, amount: value, member_id: null }];
  parts.forEach((p, i) => {
    const share = shares[i]!;
    if (!share.isZero()) postings.push({ account_id: p.account_id, amount: share.negate(), member_id: p.member_id });
  });
  const op = ledger.addOperation(
    operation({
      kind: OperationKind.REFUND,
      description: head(`Reembolso (${item.payer}): ${original.description}`, 500),
      postings,
      occurred_on: on,
      settled_on: on,
      accrual_month: ymOf(on),
      member_id: original.member_id,
    }),
  );
  ledger.put(
    "reimbursement",
    { ...item, receipt_ids: [...item.receipt_ids, op.id], version: item.version + 1 },
    { reason: "reembolso recebido" },
  );
  return op;
}

export function deny(ledger: Ledger, reimbursementId: Id, reason: string): Reimbursement {
  const item = getOrThrow(reimbursements(ledger), reimbursementId, "Reembolso inexistente.");
  if (!reason.trim()) throw new DomainError("Informe o motivo.");
  return ledger.put("reimbursement", { ...item, denied: true, version: item.version + 1 }, { reason });
}

/** Still waiting for money: pending or partially received. */
export function openItems(ledger: Ledger): Reimbursement[] {
  return [...reimbursements(ledger).values()].filter((r) => {
    const s = state(ledger, r);
    return s === ReimbursementState.PENDING || s === ReimbursementState.PARTIAL;
  });
}

// ── settling up between members ──────────────────────────

export const MemberSettlementSchema = z.strictObject({
  id: zEntityId,
  debtor_id: zId, // who paid back
  creditor_id: zId, // who had fronted the money
  amount: zDec,
  on: zDate,
  note: z.string().max(500).nullable().default(null),
});
export type MemberSettlement = Readonly<z.output<typeof MemberSettlementSchema>>;

Ledger.registerKind("member_settlement", MemberSettlementSchema);

export function settlements(ledger: Ledger) {
  return ledger.entities<MemberSettlement>("member_settlement");
}

/** Who fronted the money, or null when it is not one person (joint account, unknown holder). */
export function payerOf(ledger: Ledger, op: Operation): Id | null {
  if (op.card_id !== null) {
    const card = ledger.cards.get(op.card_id);
    return card !== undefined ? card.holder_id : null;
  }
  // Who paid an expense is the holder of the account it left; a refund goes back to whoever receives it.
  const expense = amountOfType(ledger, op, AccountType.EXPENSE);
  const sign = expense.isNegative() ? 1 : -1;
  const sources = op.postings.filter(
    (p) => p.amount.mul(sign).isPositive() && ledger.account(p.account_id).type === AccountType.ASSET,
  );
  const holders = new Set<Id>();
  for (const p of sources) for (const h of ledger.account(p.account_id).holders) holders.add(h);
  return holders.size === 1 ? [...holders][0]! : null;
}

export interface Share {
  readonly operationId: Id;
  readonly on: IsoDate | null;
  readonly description: string;
  readonly payerId: Id;
  readonly beneficiaryId: Id;
  /** Positive: the beneficiary owes the payer. */
  readonly amount: Dec;
}

/** Shares fronted by one member for another, from expenses (and their refunds). */
export function shares(ledger: Ledger, start: IsoDate | null = null, end: IsoDate | null = null): Share[] {
  const out: Share[] = [];
  for (const op of ledger.activeOperations()) {
    if (op.kind === OperationKind.OPENING_BALANCE) continue;
    const when = op.occurred_on ?? cashDate(op);
    if ((start !== null || end !== null) && when === null) continue;
    if (start !== null && when !== null && when < start) continue;
    if (end !== null && when !== null && when > end) continue;
    const payer = payerOf(ledger, op);
    if (payer === null) continue;
    const owed = new Map<Id, Dec>();
    for (const p of op.postings) {
      if (ledger.account(p.account_id).type !== AccountType.EXPENSE) continue;
      const member = p.member_id ?? op.member_id;
      if (member !== null && member !== payer) owed.set(member, (owed.get(member) ?? ZERO).add(p.amount));
    }
    for (const [member, value] of owed) {
      if (!value.isZero()) {
        out.push({
          operationId: op.id,
          on: when,
          description: op.description,
          payerId: payer,
          beneficiaryId: member,
          amount: value,
        });
      }
    }
  }
  return sortedBy(out, (s) => [s.on ?? "0001-01-01", s.description]);
}

export interface Balance {
  debtorId: Id;
  creditorId: Id;
  amount: Dec;
  shares: Share[];
  settled: Dec;
}

/**
 * Net amount each member owes another, after settlements; pairs that cancel out are omitted.
 * Python walked a set of members, so pairs with the same amount came in no defined order; here
 * they follow the order members first appear in shares and settlements.
 */
export function balances(ledger: Ledger, start: IsoDate | null = null, end: IsoDate | null = null): Balance[] {
  const key = (a: Id, b: Id) => `${a}|${b}`;
  const gross = new Map<string, Dec>();
  const detail = new Map<string, Share[]>();
  const members = new Set<Id>();
  for (const share of shares(ledger, start, end)) {
    const k = key(share.beneficiaryId, share.payerId);
    gross.set(k, (gross.get(k) ?? ZERO).add(share.amount));
    const list = detail.get(k);
    if (list === undefined) detail.set(k, [share]);
    else list.push(share);
    members.add(share.beneficiaryId).add(share.payerId);
  }
  const paid = new Map<string, Dec>();
  for (const s of settlements(ledger).values()) {
    if ((start === null || s.on >= start) && (end === null || s.on <= end)) {
      const k = key(s.debtor_id, s.creditor_id);
      paid.set(k, (paid.get(k) ?? ZERO).add(s.amount));
      members.add(s.debtor_id).add(s.creditor_id);
    }
  }
  const g = (a: Id, b: Id) => gross.get(key(a, b)) ?? ZERO;
  const pd = (a: Id, b: Id) => paid.get(key(a, b)) ?? ZERO;
  const out: Balance[] = [];
  const seen = new Set<string>();
  const list = [...members];
  for (const a of list) {
    for (const b of list) {
      const pair = a < b ? key(a, b) : key(b, a);
      if (a === b || seen.has(pair)) continue;
      seen.add(pair);
      const aOwes = g(a, b).sub(pd(a, b)).add(pd(b, a));
      const bOwes = g(b, a);
      const net = aOwes.sub(bOwes);
      if (net.isPositive()) {
        out.push({ debtorId: a, creditorId: b, amount: net, shares: detail.get(key(a, b)) ?? [], settled: pd(a, b) });
      } else if (net.isNegative()) {
        out.push({
          debtorId: b,
          creditorId: a,
          amount: net.negate(),
          shares: detail.get(key(b, a)) ?? [],
          settled: pd(b, a),
        });
      }
    }
  }
  return sortedBy(out, (x) => x.amount, true);
}

export function settle(
  ledger: Ledger,
  debtorId: Id,
  creditorId: Id,
  amount: unknown,
  on: IsoDate,
  note: string | null = null,
): MemberSettlement {
  if (debtorId === creditorId) throw new DomainError("Escolha dois integrantes diferentes.");
  if (!ledger.members.has(debtorId) || !ledger.members.has(creditorId))
    throw new DomainError("Integrante inexistente.");
  const value = toDecimal(amount);
  if (!value.isPositive() || !isCents(value)) throw new DomainError("Informe um valor positivo em reais e centavos.");
  return ledger.put(
    "member_settlement",
    MemberSettlementSchema.parse({
      debtor_id: debtorId,
      creditor_id: creditorId,
      amount: value,
      on,
      note: note || null,
    }),
  );
}
