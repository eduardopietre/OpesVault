"""Review decisions on a batch: corrections, duplicates kept apart, rejections, the document's
account and approval, which turns items into ledger operations with their evidence (docs/05 §7)."""

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import (
    AccountSubtype,
    AccountType,
    HistoryAction,
    LedgerAccount,
    Operation,
    OperationKind,
    Origin,
    OriginKind,
    Posting,
)
from opesvault.importing.checks import reconcile, refresh_batch
from opesvault.importing.model import (
    BatchStatus,
    Correction,
    DocType,
    ExtractedItem,
    ImportBatch,
    ItemKind,
    ItemStatus,
)
from opesvault.importing.store import batches, items, items_of


def _now() -> datetime:
    return datetime.now(UTC)


EDITABLE_FIELDS = {"description", "amount", "occurred_on", "kind", "target_account_id", "member_id"}


def correct_item(ledger: Ledger, item_id: UUID, field: str, value: object, reason: str | None = None) -> ExtractedItem:
    """User correction keeps old value, new value and declared author (docs/05 §4)."""
    if field not in EDITABLE_FIELDS:
        raise DomainError("Campo não editável.")
    item = items(ledger)[item_id]
    if item.status is ItemStatus.APPROVED:
        raise DomainError("Item já aprovado: corrija a operação no livro financeiro.")
    before = getattr(item, field)
    correction = Correction(
        field=field,
        before=None if before is None else str(before),
        after=None if value is None else str(value),
        operator=ledger.operator,
        reason=reason,
        at=_now(),
    )
    update: dict[str, object] = {field: value, "corrections": (*item.corrections, correction)}
    if field == "target_account_id":
        update["suggestion_source"] = None
    if item.status is ItemStatus.DUPLICATE and field != "target_account_id":
        update |= {"status": ItemStatus.NEEDS_REVIEW, "duplicate_of": None}
    updated = ledger.put("extracted_item", item.model_copy(update=update), reason=reason or f"correção de {field}")
    refresh_batch(ledger, item.batch_id)
    return items(ledger)[updated.id]


def keep_separate(ledger: Ledger, item_id: UUID, reason: str) -> None:
    """User decides a suspected duplicate is a distinct fact."""
    item = items(ledger)[item_id]
    if item.status is not ItemStatus.DUPLICATE:
        return
    ledger.put(
        "extracted_item",
        item.model_copy(update={"status": ItemStatus.READY, "duplicate_of": None}),
        reason=reason,
    )
    batch = batches(ledger)[item.batch_id]
    batches(ledger)[batch.id] = batch.model_copy(update={"reconciliations": reconcile(ledger, batch)})


def reject_items(ledger: Ledger, item_ids: list[UUID], reason: str) -> None:
    for item_id in item_ids:
        item = items(ledger)[item_id]
        if item.status is ItemStatus.APPROVED:
            raise DomainError("Item já aprovado não pode ser rejeitado; estorne a operação.")
        ledger.put("extracted_item", item.model_copy(update={"status": ItemStatus.REJECTED}), reason=reason)
    if item_ids:
        refresh_batch(ledger, items(ledger)[item_ids[0]].batch_id)
        update_batch_status(ledger, items(ledger)[item_ids[0]].batch_id)


def set_batch_target(ledger: Ledger, batch_id: UUID, account_id: UUID | None, card_id: UUID | None) -> ImportBatch:
    batch = batches(ledger)[batch_id]
    if any(i.status is ItemStatus.APPROVED for i in items_of(ledger, batch_id)):
        raise DomainError("Lote com itens aprovados não pode mudar de conta.")
    if card_id is not None:
        account_id = ledger.cards[card_id].liability_account_id
    ledger.put(
        "import_batch",
        batch.model_copy(update={"account_id": account_id, "card_id": card_id}),
        reason="conta do documento",
    )
    return refresh_batch(ledger, batch_id)


@dataclass
class ApprovalResult:
    created: int = 0
    linked: int = 0
    skipped: int = 0


