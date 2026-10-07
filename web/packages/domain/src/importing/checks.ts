/**
 * Checking a batch in review: problems that block approval, totals against the document, items
 * already in the ledger (TA-12/13/14) and category suggestions, re-run after each change.
 * Port of `importing/checks.py`.
 */
import { daysBetween } from "../lib/dates.ts";
import type { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import type { Ledger } from "../domain/ledger.ts";
import { AccountType, cashDate } from "../domain/model.ts";
import { ZERO } from "../domain/money.ts";
import {
  DocType,
  type ExtractedItem,
  type ImportBatch,
  ItemKind,
  ItemStatus,
  type Reconciliation,
  ReconciliationSchema,
} from "./model.ts";
import { parsedItem } from "./parsers/base.ts";
import { noteComputedNet } from "./parsers/brokerage.ts";
import { cardReconciliationTotal } from "./parsers/cards.ts";
import { normalize as rulesNormalize } from "./rules.ts";
import { batches, items, itemsOf } from "./store.ts";
import { suggest } from "./suggestions.ts";

export const CARD_KINDS: ReadonlySet<ItemKind> = new Set([
  ItemKind.PURCHASE,
  ItemKind.CARD_CREDIT,
  ItemKind.CARD_PAYMENT,
  ItemKind.CARD_CHARGE,
]);
export const BANK_KINDS: ReadonlySet<ItemKind> = new Set([ItemKind.DEBIT, ItemKind.CREDIT]);
export const MATCH_WINDOW_DAYS = 3;

// ── integration hook: card installment plans (`domain/cards.py`, ported by W4) ──

/** An imported installment already covered by a registered plan. */
export interface ImportedPlanMatch {
  readonly plan_id: Id;
  readonly operation_id: Id;
}
export type InstallmentPlanFinder = (
  ledger: Ledger,
  cardId: Id,
  description: string,
  number: number,
  count: number,
  amount: Dec,
) => ImportedPlanMatch | null;

let planFinder: InstallmentPlanFinder | null = null;

/**
 * `domain/cards.find_plan_for_installment`. TODO(W6-integration): `domain/cards.ts` registers it
 * when it is ported; until then no plan exists, which is what the finder answers for a ledger
 * without installment plans.
 */
export function registerInstallmentPlanFinder(finder: InstallmentPlanFinder | null): void {
  planFinder = finder;
}

export function normalize(text: string): string {
  return rulesNormalize(text);
}

export function itemProblems(item: ExtractedItem): string[] {
  const problems: string[] = [];
  if (item.amount === null) problems.push("valor desconhecido");
  else if (!item.amount.isPositive()) problems.push("valor não positivo");
  if (item.occurred_on === null) problems.push("data desconhecida");
  return problems;
}

function reconciliation(fields: Reconciliation): Reconciliation {
  return ReconciliationSchema.parse(fields);
}

export function reconcile(ledger: Ledger, batch: ImportBatch): readonly Reconciliation[] {
  const batchItems = itemsOf(ledger, batch.id).filter((i) => i.status !== ItemStatus.REJECTED);
  const header = batch.header;
  const parsed = batchItems.map((i) =>
    parsedItem({
      kind: i.kind,
      occurred_on: i.occurred_on,
      description: i.description,
      amount: i.amount,
      lines: [],
      credit: i.credit,
    }),
  );
  if (batch.doc_type === DocType.CARD_STATEMENT) {
    const computed = header.total !== null ? cardReconciliationTotal(parsed, header.previous_balance) : null;
    return [
      reconciliation({
        label: "Total da fatura (saldo anterior + lançamentos − créditos − pagamentos)",
        expected: header.total,
        computed,
        ok: computed === null || header.total === null ? null : computed.eq(header.total),
      }),
    ];
  }
  if (batch.doc_type === DocType.BANK_STATEMENT) {
    if (header.opening_balance === null || header.closing_balance === null) {
      return [
        reconciliation({ label: "Saldo final do extrato", expected: header.closing_balance, computed: null, ok: null }),
      ];
    }
    let flow = ZERO;
    for (const i of batchItems)
      flow = flow.add(i.kind === ItemKind.CREDIT ? (i.amount ?? ZERO) : (i.amount ?? ZERO).negate());
    const computed = header.opening_balance.add(flow);
    return [
      reconciliation({
        label: "Saldo inicial + entradas − saídas = saldo final",
        expected: header.closing_balance,
        computed,
        ok: computed.eq(header.closing_balance),
      }),
    ];
  }
  if (batch.doc_type === DocType.BROKERAGE_NOTE) {
    const computed = noteComputedNet(parsed);
    return [
      reconciliation({
        label: "Líquido da nota (vendas − compras − custos)",
        expected: header.net_amount,
        computed,
        ok: header.net_amount === null ? null : computed.eq(header.net_amount),
      }),
    ];
  }
  return [];
}

/** Equal items have equal fingerprints; amounts compare by value, like Python's Decimal keys. */
function fingerprint(item: ExtractedItem): string {
  const amount = item.amount === null ? null : item.amount.isZero() ? "0" : item.amount.normalize().toString();
  return JSON.stringify([CARD_KINDS.has(item.kind), item.kind, item.occurred_on, amount, normalize(item.description)]);
}

/** UUIDs ordered as 128-bit integers (`uuid.int`): canonical lowercase hex sorts the same way. */
function byIdInt(a: ExtractedItem, b: ExtractedItem): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Mark items already present in the ledger (overlapping statements, TA-12/13/14).
 *
 * Identical lines are counted: if an earlier import approved one 'X 10,00' on a day and this file
 * has two, the second is new (two equal purchases can be legitimate).
 */
function findDuplicates(ledger: Ledger, batch: ImportBatch): void {
  if (batch.account_id === null) return;
  const previous = new Map<string, number>();
  const linked = new Map<string, Id[]>();
  for (const other of batches(ledger).values()) {
    if (other.id === batch.id || other.account_id !== batch.account_id) continue;
    for (const item of itemsOf(ledger, other.id)) {
      if (item.status === ItemStatus.APPROVED && item.operation_id !== null) {
        const key = fingerprint(item);
        previous.set(key, (previous.get(key) ?? 0) + 1);
        const list = linked.get(key) ?? [];
        list.push(item.operation_id);
        linked.set(key, list);
      }
    }
  }
  const bankIds = new Map<string, Id | null>();
  for (const b of batches(ledger).values()) {
    if (b.id === batch.id || b.account_id !== batch.account_id) continue;
    for (const i of itemsOf(ledger, b.id))
      if (i.bank_id && i.status === ItemStatus.APPROVED) bankIds.set(i.bank_id, i.operation_id);
  }
  const seen = new Map<string, number>();
  const claimed = new Set<Id>();
  for (const item of [...itemsOf(ledger, batch.id)].sort(byIdInt)) {
    if (item.status === ItemStatus.APPROVED || item.status === ItemStatus.REJECTED) continue;
    let duplicate: Id | null;
    let planMatch: ImportedPlanMatch | null = null;
    if (item.installment && batch.card_id && item.amount !== null && planFinder !== null) {
      planMatch = planFinder(
        ledger,
        batch.card_id,
        item.description,
        item.installment[0],
        item.installment[1],
        item.amount,
      );
    }
    if (planMatch !== null) {
      duplicate = planMatch.operation_id; // installment of a purchase already registered
    } else if (item.bank_id && bankIds.has(item.bank_id)) {
      duplicate = bankIds.get(item.bank_id)!;
    } else {
      const key = fingerprint(item);
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count <= (previous.get(key) ?? 0)) duplicate = linked.get(key)![count - 1]!;
      else duplicate = matchExistingOperation(ledger, batch, item, claimed);
    }
    if (duplicate !== null) {
      claimed.add(duplicate);
      items(ledger).set(item.id, { ...item, status: ItemStatus.DUPLICATE, duplicate_of: duplicate });
    }
  }
}

