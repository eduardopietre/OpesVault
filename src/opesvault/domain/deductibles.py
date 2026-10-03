"""Deductible expenses marked during the year (docs/09 §1.3 E; support for the annual tax return).

Material de apoio, not the return: the app adds up what the family spent in the marked
categories, per person, with each operation listed so the receipts can be checked. It
does not apply legal limits (education, PGBL) nor decide what the tax authority accepts
(docs/00 §5). Expenses count in the year they were paid or, for card purchases, made.
"""

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, Operation, _Entity
from opesvault.domain.money import ZERO


class DeductibleKind(StrEnum):
    HEALTH = "health"
    EDUCATION = "education"
    PENSION = "pension"  # previdência privada (PGBL)
    ALIMONY = "alimony"
    DONATION = "donation"
    OTHER = "other"


KIND_LABELS = {
    DeductibleKind.HEALTH: "Saúde",
    DeductibleKind.EDUCATION: "Educação",
    DeductibleKind.PENSION: "Previdência privada (PGBL)",
    DeductibleKind.ALIMONY: "Pensão alimentícia",
    DeductibleKind.DONATION: "Doações incentivadas",
    DeductibleKind.OTHER: "Outras",
}

NOTICE = (
    "Material de apoio: soma o que foi lançado nas categorias marcadas. Não aplica limites legais "
    "nem substitui a declaração; confira cada valor com o comprovante."
)


class DeductibleCategory(_Entity):
    category_id: UUID
    kind: DeductibleKind


Ledger.register_kind("deductible_category", DeductibleCategory)


def marks(ledger: Ledger) -> dict[UUID, DeductibleCategory]:
    return ledger.entities("deductible_category")


def kind_of(ledger: Ledger, category_id: UUID) -> DeductibleKind | None:
    """The mark of the category or of its nearest marked parent."""
    by_category = {m.category_id: m.kind for m in marks(ledger).values()}
    seen: set[UUID] = set()
    cursor: UUID | None = category_id
    while cursor is not None and cursor not in seen:
        if cursor in by_category:
            return by_category[cursor]
        seen.add(cursor)
        account = ledger.accounts.get(cursor)
        cursor = account.parent_id if account is not None else None
    return None


def mark(ledger: Ledger, category_id: UUID, kind: DeductibleKind | None) -> None:
    """Marks an expense category as deductible (or clears the mark with None)."""
    account = ledger.accounts.get(category_id)
    if account is None or account.type is not AccountType.EXPENSE or account.subtype is not AccountSubtype.CATEGORY:
        raise DomainError("Só categorias de despesa podem ser dedutíveis.")
    collection = marks(ledger)
    current = next((m for m in collection.values() if m.category_id == category_id), None)
    if kind is None:
        if current is not None:
            del collection[current.id]
        return
    if current is None:
        ledger.put("deductible_category", DeductibleCategory(category_id=category_id, kind=kind))
    elif current.kind is not kind:
        ledger.put("deductible_category", current.model_copy(update={"kind": kind}), reason="tipo de dedução alterado")


@dataclass(frozen=True)
class DeductibleLine:
    operation: Operation
    category_id: UUID
    member_id: UUID | None
    amount: Decimal  # negative for refunds and reimbursements


@dataclass
class DeductibleGroup:
    kind: DeductibleKind
    member_id: UUID | None  # None: not attributed to a person
    total: Decimal = ZERO
    lines: list[DeductibleLine] = field(default_factory=list)


def annual(ledger: Ledger, year: int) -> list[DeductibleGroup]:
    """Totals per kind and person in `year`, with the operations behind each one."""
    groups: dict[tuple[DeductibleKind, UUID | None], DeductibleGroup] = {}
    kinds: dict[UUID, DeductibleKind | None] = {}
    for op in ledger.active_operations():
        when = op.cash_date or op.occurred_on
        if when is None or when.year != year:
            continue
        for p in op.postings:
            if p.account_id not in kinds:
                expense = ledger.account(p.account_id).type is AccountType.EXPENSE
                kinds[p.account_id] = kind_of(ledger, p.account_id) if expense else None
            kind = kinds[p.account_id]
            if kind is None:
                continue
            member = p.member_id or op.member_id
            group = groups.setdefault((kind, member), DeductibleGroup(kind, member))
            group.total += p.amount
            group.lines.append(DeductibleLine(op, p.account_id, member, p.amount))
    order = list(DeductibleKind)
    out = [g for g in groups.values() if g.lines]
    for group in out:
        group.lines.sort(key=lambda line: line.operation.cash_date or line.operation.occurred_on or date.min)
    return sorted(out, key=lambda g: (order.index(g.kind), str(g.member_id or "")))