def approve(
    ledger: Ledger,
    batch_id: UUID,
    item_ids: list[UUID] | None = None,
    *,
    accept_divergence: str | None = None,
    partial_reason: str | None = None,
) -> ApprovalResult:
    """Turn items into operations. Blocking problems stop everything (docs/05 §7)."""
    batch = refresh_batch(ledger, batch_id)
    if batch.status in (BatchStatus.UNSUPPORTED, BatchStatus.AMBIGUOUS, BatchStatus.REJECTED):
        raise DomainError("Este lote não pode ser aprovado.")
    if batch.account_id is None and batch.doc_type is not DocType.BROKERAGE_NOTE:
        raise DomainError("Escolha a conta ou o cartão deste documento antes de aprovar.")
    divergent = [r for r in batch.reconciliations if r.ok is False]
    if divergent and not (accept_divergence and accept_divergence.strip()):
        raise DomainError("O total do documento não confere. Corrija os itens ou aceite a divergência com um motivo.")
    pending = [
        i
        for i in items_of(ledger, batch_id)
        if i.status in (ItemStatus.READY, ItemStatus.DUPLICATE, ItemStatus.NEEDS_REVIEW)
    ]
    selected = [i for i in pending if item_ids is None or i.id in item_ids]
    if item_ids is not None and len(selected) < len(pending) and not (partial_reason and partial_reason.strip()):
        raise DomainError("Aprovação parcial exige um motivo explícito.")
    blocked = [i for i in selected if i.status is ItemStatus.NEEDS_REVIEW]
    if blocked:
        raise DomainError(f"{len(blocked)} item(ns) precisam de revisão (valor ou data desconhecidos).")
    if batch.doc_type is DocType.BROKERAGE_NOTE:
        from opesvault.investments.notes import approve_note

        return approve_note(ledger, batch, selected)
    result = ApprovalResult()
    for item in selected:
        if item.status is ItemStatus.DUPLICATE and item.duplicate_of is not None:
            _link_evidence(ledger, item.duplicate_of, item)
            result.linked += 1
            continue
        op = _operation_for(ledger, batch, item)
        created = ledger.add_operation(op)
        ledger.put(
            "extracted_item",
            item.model_copy(update={"status": ItemStatus.APPROVED, "operation_id": created.id}),
            reason="aprovado",
            action=HistoryAction.APPROVE_IMPORT,
        )
        result.created += 1
    updates: dict[str, object] = {}
    if accept_divergence:
        updates["warnings"] = (*batch.warnings, f"Divergência aceita: {accept_divergence.strip()}")
    if partial_reason:
        updates["partial_reason"] = partial_reason.strip()
    if updates:
        batches(ledger)[batch_id] = batches(ledger)[batch_id].model_copy(update=updates)
    update_batch_status(ledger, batch_id)
    return result


def update_batch_status(ledger: Ledger, batch_id: UUID) -> None:
    batch = batches(ledger)[batch_id]
    states = {i.status for i in items_of(ledger, batch_id)}
    open_states = {ItemStatus.READY, ItemStatus.NEEDS_REVIEW, ItemStatus.DUPLICATE}
    if states and not states & open_states:
        status = BatchStatus.APPROVED if ItemStatus.APPROVED in states else BatchStatus.REJECTED
    elif ItemStatus.APPROVED in states:
        status = BatchStatus.PARTIAL
    else:
        status = BatchStatus.IN_REVIEW
    if status is not batch.status:
        ledger.put("import_batch", batch.model_copy(update={"status": status}), reason="situação do lote")


def _link_evidence(ledger: Ledger, operation_id: UUID, item: ExtractedItem) -> None:
    op = ledger.operations[operation_id]
    origin = op.origin.model_copy(update={"evidence_ids": (*op.origin.evidence_ids, *item.evidence_ids)})
    ledger.update_operation(op.model_copy(update={"origin": origin}), reason="nova evidência de outro documento")
    ledger.put(
        "extracted_item",
        item.model_copy(update={"status": ItemStatus.APPROVED, "operation_id": operation_id}),
        reason="vinculado a operação existente",
        action=HistoryAction.APPROVE_IMPORT,
    )


