"""Recurring rules and forecasts (RF-11, docs/04 §3).

Forecasts are not realized records: they never change balances. A realized
forecast is linked to the actual operation and stops counting as pending (TA-17).
"""

import calendar
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from pydantic import Field

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountType, Amount, Operation, YearMonth, _Entity
from opesvault.domain.money import ZERO


class Frequency(StrEnum):
    MONTHLY = "monthly"
    YEARLY = "yearly"
    WEEKLY = "weekly"


class RecurrenceRule(_Entity):
    description: str = Field(min_length=1, max_length=200)
    account_id: UUID  # where the money lands or leaves (bank account or card)
    counterpart_id: UUID  # category or other account
    amount: Amount  # expected value, positive
    tolerance: Amount = Decimal("0")  # accepted difference when matching
    frequency: Frequency = Frequency.MONTHLY
    day: int = Field(ge=1, le=31)
    start: date
    end: date | None = None
    paused: bool = False
    skipped: tuple[date, ...] = ()
    window_days: int = Field(default=5, ge=0, le=31)


class ForecastDecision(StrEnum):
    REALIZED = "realized"
    SKIPPED = "skipped"


class ForecastLink(_Entity):
    rule_id: UUID
    due_on: date
    decision: ForecastDecision
    operation_id: UUID | None = None


Ledger.register_kind("recurrence_rule", RecurrenceRule)
Ledger.register_kind("forecast_link", ForecastLink)


def rules(ledger: Ledger) -> dict[UUID, RecurrenceRule]:
    return ledger.entities("recurrence_rule")


def links(ledger: Ledger) -> dict[UUID, ForecastLink]:
    return ledger.entities("forecast_link")


def add_rule(ledger: Ledger, rule: RecurrenceRule) -> RecurrenceRule:
    if rule.account_id not in ledger.accounts or rule.counterpart_id not in ledger.accounts:
        raise DomainError("Conta ou categoria inexistente.")
    if rule.amount <= 0:
        raise DomainError("Informe um valor esperado positivo.")
    if rule.end is not None and rule.end < rule.start:
        raise DomainError("Fim antes do início.")
    return ledger.put("recurrence_rule", rule)


def update_rule(ledger: Ledger, rule: RecurrenceRule, reason: str) -> RecurrenceRule:
    if rule.id not in rules(ledger):
        raise DomainError("Regra inexistente.")
    return ledger.put("recurrence_rule", rule, reason=reason)


def direction(ledger: Ledger, rule: RecurrenceRule) -> int:
    """+1 when money enters `account_id`, −1 when it leaves."""
    counterpart = ledger.account(rule.counterpart_id)
    return 1 if counterpart.type is AccountType.INCOME else -1


def occurrences(rule: RecurrenceRule, start: date, end: date) -> list[date]:
    dates: list[date] = []
    if rule.frequency is Frequency.WEEKLY:
        cursor = rule.start
        while cursor <= end:
            if cursor >= start:
                dates.append(cursor)
            cursor += timedelta(days=7)
    else:
        step = 12 if rule.frequency is Frequency.YEARLY else 1
        month = YearMonth.of(rule.start)
        while month.first_day() <= end:
            day = min(rule.day, calendar.monthrange(month.year, month.month)[1])
            when = date(month.year, month.month, day)
            if when >= rule.start and start <= when <= end:
                dates.append(when)
            month = month.add(step)
    return [d for d in dates if (rule.end is None or d <= rule.end) and d not in rule.skipped]


class ForecastStatus(StrEnum):
    PENDING = "pending"
    REALIZED = "realized"
    SKIPPED = "skipped"
    LATE = "late"


@dataclass(frozen=True)
class Forecast:
    rule_id: UUID
    due_on: date
    amount: Decimal  # signed from the account's perspective
    description: str
    status: ForecastStatus
    operation_id: UUID | None = None


def forecasts(ledger: Ledger, start: date, end: date, today: date | None = None) -> list[Forecast]:
    today = today or date.today()
    decided = {(link.rule_id, link.due_on): link for link in links(ledger).values()}
    out: list[Forecast] = []
    for rule in rules(ledger).values():
        if rule.paused:
            continue
        sign = direction(ledger, rule)
        for when in occurrences(rule, start, end):
            link = decided.get((rule.id, when))
            if link is not None:
                status = (
                    ForecastStatus.REALIZED if link.decision is ForecastDecision.REALIZED else ForecastStatus.SKIPPED
                )
                out.append(Forecast(rule.id, when, sign * rule.amount, rule.description, status, link.operation_id))
            else:
                status = (
                    ForecastStatus.LATE if when + timedelta(days=rule.window_days) < today else ForecastStatus.PENDING
                )
                out.append(Forecast(rule.id, when, sign * rule.amount, rule.description, status))
    return sorted(out, key=lambda f: f.due_on)


def _op_value_on(op: Operation, account_id: UUID) -> Decimal:
    return sum((p.amount for p in op.postings if p.account_id == account_id), ZERO)


def candidates(ledger: Ledger, forecast: Forecast) -> list[Operation]:
    """Operations that may realize a forecast: same accounts, value within tolerance, date in window.
    The user confirms; nothing is linked automatically (docs/05 §6)."""
    rule = rules(ledger)[forecast.rule_id]
    linked_ops = {link.operation_id for link in links(ledger).values() if link.operation_id}
    out = []
    for op in ledger.active_operations():
        if op.id in linked_ops:
            continue
        when = op.cash_date or op.occurred_on
        if when is None or abs((when - forecast.due_on).days) > rule.window_days:
            continue
        accounts = {p.account_id for p in op.postings}
        if rule.account_id not in accounts or rule.counterpart_id not in accounts:
            continue
        value = _op_value_on(op, rule.account_id)
        account = ledger.account(rule.account_id)
        natural = value if account.type is AccountType.ASSET else -value
        if abs(natural - forecast.amount) <= rule.tolerance:
            out.append(op)
    return out


def realize(ledger: Ledger, rule_id: UUID, due_on: date, operation_id: UUID) -> ForecastLink:
    if any(link.rule_id == rule_id and link.due_on == due_on for link in links(ledger).values()):
        raise DomainError("Previsão já resolvida.")
    if operation_id not in ledger.operations:
        raise DomainError("Operação inexistente.")
    op = ledger.operations[operation_id]
    ledger.update_operation(op.model_copy(update={"forecast_id": rule_id}), reason="realiza previsão recorrente")
    return ledger.put(
        "forecast_link",
        ForecastLink(rule_id=rule_id, due_on=due_on, decision=ForecastDecision.REALIZED, operation_id=operation_id),
    )


def skip(ledger: Ledger, rule_id: UUID, due_on: date) -> ForecastLink:
    return ledger.put("forecast_link", ForecastLink(rule_id=rule_id, due_on=due_on, decision=ForecastDecision.SKIPPED))


def auto_suggestions(ledger: Ledger, start: date, end: date) -> list[tuple[Forecast, Operation]]:
    """Pending forecasts with exactly one candidate: offered to the user as one-click links."""
    out = []
    for forecast in forecasts(ledger, start, end):
        if forecast.status in (ForecastStatus.PENDING, ForecastStatus.LATE):
            found = candidates(ledger, forecast)
            if len(found) == 1:
                out.append((forecast, found[0]))
    return out
