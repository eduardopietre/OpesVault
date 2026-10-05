/**
 * Review decisions on a batch: corrections, duplicates kept apart, rejections, the document's
 * account and approval, which turns items into ledger operations with their evidence (docs/05 §7).
 * Port of `importing/approval.py`.
 */
import { type IsoDate, nowInstant } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { DomainError, type Ledger } from "../domain/ledger.ts";
import {
  AccountSubtype,
  AccountType,
  HistoryAction,
  LedgerAccountSchema,
  type Operation,
  OperationKind,
  operation,
  OriginKind,
  OriginSchema,
} from "../domain/model.ts";
import { BatchNotFound, reconcile, refreshBatch } from "./checks.ts";
import {
  BatchStatus,
  CorrectionSchema,
  DocType,
  type ExtractedItem,
  type ImportBatch,
  ItemKind,
  ItemStatus,
} from "./model.ts";
import { batches, items, itemsOf } from "./store.ts";

export const EDITABLE_FIELDS: ReadonlySet<string> = new Set([
  "description",
  "amount",
  "occurred_on",
  "kind",
  "target_account_id",
  "member_id",
]);
export type EditableField = "description" | "amount" | "occurred_on" | "kind" | "target_account_id" | "member_id";

export interface ApprovalResult {
  created: number;
  linked: number;
  skipped: number;
}

export function approvalResult(): ApprovalResult {
  return { created: 0, linked: 0, skipped: 0 };
}

// ── integration hook: brokerage notes (`investments/notes.py`, ported by W5) ──

export type NoteApprover = (ledger: Ledger, batch: ImportBatch, selected: readonly ExtractedItem[]) => ApprovalResult;
let noteApprover: NoteApprover | null = null;

/**
 * `investments/notes.approve_note`. TODO(W6-integration): `investments/notes.ts` registers it
 * when it is ported. Until then approving a brokerage note is refused with a DomainError, the
 * same error type the note approval raises for a note it cannot incorporate.
 */
export function registerNoteApprover(approver: NoteApprover | null): void {
  noteApprover = approver;
}

function itemOf(ledger: Ledger, itemId: Id): ExtractedItem {
  const item = items(ledger).get(itemId);
  if (item === undefined) throw new BatchNotFound(itemId);
  return item;
}

function batchOf(ledger: Ledger, batchId: Id): ImportBatch {
  const batch = batches(ledger).get(batchId);
  if (batch === undefined) throw new BatchNotFound(batchId);
  return batch;
}

/** Python's `str(value)` of the values a correction stores. */
function pyStr(value: unknown): string {
  if (value instanceof Dec) return value.toString();
  return String(value);
}

/** User correction keeps old value, new value and declared author (docs/05 §4). */
export function correctItem(
  ledger: Ledger,
  itemId: Id,
  field: string,
  value: unknown,
  reason: string | null = null,
): ExtractedItem {
  if (!EDITABLE_FIELDS.has(field)) throw new DomainError("Campo não editável.");
  const item = itemOf(ledger, itemId);
  if (item.status === ItemStatus.APPROVED)
    throw new DomainError("Item já aprovado: corrija a operação no livro financeiro.");
  const before = (item as unknown as Record<string, unknown>)[field];
  const correction = CorrectionSchema.parse({
    field,
    before: before === null || before === undefined ? null : pyStr(before),
    after: value === null || value === undefined ? null : pyStr(value),
    operator: ledger.operator,
    reason,
    at: nowInstant(),
  });
  let update: Record<string, unknown> = { [field]: value, corrections: [...item.corrections, correction] };
  if (field === "target_account_id") update["suggestion_source"] = null;
  if (item.status === ItemStatus.DUPLICATE && field !== "target_account_id")
    update = { ...update, status: ItemStatus.NEEDS_REVIEW, duplicate_of: null };
  const updated = ledger.put("extracted_item", { ...item, ...update } as ExtractedItem, {
    reason: reason || `correção de ${field}`,
  });
  refreshBatch(ledger, item.batch_id);
  return itemOf(ledger, updated.id);
}

/** User decides a suspected duplicate is a distinct fact. */
export function keepSeparate(ledger: Ledger, itemId: Id, reason: string): void {
  const item = itemOf(ledger, itemId);
  if (item.status !== ItemStatus.DUPLICATE) return;
  ledger.put("extracted_item", { ...item, status: ItemStatus.READY, duplicate_of: null }, { reason });
  const batch = batchOf(ledger, item.batch_id);
  batches(ledger).set(batch.id, { ...batch, reconciliations: reconcile(ledger, batch) });
}