def _default_category(ledger: Ledger, kind: AccountType, name: str) -> UUID:
    for account in ledger.categories(kind):
        if account.name == name:
            return account.id
    return ledger.add_account(LedgerAccount(name=name, type=kind, subtype=AccountSubtype.CATEGORY)).id


def _operation_for(ledger: Ledger, batch: ImportBatch, item: ExtractedItem) -> Operation:
    assert batch.account_id is not None and item.amount is not None
    value: Decimal = item.amount
    account = ledger.account(batch.account_id)
    origin = Origin(kind=OriginKind.IMPORT, import_id=batch.id, evidence_ids=item.evidence_ids)
    target = item.target_account_id
    common = {
        "description": item.description,
        "occurred_on": item.occurred_on,
        "origin": origin,
        "member_id": item.member_id,
        "card_id": batch.card_id,
    }
    notes = None
    if item.installment:
        notes = f"Parcela {item.installment[0]}/{item.installment[1]} (documento)"
    if item.foreign_amount is not None:
        notes = (notes + "; " if notes else "") + f"{item.foreign_currency} {item.foreign_amount}"
    common["notes"] = notes

    if item.kind is ItemKind.PURCHASE:
        target = target or _default_category(ledger, AccountType.EXPENSE, "Outras despesas")
        return Operation(
            kind=OperationKind.CARD_PURCHASE,
            postings=(Posting(account_id=target, amount=value), Posting(account_id=account.id, amount=-value)),
            **common,
        )
    if item.kind is ItemKind.CARD_CHARGE:
        target = target or _default_category(ledger, AccountType.EXPENSE, "Juros e encargos")
        return Operation(
            kind=OperationKind.CARD_CHARGE,
            postings=(Posting(account_id=target, amount=value), Posting(account_id=account.id, amount=-value)),
            **common,
        )
    if item.kind is ItemKind.CARD_CREDIT:
        target = target or _default_category(ledger, AccountType.EXPENSE, "Outras despesas")
        return Operation(
            kind=OperationKind.REFUND,
            postings=(Posting(account_id=account.id, amount=value), Posting(account_id=target, amount=-value)),
            **common,
        )
    if item.kind is ItemKind.CARD_PAYMENT:
        card = ledger.cards.get(batch.card_id) if batch.card_id else None
        source = target or (card.settlement_account_id if card else None)
        if source is None:
            raise DomainError("Informe a conta que pagou a fatura (ou defina a conta de pagamento do cartão).")
        return Operation(
            kind=OperationKind.CARD_PAYMENT,
            postings=(Posting(account_id=account.id, amount=value), Posting(account_id=source, amount=-value)),
            settled_on=item.occurred_on,
            **common,
        )
    if item.kind in (ItemKind.DEBIT, ItemKind.CREDIT):
        incoming = item.kind is ItemKind.CREDIT
        if target is None:
            target = _default_category(
                ledger,
                AccountType.INCOME if incoming else AccountType.EXPENSE,
                "Outras receitas" if incoming else "Outras despesas",
            )
        counterpart = ledger.account(target)
        kind = OperationKind.INCOME if incoming else OperationKind.EXPENSE
        if counterpart.type in (AccountType.ASSET, AccountType.LIABILITY):
            kind = (
                OperationKind.CARD_PAYMENT
                if counterpart.subtype is AccountSubtype.CREDIT_CARD
                else OperationKind.TRANSFER
            )
        sign = 1 if incoming else -1
        return Operation(
            kind=kind,
            postings=(
                Posting(account_id=account.id, amount=sign * value),
                Posting(account_id=target, amount=-sign * value),
            ),
            settled_on=item.occurred_on,
            **common,
        )
    raise DomainError("Tipo de item não aprovável aqui.")
