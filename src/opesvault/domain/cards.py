"""Card bills (faturas) and installment plans (docs/04 §5).

The installment calendar is a payment schedule; it is never implicitly the
competence. The user chooses, per purchase, whether the expense belongs to the
purchase month (consumption, default) or is spread over the installments.
"""

import calendar
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from enum import StrEnum
from functools import cached_property, lru_cache
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import (
    Amount,
    Card,
    InstallmentRef,
    Operation,
    OperationKind,
    OperationStatus,
    Posting,
    YearMonth,
    _Entity,
)
from opesvault.domain.money import ZERO, allocate, to_decimal


def _clamped(year: int, month: int, day: int) -> date:
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


@dataclass(frozen=True)
class Cycle:
    """One bill: purchases after the previous closing up to `closing` are due on `due`."""

    card_id: UUID
    closing: date
    due: date

    @cached_property  # frozen, but cached_property writes the instance dict directly
    def month(self) -> YearMonth:
        return YearMonth.of(self.due)


@dataclass(frozen=True)
class _Days:
    id: UUID
    closing_day: int
    due_day: int


def cycle_for(card: Card, purchase: date) -> Cycle:
    return _cycle_for(card.id, card.closing_day, card.due_day, purchase)


@lru_cache(maxsize=65536)
def _cycle_for(card_id: UUID, closing_day: int, due_day: int, purchase: date) -> Cycle:
    """Pure in its arguments (the card's days, not the card), so a changed card never hits an old entry."""
    card = _Days(card_id, closing_day, due_day)
    closing = _clamped(purchase.year, purchase.month, card.closing_day)
    if purchase > closing:
        nxt = YearMonth.of(purchase).add(1)
        closing = _clamped(nxt.year, nxt.month, card.closing_day)
    due_month = YearMonth.of(closing) if card.due_day > card.closing_day else YearMonth.of(closing).add(1)
    return Cycle(card.id, closing, _clamped(due_month.year, due_month.month, card.due_day))


def cycle_by_due_month(card: Card, month: YearMonth) -> Cycle:
    due = _clamped(month.year, month.month, card.due_day)
    closing_month = month if card.due_day > card.closing_day else month.add(-1)
    return Cycle(card.id, _clamped(closing_month.year, closing_month.month, card.closing_day), due)


class CompetencePolicy(StrEnum):
    PURCHASE = "purchase"  # whole expense in the purchase month; installments are a payment schedule
    SPREAD = "spread"  # each installment is an expense in its bill month


class InstallmentPlan(_Entity):
    card_id: UUID
    description: str = Field(max_length=500)
    purchased_on: date
    total: Amount
    amounts: tuple[Amount, ...]
    category_id: UUID
    policy: CompetencePolicy
    operation_ids: tuple[UUID, ...] = ()
    first_number: int = 1  # plans discovered mid-way (imported "03/10") start later
    count: int = Field(ge=2, le=99)


Ledger.register_kind("installment_plan", InstallmentPlan)


def plans(ledger: Ledger) -> dict[UUID, InstallmentPlan]:
    return ledger.entities("installment_plan")


