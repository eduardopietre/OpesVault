/**
 * Reembolsos e acertos without React (desktop `SharingPage.refresh`): the reimbursement lines, who owes whom,
 * the expenses behind a balance and the settlements, plus the line under the title.
 */
import { Dec, ZERO, dom, type Id, type IsoDate, type Ledger } from "@opesvault/domain";

const sharing = dom.sharing;

export type ReimbursementState = dom.sharing.ReimbursementState;

export interface ReimbursementRow {
  id: Id;
  operationId: Id;
  date: IsoDate | null;
  description: string;
  payer: string;
  expected: Dec;
  received: Dec;
  state: ReimbursementState;
  /** Still waiting for money (pending or partial). */
  open: boolean;
}

export interface BalanceRow {
  /** "debtor:creditor": a pair, never one of them alone. */
  id: string;
  debtorId: Id;
  creditorId: Id;
  debtor: string;
  creditor: string;
  amount: Dec;
  settled: Dec;
  shares: readonly dom.sharing.Share[];
}

export interface SettlementRow {
  id: Id;
  date: IsoDate;
  debtor: string;
  creditor: string;
  amount: Dec;
  note: string;
}

export interface ShareRow {
  /** The operation, so the line can open it in the Livro. */
  id: Id;
  date: IsoDate | null;
  description: string;
  amount: Dec;
}

export interface SharingView {
  reimbursements: ReimbursementRow[];
  balances: BalanceRow[];
  settlements: SettlementRow[];
  waiting: Dec;
  owed: Dec;
  openCount: number;
  /** There is something to show: a reimbursement, an expense shared between members or a settlement. */
  hasContent: boolean;
  hasShares: boolean;
}

const isOpen = (state: ReimbursementState) => state === "pending" || state === "partial";

export const pairId = (debtorId: Id, creditorId: Id) => `${debtorId}:${creditorId}`;

/** Open items first, then by the date requested (the desktop's order). */
export function sharingView(ledger: Ledger): SharingView {
  const memberName = (id: Id | null) => (id ? ledger.members.get(id)?.name : undefined) ?? "?";
  const items = [...sharing.reimbursements(ledger).values()].sort((a, b) => {
    const openA = isOpen(sharing.state(ledger, a)) ? 0 : 1;
    const openB = isOpen(sharing.state(ledger, b)) ? 0 : 1;
    return openA - openB || String(a.requested_on ?? "").localeCompare(String(b.requested_on ?? ""));
  });
  let waiting = ZERO;
  const reimbursements = items.map((item): ReimbursementRow => {
    const op = ledger.operations.get(item.operation_id);
    const received = sharing.received(ledger, item);
    const state = sharing.state(ledger, item);
    if (isOpen(state)) waiting = waiting.add(item.expected.sub(received));
    return {
      id: item.id,
      operationId: item.operation_id,
      date: op?.occurred_on ?? null,
      description: op?.description ?? "?",
      payer: item.payer,
      expected: item.expected,
      received,
      state,
      open: isOpen(state),
    };
  });
  const balances = sharing.balances(ledger).map((b): BalanceRow => ({
    id: pairId(b.debtorId, b.creditorId),
    debtorId: b.debtorId,
    creditorId: b.creditorId,
    debtor: memberName(b.debtorId),
    creditor: memberName(b.creditorId),
    amount: b.amount,
    settled: b.settled,
    shares: b.shares,
  }));
  const settlements = [...sharing.settlements(ledger).values()]
    .sort((a, b) => b.on.localeCompare(a.on))
    .map((s): SettlementRow => ({
      id: s.id,
      date: s.on,
      debtor: memberName(s.debtor_id),
      creditor: memberName(s.creditor_id),
      amount: s.amount,
      note: s.note ?? "",
    }));
  const hasShares = balances.length > 0 || sharing.shares(ledger).length > 0;
  return {
    reimbursements,
    balances,
    settlements,
    waiting,
    owed: Dec.sum(
      balances.map((b) => b.amount),
      ZERO,
    ),
    openCount: reimbursements.filter((r) => r.open).length,
    hasContent: reimbursements.length > 0 || hasShares || settlements.length > 0,
    hasShares,
  };
}

export function sharesOf(balance: BalanceRow | null): ShareRow[] {
  return (balance?.shares ?? []).map((s) => ({
    id: s.operationId,
    date: s.on,
    description: s.description,
    amount: s.amount,
  }));
}

/** The line under the title: what is waiting, in words. */
export function summaryLine(view: SharingView): string {
  const parts: string[] = [];
  if (view.openCount) parts.push(`${view.openCount} reembolso(s) a receber`);
  if (view.balances.length) parts.push(`${view.balances.length} acerto(s) pendente(s)`);
  return parts.join(" · ");
}

/** Exact cents for sorting a money column. */
export function cents(value: Dec): bigint {
  return BigInt(value.quantize("0.01", "ROUND_HALF_UP").toFixed().replace(".", ""));
}

/**
 * What a link from another screen names: a reimbursement ("reembolso:<id>" or its bare id) or the expense it
 * refunds (the operation id, as the Livro shows it).
 */
export function findReimbursement(rows: readonly ReimbursementRow[], ref: string | undefined): ReimbursementRow | null {
  if (!ref) return null;
  const id = ref.startsWith("reembolso:") ? ref.slice("reembolso:".length) : ref;
  return rows.find((r) => r.id === id) ?? rows.find((r) => r.operationId === id) ?? null;
}
