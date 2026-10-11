"""Tags (marcadores) that cut across categories: "Viagem 2026", "Reforma" (docs/09 §1.3 E).

A tag classifies, it is not a financial fact: it never changes balances or results, so it
lives beside the operation instead of inside it, and tagging an operation of a closed month
is allowed. Tagging one part of an installment plan tags every part, so the total of a
tag is the whole purchase.
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from uuid import UUID, uuid5

from pydantic import Field

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountType, Operation, _Entity
from opesvault.domain.money import ZERO

MAX_LENGTH = 40
_NAMESPACE = UUID("8f0c1f56-4c1b-4f61-9f1e-5d6c7a0b7a11")


class OperationTags(_Entity):
    operation_id: UUID
    tags: tuple[str, ...] = Field(min_length=1)
    version: int = 1


Ledger.register_kind("operation_tags", OperationTags)


def _collection(ledger: Ledger) -> dict[UUID, OperationTags]:
    return ledger.entities("operation_tags")


def record_id(operation_id: UUID) -> UUID:
    """One record per operation, with a stable id."""
    return uuid5(_NAMESPACE, str(operation_id))


def normalize(tag: str) -> str:
    cleaned = " ".join(tag.split())
    if not cleaned:
        raise DomainError("Informe o nome do marcador.")
    if len(cleaned) > MAX_LENGTH:
        raise DomainError(f"Marcadores têm até {MAX_LENGTH} caracteres.")
    return cleaned


def tags_of(ledger: Ledger, operation_id: UUID) -> tuple[str, ...]:
    found = _collection(ledger).get(record_id(operation_id))
    return found.tags if found is not None else ()


def _related(ledger: Ledger, operation_id: UUID) -> list[UUID]:
    """The operation and, for an installment plan, all of its parts."""
    from opesvault.domain.cards import plans

    for plan in plans(ledger).values():
        if operation_id in plan.operation_ids:
            return list(plan.operation_ids)
    return [operation_id]


def set_tags(ledger: Ledger, operation_id: UUID, tags: list[str] | tuple[str, ...]) -> tuple[str, ...]:
    """Replaces the tags of one operation (and of its installment plan). Returns the tags kept."""
    if operation_id not in ledger.operations:
        raise DomainError("Operação inexistente.")
    clean: list[str] = []
    for tag in tags:
        name = normalize(tag)
        if name.casefold() not in {t.casefold() for t in clean}:
            clean.append(_canonical(ledger, name))
    for target in _related(ledger, operation_id):
        _store(ledger, target, tuple(clean))
    return tuple(clean)


def _canonical(ledger: Ledger, name: str) -> str:
    """Reuses the spelling already in use ("viagem 2026" → "Viagem 2026")."""
    for existing in all_tags(ledger):
        if existing.casefold() == name.casefold():
            return existing
    return name


def _store(ledger: Ledger, operation_id: UUID, tags: tuple[str, ...]) -> None:
    collection = _collection(ledger)
    key = record_id(operation_id)
    current = collection.get(key)
    if not tags:
        if current is not None:
            del collection[key]
        return
    if current is None:
        ledger.put("operation_tags", OperationTags(id=key, operation_id=operation_id, tags=tags))
    elif current.tags != tags:
        updated = current.model_copy(update={"tags": tags, "version": current.version + 1})
        ledger.put("operation_tags", updated, reason="marcadores alterados")


def add_tag(ledger: Ledger, operation_ids: list[UUID], tag: str) -> int:
    """Adds `tag` to each operation; returns how many operations changed."""
    name = _canonical(ledger, normalize(tag))
    changed = 0
    for op_id in operation_ids:
        current = tags_of(ledger, op_id)
        if name.casefold() in {t.casefold() for t in current}:
            continue
        set_tags(ledger, op_id, [*current, name])
        changed += 1
    return changed


def remove_tag(ledger: Ledger, operation_ids: list[UUID], tag: str) -> int:
    changed = 0
    for op_id in operation_ids:
        current = tags_of(ledger, op_id)
        kept = [t for t in current if t.casefold() != tag.casefold()]
        if len(kept) != len(current):
            set_tags(ledger, op_id, kept)
            changed += 1
    return changed


def all_tags(ledger: Ledger) -> list[str]:
    seen: dict[str, str] = {}
    for record in _collection(ledger).values():
        for tag in record.tags:
            seen.setdefault(tag.casefold(), tag)
    return sorted(seen.values(), key=str.casefold)


def operations_with(ledger: Ledger, tag: str) -> set[UUID]:
    key = tag.casefold()
    return {r.operation_id for r in _collection(ledger).values() if any(t.casefold() == key for t in r.tags)}


def rename_tag(ledger: Ledger, old: str, new: str) -> int:
    name = normalize(new)
    changed = 0
    for op_id in operations_with(ledger, old):
        current = tags_of(ledger, op_id)
        renamed: list[str] = []
        for tag in current:
            value = name if tag.casefold() == old.casefold() else tag
            if value.casefold() not in {t.casefold() for t in renamed}:
                renamed.append(value)
        _store(ledger, op_id, tuple(renamed))
        changed += 1
    return changed


@dataclass
class TagSummary:
    tag: str
    expense: Decimal = ZERO  # net of refunds
    income: Decimal = ZERO
    by_category: dict[UUID, Decimal] = field(default_factory=lambda: defaultdict(lambda: ZERO))
    first: date | None = None
    last: date | None = None
    operations: list[Operation] = field(default_factory=list)


def summary(ledger: Ledger, tag: str) -> TagSummary:
    """What a tag cost: expense and income postings of its active operations, whatever the month."""
    result = TagSummary(tag)
    for op_id in operations_with(ledger, tag):
        op = ledger.operations.get(op_id)
        if op is None or not op.active:
            continue
        result.operations.append(op)
        when = op.occurred_on or op.cash_date
        if when is not None:
            result.first = when if result.first is None else min(result.first, when)
            result.last = when if result.last is None else max(result.last, when)
        for p in op.postings:
            account = ledger.account(p.account_id)
            if account.type is AccountType.EXPENSE:
                result.expense += p.amount
                result.by_category[p.account_id] += p.amount
            elif account.type is AccountType.INCOME:
                result.income += -p.amount
    result.operations.sort(key=lambda o: o.occurred_on or o.cash_date or date.min)
    return result


def summaries(ledger: Ledger) -> list[TagSummary]:
    return sorted((summary(ledger, t) for t in all_tags(ledger)), key=lambda s: s.expense, reverse=True)