export function rejectItems(ledger: Ledger, itemIds: readonly Id[], reason: string): void {
  for (const itemId of itemIds) {
    const item = itemOf(ledger, itemId);
    if (item.status === ItemStatus.APPROVED)
      throw new DomainError("Item já aprovado não pode ser rejeitado; estorne a operação.");
    ledger.put("extracted_item", { ...item, status: ItemStatus.REJECTED }, { reason });
  }
  if (itemIds.length) {
    refreshBatch(ledger, itemOf(ledger, itemIds[0]!).batch_id);
    updateBatchStatus(ledger, itemOf(ledger, itemIds[0]!).batch_id);
  }
}

export function setBatchTarget(ledger: Ledger, batchId: Id, accountId: Id | null, cardId: Id | null): ImportBatch {
  const batch = batchOf(ledger, batchId);
  if (itemsOf(ledger, batchId).some((i) => i.status === ItemStatus.APPROVED))
    throw new DomainError("Lote com itens aprovados não pode mudar de conta.");
  let account = accountId;
  if (cardId !== null) {
    const card = ledger.cards.get(cardId);
    if (card === undefined) throw new BatchNotFound(cardId);
    account = card.liability_account_id;
  }
  ledger.put("import_batch", { ...batch, account_id: account, card_id: cardId }, { reason: "conta do documento" });
  return refreshBatch(ledger, batchId);
}

export interface ApproveOptions {
  readonly acceptDivergence?: string | null;
  readonly partialReason?: string | null;
}

/** Turn items into operations. Blocking problems stop everything (docs/05 §7). */
export function approve(
  ledger: Ledger,
  batchId: Id,
  itemIds: readonly Id[] | null = null,
  options: ApproveOptions = {},
): ApprovalResult {
  const acceptDivergence = options.acceptDivergence ?? null;
  const partialReason = options.partialReason ?? null;
  const batch = refreshBatch(ledger, batchId);
  if (
    batch.status === BatchStatus.UNSUPPORTED ||
    batch.status === BatchStatus.AMBIGUOUS ||
    batch.status === BatchStatus.REJECTED
  )
    throw new DomainError("Este lote não pode ser aprovado.");
  if (batch.account_id === null && batch.doc_type !== DocType.BROKERAGE_NOTE)
    throw new DomainError("Escolha a conta ou o cartão deste documento antes de aprovar.");
  const divergent = batch.reconciliations.filter((r) => r.ok === false);
  if (divergent.length && !(acceptDivergence && acceptDivergence.trim()))
    throw new DomainError("O total do documento não confere. Corrija os itens ou aceite a divergência com um motivo.");
  const pending = itemsOf(ledger, batchId).filter(
    (i) => i.status === ItemStatus.READY || i.status === ItemStatus.DUPLICATE || i.status === ItemStatus.NEEDS_REVIEW,
  );
  const selected = pending.filter((i) => itemIds === null || itemIds.includes(i.id));
  if (itemIds !== null && selected.length < pending.length && !(partialReason && partialReason.trim()))
    throw new DomainError("Aprovação parcial exige um motivo explícito.");
  const blocked = selected.filter((i) => i.status === ItemStatus.NEEDS_REVIEW);
  if (blocked.length)
    throw new DomainError(`${blocked.length} item(ns) precisam de revisão (valor ou data desconhecidos).`);
  if (batch.doc_type === DocType.BROKERAGE_NOTE) {
    if (noteApprover === null) throw new DomainError("A aprovação de notas de corretagem ainda não está disponível.");
    return noteApprover(ledger, batch, selected);
  }
  const result = approvalResult();
  for (const item of selected) {
    if (item.status === ItemStatus.DUPLICATE && item.duplicate_of !== null) {
      linkEvidence(ledger, item.duplicate_of, item);
      result.linked += 1;
      continue;
    }
    const op = operationFor(ledger, batch, item);
    const created = ledger.addOperation(op);
    ledger.put(
      "extracted_item",
      { ...item, status: ItemStatus.APPROVED, operation_id: created.id },
      { reason: "aprovado", action: HistoryAction.APPROVE_IMPORT },
    );
    result.created += 1;
  }
  const updates: Partial<{ warnings: readonly string[]; partial_reason: string }> = {};
  if (acceptDivergence) updates.warnings = [...batch.warnings, `Divergência aceita: ${acceptDivergence.trim()}`];
  if (partialReason) updates.partial_reason = partialReason.trim();
  if (Object.keys(updates).length) batches(ledger).set(batchId, { ...batchOf(ledger, batchId), ...updates });
  updateBatchStatus(ledger, batchId);
  return result;
}

export function updateBatchStatus(ledger: Ledger, batchId: Id): void {
  const batch = batchOf(ledger, batchId);
  const states = new Set(itemsOf(ledger, batchId).map((i) => i.status));
  const open = [ItemStatus.READY, ItemStatus.NEEDS_REVIEW, ItemStatus.DUPLICATE].some((s) => states.has(s));
  let status: BatchStatus;
  if (states.size && !open) status = states.has(ItemStatus.APPROVED) ? BatchStatus.APPROVED : BatchStatus.REJECTED;
  else if (states.has(ItemStatus.APPROVED)) status = BatchStatus.PARTIAL;
  else status = BatchStatus.IN_REVIEW;
  if (status !== batch.status) ledger.put("import_batch", { ...batch, status }, { reason: "situação do lote" });
}