def record_installment_purchase(
    ledger: Ledger,
    card_id: UUID,
    category_id: UUID,
    total: object,
    on: date,
    description: str,
    count: int,
    policy: CompetencePolicy = CompetencePolicy.PURCHASE,
    **extra: Any,
) -> InstallmentPlan:
    card = ledger.cards.get(card_id)
    if card is None:
        raise DomainError("Cartão inexistente.")
    if count < 2:
        raise DomainError("Parcelamento exige ao menos 2 parcelas.")
    value = to_decimal(total)
    if value <= 0:
        raise DomainError("Informe um valor positivo.")
    # Equal parts; residual cents go to the first installments, explicitly (docs/06 §9).
    amounts = tuple(allocate(value, [Decimal(1)] * count))
    plan = InstallmentPlan(
        card_id=card_id,
        description=description,
        purchased_on=on,
        total=value,
        amounts=amounts,
        category_id=category_id,
        policy=policy,
        count=count,
    )
    first_cycle = cycle_for(card, on)
    operations: list[Operation] = []
    if policy is CompetencePolicy.PURCHASE:
        operations.append(
            Operation(
                kind=OperationKind.CARD_PURCHASE,
                description=f"{description} ({count}x)",
                postings=(
                    Posting(account_id=category_id, amount=value),
                    Posting(account_id=card.liability_account_id, amount=-value),
                ),
                occurred_on=on,
                card_id=card_id,
                cardholder_id=extra.pop("cardholder_id", None) or card.holder_id,
                installment=InstallmentRef(plan_id=plan.id, number=1, total=count),
                **extra,
            )
        )
    else:
        for index, part in enumerate(amounts):
            month = first_cycle.month.add(index)
            operations.append(
                Operation(
                    kind=OperationKind.CARD_PURCHASE,
                    description=f"{description} ({index + 1}/{count})",
                    postings=(
                        Posting(account_id=category_id, amount=part),
                        Posting(account_id=card.liability_account_id, amount=-part),
                    ),
                    occurred_on=on,
                    accrual_month=month,
                    card_id=card_id,
                    cardholder_id=card.holder_id,
                    installment=InstallmentRef(plan_id=plan.id, number=index + 1, total=count),
                    **extra,
                )
            )
    for op in operations:  # all or nothing: check every part before inserting any
        ledger.validate_operation(op)
        ledger._guard_new(op)
    created = [ledger.add_operation(op) for op in operations]
    return ledger.put("installment_plan", plan.model_copy(update={"operation_ids": tuple(o.id for o in created)}))


@dataclass(frozen=True)
class ScheduledInstallment:
    plan_id: UUID
    number: int
    total: int
    amount: Decimal
    cycle: Cycle
    description: str


def schedule(ledger: Ledger, plan: InstallmentPlan) -> list[ScheduledInstallment]:
    card = ledger.cards[plan.card_id]
    first = cycle_for(card, plan.purchased_on)
    out = []
    for index, part in enumerate(plan.amounts):
        number = plan.first_number + index
        due_month = first.month.add(number - plan.first_number)
        out.append(
            ScheduledInstallment(
                plan.id, number, plan.count, part, cycle_by_due_month(card, due_month), plan.description
            )
        )
    return out


class BillStatus(StrEnum):
    OPEN = "open"
    CLOSED = "closed"
    PAID = "paid"
    PARTIAL = "partially_paid"
    OVERDUE = "overdue"


@dataclass
class Bill:
    cycle: Cycle
    charges: Decimal = ZERO  # purchases and fees of this cycle (non-installment)
    installments: Decimal = ZERO  # scheduled installments falling in this bill
    credits: Decimal = ZERO
    payments: Decimal = ZERO
    imported_total: Decimal | None = None
    operation_ids: list[UUID] = field(default_factory=list)

    @property
    def total(self) -> Decimal:
        return self.charges + self.installments - self.credits

    @property
    def remaining(self) -> Decimal:
        return self.total - self.payments

    def status(self, today: date) -> BillStatus:
        if today <= self.cycle.closing:
            return BillStatus.OPEN
        if self.total > 0 and self.payments >= self.total:
            return BillStatus.PAID
        if today > self.cycle.due:
            return BillStatus.OVERDUE if self.payments == 0 else BillStatus.PARTIAL
        return BillStatus.PARTIAL if self.payments > 0 else BillStatus.CLOSED


def _due_month(card: Card, paid_on: date) -> YearMonth:
    """The bill whose period contains `paid_on`: the first due date on or after it."""
    month = YearMonth.of(paid_on)
    return month if paid_on <= cycle_by_due_month(card, month).due else month.add(1)


def bills(ledger: Ledger, card_id: UUID, months: list[YearMonth]) -> list[Bill]:
    """Bills by due month. Installment purchases under the PURCHASE policy contribute their
    scheduled installments, not the full value, so a bill matches the bank's document.

    Payments settle overdue bills first: a payment made on day d pays, oldest first, every
    bill already due before d that still has a balance; only what is left goes to the bill
    whose period contains d (decision of 02/10/2026, docs/04 §5). Because an old overdue
    bill can absorb a recent payment, the whole card history is computed, then `months`
    are returned.
    """
    card = ledger.cards[card_id]
    by_month = _card_history(ledger, card_id)
    # Months outside the card's history have no charges nor payments: an empty bill each.
    return [by_month[m] if m in by_month else Bill(cycle_by_due_month(card, m)) for m in months]


