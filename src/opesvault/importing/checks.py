"""Checking a batch in review: problems that block approval, totals against the document,
items already in the ledger (TA-12/13/14) and category suggestions, re-run after each change."""

from collections import Counter
from datetime import timedelta
from uuid import UUID

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import (
    AccountType,
)
from opesvault.domain.money import ZERO
from opesvault.importing import rules
from opesvault.importing.model import (
    DocType,
    ExtractedItem,
    ImportBatch,
    ItemKind,
    ItemStatus,
    Reconciliation,
)
from opesvault.importing.parsers.base import ParsedItem
from opesvault.importing.parsers.brokerage import note_computed_net
from opesvault.importing.parsers.cards import card_reconciliation_total
from opesvault.importing.store import batches, items, items_of
from opesvault.importing.suggestions import suggest

CARD_KINDS = {ItemKind.PURCHASE, ItemKind.CARD_CREDIT, ItemKind.CARD_PAYMENT, ItemKind.CARD_CHARGE}
BANK_KINDS = {ItemKind.DEBIT, ItemKind.CREDIT}
MATCH_WINDOW = timedelta(days=3)


def normalize(text: str) -> str:
    return rules.normalize(text)


def item_problems(item: ExtractedItem) -> list[str]:
    problems = []
    if item.amount is None:
        problems.append("valor desconhecido")
    elif item.amount <= 0:
        problems.append("valor não positivo")
    if item.occurred_on is None:
        problems.append("data desconhecida")
    return problems


def reconcile(ledger: Ledger, batch: ImportBatch) -> tuple[Reconciliation, ...]:
    batch_items = [i for i in items_of(ledger, batch.id) if i.status is not ItemStatus.REJECTED]
    header = batch.header
    parsed = [
        ParsedItem(
            kind=i.kind,
            occurred_on=i.occurred_on,
            description=i.description,
            amount=i.amount,
            lines=[],
            credit=i.credit,
        )
        for i in batch_items
    ]
    if batch.doc_type is DocType.CARD_STATEMENT:
        computed = card_reconciliation_total(parsed, header.previous_balance) if header.total is not None else None
        return (
            Reconciliation(
                label="Total da fatura (saldo anterior + lançamentos − créditos − pagamentos)",
                expected=header.total,
                computed=computed,
                ok=None if computed is None or header.total is None else computed == header.total,
            ),
        )
    if batch.doc_type is DocType.BANK_STATEMENT:
        if header.opening_balance is None or header.closing_balance is None:
            return (
                Reconciliation(label="Saldo final do extrato", expected=header.closing_balance, computed=None, ok=None),
            )
        computed = header.opening_balance + sum(
            ((i.amount or ZERO) if i.kind is ItemKind.CREDIT else -(i.amount or ZERO) for i in batch_items), ZERO
        )
        return (
            Reconciliation(
                label="Saldo inicial + entradas − saídas = saldo final",
                expected=header.closing_balance,
                computed=computed,
                ok=computed == header.closing_balance,
            ),
        )
    if batch.doc_type is DocType.BROKERAGE_NOTE:
        computed = note_computed_net(parsed)
        return (
            Reconciliation(
                label="Líquido da nota (vendas − compras − custos)",
                expected=header.net_amount,
                computed=computed,
                ok=None if header.net_amount is None else computed == header.net_amount,
            ),
        )
    return ()


def fingerprint(item: ExtractedItem) -> tuple[object, ...]:
    return (item.kind in CARD_KINDS, item.kind, item.occurred_on, item.amount, normalize(item.description))


