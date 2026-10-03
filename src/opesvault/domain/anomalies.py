"""Operations that look wrong: a possible duplicate charge or a value far above the category's
usual (docs/09 §1.3 B). Without AI, from the family's own history.

A suspicion is a question, never a change: the user checks it and either fixes the operation
or marks it as reviewed, which silences that question for that operation.
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from enum import StrEnum
from itertools import pairwise
from statistics import median
from uuid import UUID

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountType, Operation, OperationKind, _Entity
from opesvault.domain.money import format_brl

LOOKBACK_DAYS = 60  # recent operations are checked; older ones are history
DUPLICATE_WINDOW_DAYS = 3
OUTLIER_FACTOR = Decimal(3)
OUTLIER_MIN_SAMPLES = 5


class SuspicionKind(StrEnum):
    DUPLICATE = "duplicate"
    OUTLIER = "outlier"


class ReviewedSuspicion(_Entity):
    operation_id: UUID
    kind: SuspicionKind


Ledger.register_kind("reviewed_suspicion", ReviewedSuspicion)


@dataclass(frozen=True)
class Suspicion:
    operation_id: UUID
    kind: SuspicionKind
    title: str
    detail: str
    on: date
    account_id: UUID  # where it was charged (bank account or card liability)
    related: tuple[UUID, ...] = ()


def _charge(ledger: Ledger, op: Operation) -> tuple[UUID, UUID, Decimal] | None:
    """(charged account, category, value) of a single-category expense or card purchase."""
    if op.kind not in (OperationKind.EXPENSE, OperationKind.CARD_PURCHASE) or op.installment is not None:
        return None
    categories = [p for p in op.postings if ledger.account(p.account_id).type is AccountType.EXPENSE]
    sources = [p for p in op.postings if p.amount < 0]
    if len(categories) != 1 or len(sources) != 1:
        return None
    return sources[0].account_id, categories[0].account_id, categories[0].amount


def _reviewed(ledger: Ledger) -> set[tuple[UUID, SuspicionKind]]:
    return {(r.operation_id, r.kind) for r in ledger.entities("reviewed_suspicion").values()}


def suspicions(ledger: Ledger, today: date | None = None) -> list[Suspicion]:
    """Cached per ledger state: the inspector asks on every selection."""
    today = today or date.today()
    cached = getattr(ledger, "_suspicions", None)
    if cached is not None and cached[0] == (ledger.change_count, today):
        return cached[1]
    found = _find(ledger, today)
    ledger._suspicions = ((ledger.change_count, today), found)  # type: ignore[attr-defined]
    return found


def _find(ledger: Ledger, today: date) -> list[Suspicion]:
    """Duplicates among recent charges; outliers against the category's usual value in the year
    before the checked period (one median per category, so 50 thousand operations stay fast)."""
    from opesvault.importing.rules import normalize

    since = today - timedelta(days=LOOKBACK_DAYS)
    year_before = since - timedelta(days=365)
    reviewed = _reviewed(ledger)
    recent: list[tuple[date, Operation, tuple[UUID, UUID, Decimal]]] = []
    usual: dict[UUID, list[Decimal]] = defaultdict(list)
    for op in ledger.active_operations():
        when = op.occurred_on or op.cash_date
        if when is None or when < year_before or when > today:
            continue
        found = _charge(ledger, op)
        if found is None:
            continue
        if when < since:
            usual[found[1]].append(found[2])
        if when >= since - timedelta(days=DUPLICATE_WINDOW_DAYS):
            recent.append((when, op, found))
    out: list[Suspicion] = []
    groups: dict[tuple[UUID, Decimal, str], list[tuple[date, Operation]]] = defaultdict(list)
    for when, op, (account, _category, value) in recent:
        groups[(account, value, normalize(op.description))].append((when, op))
    for (account, value, _key), entries in groups.items():
        entries.sort(key=lambda e: (e[0], str(e[1].id)))
        for (first_on, first), (second_on, second) in pairwise(entries):
            if second_on < since or (second_on - first_on).days > DUPLICATE_WINDOW_DAYS:
                continue
            if (second.id, SuspicionKind.DUPLICATE) in reviewed:
                continue
            out.append(
                Suspicion(
                    second.id,
                    SuspicionKind.DUPLICATE,
                    f"Possível cobrança duplicada: {second.description}",
                    f"{format_brl(value)} em {first_on:%d/%m} e em {second_on:%d/%m}",
                    second_on,
                    account,
                    (first.id,),
                )
            )
    typical = {
        category: Decimal(str(median(values)))
        for category, values in usual.items()
        if len(values) >= OUTLIER_MIN_SAMPLES
    }
    for when, op, (account, category, value) in recent:
        if when < since or (op.id, SuspicionKind.OUTLIER) in reviewed or category not in typical:
            continue
        reference = typical[category]
        if reference > 0 and value > reference * OUTLIER_FACTOR:
            name = ledger.account(category).name
            out.append(
                Suspicion(
                    op.id,
                    SuspicionKind.OUTLIER,
                    f"Valor fora do comum: {op.description}",
                    f"{format_brl(value)} em {name}, onde o usual é {format_brl(reference)}; confira se não houve erro",
                    when,
                    account,
                )
            )
    return sorted(out, key=lambda s: s.on, reverse=True)


def mark_reviewed(ledger: Ledger, operation_id: UUID, kind: SuspicionKind | None = None) -> int:
    """'Está certo': silences the question(s) about this operation. Returns how many were silenced."""
    kinds = [kind] if kind is not None else list(SuspicionKind)
    reviewed = _reviewed(ledger)
    added = 0
    for k in kinds:
        if (operation_id, k) not in reviewed:
            ledger.put("reviewed_suspicion", ReviewedSuspicion(operation_id=operation_id, kind=k))
            added += 1
    return added


def of_operation(ledger: Ledger, operation_id: UUID, today: date | None = None) -> list[Suspicion]:
    return [s for s in suspicions(ledger, today) if s.operation_id == operation_id]