def _card_history(ledger: Ledger, card_id: UUID) -> dict[YearMonth, Bill]:
    """Every bill of the card from its first to its last movement, cached per ledger state:
    alerts, the projection, the calendar and the bills tab all ask for the same history."""
    cache: dict[UUID, tuple[int, dict[YearMonth, Bill]]] = ledger.__dict__.setdefault("_bill_cache", {})
    hit = cache.get(card_id)
    if hit is not None and hit[0] == ledger.change_count:
        return hit[1]
    card = ledger.cards[card_id]
    plan_ops = {oid for p in plans(ledger).values() if p.card_id == card_id for oid in p.operation_ids}
    charges: list[tuple[YearMonth, Decimal, UUID]] = []  # (bill month, liability change, operation)
    payments: list[tuple[date, Decimal, UUID]] = []
    for op in ledger.operations.values():
        if op.status is OperationStatus.CANCELLED or op.card_id != card_id:
            continue
        liability = sum((p.amount for p in op.postings if p.account_id == card.liability_account_id), ZERO)
        if liability == 0:
            continue
        if op.kind is OperationKind.CARD_PAYMENT:
            if op.cash_date is not None:
                payments.append((op.cash_date, liability, op.id))
            continue
        if op.id in plan_ops:
            continue
        when = op.occurred_on or op.cash_date
        if when is not None:
            charges.append((cycle_for(card, when).month, liability, op.id))
    scheduled = [
        (item.cycle.month, item.amount)
        for plan in plans(ledger).values()
        if plan.card_id == card_id
        for item in schedule(ledger, plan)
    ]
    involved = [
        *(m for m, _, _ in charges),
        *(m for m, _ in scheduled),
        *(_due_month(card, d) for d, _, _ in payments),
    ]
    by_month: dict[YearMonth, Bill] = {}
    if involved:
        cursor, last = min(involved), max(involved)
        while cursor <= last:  # every month in between, so no overdue bill is skipped
            by_month[cursor] = Bill(cycle_by_due_month(card, cursor))
            cursor = cursor.add(1)
    for month, liability, op_id in charges:
        bill = by_month[month]
        if liability < 0:
            bill.charges += -liability
        else:
            bill.credits += liability
        bill.operation_ids.append(op_id)
    for month, amount in scheduled:
        by_month[month].installments += amount
    ordered = [by_month[m] for m in sorted(by_month)]
    for paid_on, amount, op_id in sorted(payments, key=lambda p: (p[0], str(p[2]))):
        left = amount
        for bill in ordered:
            if left <= 0 or bill.cycle.due >= paid_on:
                break
            open_balance = bill.remaining
            if open_balance > 0:
                share = min(left, open_balance)
                bill.payments += share
                bill.operation_ids.append(op_id)
                left -= share
        if left > 0:  # on time, or more than the overdue bills owed
            own = by_month[_due_month(card, paid_on)]
            own.payments += left
            own.operation_ids.append(op_id)
    cache[card_id] = (ledger.change_count, by_month)
    return by_month


class _ImportedPlanMatch(BaseModel):
    model_config = ConfigDict(frozen=True)

    plan_id: UUID
    operation_id: UUID


def find_plan_for_installment(
    ledger: Ledger, card_id: UUID, description: str, number: int, count: int, amount: Decimal
) -> _ImportedPlanMatch | None:
    """An imported 'PARCELA n/N' line already covered by a registered plan is not a new expense."""
    from opesvault.importing.pipeline import normalize

    key = normalize(description)
    for plan in plans(ledger).values():
        if plan.card_id != card_id or plan.count != count:
            continue
        index = number - plan.first_number
        if not 0 <= index < len(plan.amounts) or plan.amounts[index] != amount:
            continue
        if key in normalize(plan.description) or normalize(plan.description) in key:
            op_id = plan.operation_ids[min(index, len(plan.operation_ids) - 1)]
            return _ImportedPlanMatch(plan_id=plan.id, operation_id=op_id)
    return None