def find_duplicates(ledger: Ledger, batch: ImportBatch) -> None:
    """Mark items already present in the ledger (overlapping statements, TA-12/13/14).

    Identical lines are counted: if an earlier import approved one 'X 10,00' on a day
    and this file has two, the second is new (two equal purchases can be legitimate).
    """
    if batch.account_id is None:
        return
    previous: Counter[tuple[object, ...]] = Counter()
    linked: dict[tuple[object, ...], list[UUID]] = {}
    for other in batches(ledger).values():
        if other.id == batch.id or other.account_id != batch.account_id:
            continue
        for item in items_of(ledger, other.id):
            if item.status is ItemStatus.APPROVED and item.operation_id is not None:
                key = fingerprint(item)
                previous[key] += 1
                linked.setdefault(key, []).append(item.operation_id)
    bank_ids = {
        i.bank_id: i.operation_id
        for b in batches(ledger).values()
        if b.id != batch.id and b.account_id == batch.account_id
        for i in items_of(ledger, b.id)
        if i.bank_id and i.status is ItemStatus.APPROVED
    }
    seen: Counter[tuple[object, ...]] = Counter()
    claimed: set[UUID] = set()
    for item in sorted(items_of(ledger, batch.id), key=lambda i: i.id.int):
        if item.status in (ItemStatus.APPROVED, ItemStatus.REJECTED):
            continue
        duplicate: UUID | None = None
        plan_match = None
        if item.installment and batch.card_id and item.amount is not None:
            from opesvault.domain.cards import find_plan_for_installment

            plan_match = find_plan_for_installment(
                ledger, batch.card_id, item.description, item.installment[0], item.installment[1], item.amount
            )
        if plan_match is not None:
            duplicate = plan_match.operation_id  # installment of a purchase already registered
        elif item.bank_id and item.bank_id in bank_ids:
            duplicate = bank_ids[item.bank_id]
        else:
            key = fingerprint(item)
            seen[key] += 1
            if seen[key] <= previous[key]:
                duplicate = linked[key][seen[key] - 1]
            else:
                duplicate = match_existing_operation(ledger, batch, item, claimed)
        if duplicate is not None:
            claimed.add(duplicate)
            ledger.entities("extracted_item")[item.id] = item.model_copy(
                update={"status": ItemStatus.DUPLICATE, "duplicate_of": duplicate}
            )


def match_existing_operation(
    ledger: Ledger, batch: ImportBatch, item: ExtractedItem, claimed: set[UUID]
) -> UUID | None:
    """An operation created by another source (manual entry, the other side of a transfer, a bill
    payment seen in the bank) that already holds this fact. Value and date alone are a suggestion,
    shown to the user, never a silent merge (docs/05 §6)."""
    if item.amount is None or item.occurred_on is None or batch.account_id is None:
        return None
    if item.kind not in (ItemKind.DEBIT, ItemKind.CREDIT, ItemKind.CARD_PAYMENT):
        return None
    # An operation already backed by a document of this same account is not the other side.
    same_account_batches = {b.id for b in batches(ledger).values() if b.account_id == batch.account_id}
    already_linked = {
        i.operation_id
        for i in items(ledger).values()
        if i.operation_id is not None and i.batch_id in same_account_batches
    }
    for op in ledger.active_operations():
        if op.id in claimed or op.id in already_linked:
            continue
        when = op.cash_date or op.occurred_on
        if when is None or abs(when - item.occurred_on) > MATCH_WINDOW:
            continue
        for posting in op.postings:
            if posting.account_id != batch.account_id:
                continue
            account = ledger.account(batch.account_id)
            sign = 1 if account.type is AccountType.ASSET else -1
            increases_balance = posting.amount * sign > 0
            # Credits raise a bank balance; debits and card payments lower the balance/debt.
            if abs(posting.amount) == item.amount and increases_balance == (item.kind is ItemKind.CREDIT):
                return op.id
    return None


def refresh_batch(ledger: Ledger, batch_id: UUID) -> ImportBatch:
    """Re-run validation, duplicate detection, suggestions and reconciliation for a batch."""
    batch = batches(ledger)[batch_id]
    store = items(ledger)
    for item in items_of(ledger, batch_id):
        if item.status in (ItemStatus.APPROVED, ItemStatus.REJECTED, ItemStatus.DUPLICATE):
            continue
        update: dict[str, object] = {}
        if item.target_account_id is None:
            target, source = suggest(ledger, item)
            if target is not None:
                update |= {"target_account_id": target, "suggestion_source": source}
        problems = item_problems(item)
        update["status"] = ItemStatus.NEEDS_REVIEW if problems else ItemStatus.READY
        store[item.id] = item.model_copy(update=update)
    find_duplicates(ledger, batch)
    batch = batch.model_copy(update={"reconciliations": reconcile(ledger, batch)})
    batches(ledger)[batch_id] = batch
    ledger.change_count += 1
    return batch
