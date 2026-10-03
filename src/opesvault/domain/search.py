"""Operation filters for the ledger view. Pure domain code, testable without Qt."""

from dataclasses import dataclass
from datetime import date
from enum import StrEnum
from uuid import UUID

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import Operation, OriginKind


class StatusFilter(StrEnum):
    ACTIVE = "active"
    CANCELLED = "cancelled"
    ALL = "all"


@dataclass(frozen=True)
class OperationFilter:
    start: date | None = None
    end: date | None = None
    account_id: UUID | None = None  # balance account or category hit by any posting
    member_id: UUID | None = None  # operation member or any posting share
    text: str = ""
    status: StatusFilter = StatusFilter.ALL
    origin: OriginKind | None = None
    # Restricts to these operations (a tag, an installment plan…); None means no restriction.
    operation_ids: frozenset[UUID] | None = None

    def matches(self, op: Operation) -> bool:
        if self.operation_ids is not None and op.id not in self.operation_ids:
            return False
        if self.status is StatusFilter.ACTIVE and not op.active:
            return False
        if self.status is StatusFilter.CANCELLED and op.active:
            return False
        if self.origin is not None and op.origin.kind is not self.origin:
            return False
        if self.start is not None or self.end is not None:
            # Unknown dates never match a period: they are not "in" any month.
            when = op.occurred_on or op.cash_date
            if when is None:
                return False
            if self.start is not None and when < self.start:
                return False
            if self.end is not None and when > self.end:
                return False
        if self.account_id is not None and all(p.account_id != self.account_id for p in op.postings):
            return False
        if (
            self.member_id is not None
            and op.member_id != self.member_id
            and all(p.member_id != self.member_id for p in op.postings)
        ):
            return False
        needle = self.text.strip().casefold()
        return not needle or needle in op.description.casefold() or needle in (op.notes or "").casefold()


def find_operations(ledger: Ledger, flt: OperationFilter) -> list[Operation]:
    """Newest first; operations without any date go last."""
    found = [op for op in ledger.operations.values() if flt.matches(op)]
    found.sort(key=lambda o: (o.occurred_on or o.cash_date or date.min, o.id.int), reverse=True)
    return found
