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

    @property
    def month(self) -> YearMonth:
        return YearMonth.of(self.due)


def cycle_for(card: Card, purchase: date) -> Cycle:
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


def bills(ledger: Ledger, card_id: UUID, months: list[YearMonth]) -> list[Bill]:
    """Bills by due month. Installment purchases under the PURCHASE policy contribute their
    scheduled installments, not the full value, so a bill matches the bank's document."""
    card = ledger.cards[card_id]
    by_month = {m: Bill(cycle_by_due_month(card, m)) for m in months}
    plan_ops = {oid for p in plans(ledger).values() if p.card_id == card_id for oid in p.operation_ids}
    for op in ledger.operations.values():
        if op.status is OperationStatus.CANCELLED or op.card_id != card_id:
            continue
        liability = sum((p.amount for p in op.postings if p.account_id == card.liability_account_id), ZERO)
        if liability == 0:
            continue
        if op.kind is OperationKind.CARD_PAYMENT:
            when = op.cash_date
            if when is None:
                continue
            for bill in by_month.values():
                previous_due = cycle_by_due_month(card, bill.cycle.month.add(-1)).due
                if previous_due < when <= bill.cycle.due:
                    bill.payments += liability
                    bill.operation_ids.append(op.id)
            continue
        if op.id in plan_ops:
            continue
        when = op.occurred_on or op.cash_date
        if when is None:
            continue
        month = cycle_for(card, when).month
        if month not in by_month:
            continue
        bill = by_month[month]
        if liability < 0:
            bill.charges += -liability
        else:
            bill.credits += liability
        bill.operation_ids.append(op.id)
    for plan in plans(ledger).values():
        if plan.card_id != card_id:
            continue
        for scheduled in schedule(ledger, plan):
            if scheduled.cycle.month in by_month:
                by_month[scheduled.cycle.month].installments += scheduled.amount
    return [by_month[m] for m in months]


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