function linkEvidence(ledger: Ledger, operationId: Id, item: ExtractedItem): void {
  const op = ledger.operations.get(operationId);
  if (op === undefined) throw new BatchNotFound(operationId);
  const origin = { ...op.origin, evidence_ids: [...op.origin.evidence_ids, ...item.evidence_ids] };
  ledger.updateOperation({ ...op, origin }, "nova evidência de outro documento");
  ledger.put(
    "extracted_item",
    { ...item, status: ItemStatus.APPROVED, operation_id: operationId },
    { reason: "vinculado a operação existente", action: HistoryAction.APPROVE_IMPORT },
  );
}

function defaultCategory(ledger: Ledger, kind: AccountType, name: string): Id {
  for (const account of ledger.categories(kind)) if (account.name === name) return account.id;
  return ledger.addAccount(LedgerAccountSchema.parse({ name, type: kind, subtype: AccountSubtype.CATEGORY })).id;
}

function operationFor(ledger: Ledger, batch: ImportBatch, item: ExtractedItem): Operation {
  if (batch.account_id === null || item.amount === null) throw new Error("AssertionError");
  const value: Dec = item.amount;
  const account = ledger.account(batch.account_id);
  const origin = OriginSchema.parse({ kind: OriginKind.IMPORT, import_id: batch.id, evidence_ids: item.evidence_ids });
  let target = item.target_account_id;
  let notes: string | null = null;
  if (item.installment) notes = `Parcela ${item.installment[0]}/${item.installment[1]} (documento)`;
  if (item.foreign_amount !== null)
    notes = (notes ? notes + "; " : "") + `${item.foreign_currency ?? "None"} ${item.foreign_amount.toString()}`;
  const common = {
    description: item.description,
    occurred_on: item.occurred_on,
    origin,
    member_id: item.member_id,
    card_id: batch.card_id,
    notes,
  };
  const pair = (debit: Id, credit: Id) => [
    { account_id: debit, amount: value },
    { account_id: credit, amount: value.negate() },
  ];

  if (item.kind === ItemKind.PURCHASE) {
    target = target || defaultCategory(ledger, AccountType.EXPENSE, "Outras despesas");
    return operation({ kind: OperationKind.CARD_PURCHASE, postings: pair(target, account.id), ...common });
  }
  if (item.kind === ItemKind.CARD_CHARGE) {
    target = target || defaultCategory(ledger, AccountType.EXPENSE, "Juros e encargos");
    return operation({ kind: OperationKind.CARD_CHARGE, postings: pair(target, account.id), ...common });
  }
  if (item.kind === ItemKind.CARD_CREDIT) {
    target = target || defaultCategory(ledger, AccountType.EXPENSE, "Outras despesas");
    return operation({ kind: OperationKind.REFUND, postings: pair(account.id, target), ...common });
  }
  if (item.kind === ItemKind.CARD_PAYMENT) {
    const card = batch.card_id ? (ledger.cards.get(batch.card_id) ?? null) : null;
    const source = target || (card !== null ? card.settlement_account_id : null);
    if (!source)
      throw new DomainError("Informe a conta que pagou a fatura (ou defina a conta de pagamento do cartão).");
    return operation({
      kind: OperationKind.CARD_PAYMENT,
      postings: pair(account.id, source),
      settled_on: item.occurred_on,
      ...common,
    });
  }
  if (item.kind === ItemKind.DEBIT || item.kind === ItemKind.CREDIT) {
    const incoming = item.kind === ItemKind.CREDIT;
    if (target === null) {
      target = defaultCategory(
        ledger,
        incoming ? AccountType.INCOME : AccountType.EXPENSE,
        incoming ? "Outras receitas" : "Outras despesas",
      );
    }
    const counterpart = ledger.account(target);
    let kind: OperationKind = incoming ? OperationKind.INCOME : OperationKind.EXPENSE;
    if (counterpart.type === AccountType.ASSET || counterpart.type === AccountType.LIABILITY) {
      kind = counterpart.subtype === AccountSubtype.CREDIT_CARD ? OperationKind.CARD_PAYMENT : OperationKind.TRANSFER;
    }
    const signed = incoming ? value : value.negate();
    return operation({
      kind,
      postings: [
        { account_id: account.id, amount: signed },
        { account_id: target, amount: signed.negate() },
      ],
      settled_on: item.occurred_on as IsoDate | null,
      ...common,
    });
  }
  throw new DomainError("Tipo de item não aprovável aqui.");
}