/**
 * An operation created by another source (manual entry, the other side of a transfer, a bill
 * payment seen in the bank) that already holds this fact. Value and date alone are a suggestion,
 * shown to the user, never a silent merge (docs/05 §6).
 */
function matchExistingOperation(
  ledger: Ledger,
  batch: ImportBatch,
  item: ExtractedItem,
  claimed: ReadonlySet<Id>,
): Id | null {
  if (item.amount === null || item.occurred_on === null || batch.account_id === null) return null;
  if (item.kind !== ItemKind.DEBIT && item.kind !== ItemKind.CREDIT && item.kind !== ItemKind.CARD_PAYMENT) return null;
  // An operation already backed by a document of this same account is not the other side.
  const sameAccountBatches = new Set<Id>();
  for (const b of batches(ledger).values()) if (b.account_id === batch.account_id) sameAccountBatches.add(b.id);
  const alreadyLinked = new Set<Id>();
  for (const i of items(ledger).values())
    if (i.operation_id !== null && sameAccountBatches.has(i.batch_id)) alreadyLinked.add(i.operation_id);
  for (const op of ledger.activeOperations()) {
    if (claimed.has(op.id) || alreadyLinked.has(op.id)) continue;
    const when = cashDate(op) ?? op.occurred_on;
    if (when === null || Math.abs(daysBetween(when, item.occurred_on)) > MATCH_WINDOW_DAYS) continue;
    for (const posting of op.postings) {
      if (posting.account_id !== batch.account_id) continue;
      const account = ledger.account(batch.account_id);
      const increasesBalance =
        account.type === AccountType.ASSET ? posting.amount.isPositive() : posting.amount.isNegative();
      // Credits raise a bank balance; debits and card payments lower the balance/debt.
      if (posting.amount.abs().eq(item.amount) && increasesBalance === (item.kind === ItemKind.CREDIT)) return op.id;
    }
  }
  return null;
}

/** Re-run validation, duplicate detection, suggestions and reconciliation for a batch. */
export function refreshBatch(ledger: Ledger, batchId: Id): ImportBatch {
  let batch = batches(ledger).get(batchId);
  if (batch === undefined) throw new BatchNotFound(batchId);
  const store = items(ledger);
  for (const item of itemsOf(ledger, batchId)) {
    if (
      item.status === ItemStatus.APPROVED ||
      item.status === ItemStatus.REJECTED ||
      item.status === ItemStatus.DUPLICATE
    )
      continue;
    let updated: ExtractedItem = item;
    if (item.target_account_id === null) {
      const [target, source] = suggest(ledger, item);
      if (target !== null) updated = { ...updated, target_account_id: target, suggestion_source: source };
    }
    const problems = itemProblems(item);
    updated = { ...updated, status: problems.length ? ItemStatus.NEEDS_REVIEW : ItemStatus.READY };
    store.set(item.id, updated);
  }
  findDuplicates(ledger, batch);
  batch = { ...batch, reconciliations: reconcile(ledger, batch) };
  batches(ledger).set(batchId, batch);
  ledger.changeCount += 1;
  return batch;
}

/** Python's `KeyError` for a batch or item id that is not in the ledger. */
export class BatchNotFound extends Error {
  constructor(id: Id) {
    super(id);
    this.name = "KeyError";
  }
}
