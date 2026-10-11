"""Savings and net-worth goals: a target value, optionally by a date, with progress (docs/09 §1.3 C).

A goal tracks a value the ledger already knows (net worth, or the balance of chosen accounts);
it never moves money. "Quanto falta por mês" divides what is missing by the months left; the
recent pace is the average monthly change of the last months with records, never a guess.
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from pydantic import Field

from opesvault.domain import queries
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountType, Amount, YearMonth, _Entity
from opesvault.domain.money import ZERO, is_cents, round_money

PACE_MONTHS = 6


class GoalKind(StrEnum):
    NET_WORTH = "net_worth"  # patrimônio líquido da família
    ACCOUNTS = "accounts"  # saldo somado de contas escolhidas (reserva, viagem…)


KIND_LABELS = {GoalKind.NET_WORTH: "Patrimônio líquido", GoalKind.ACCOUNTS: "Saldo de contas escolhidas"}


class Goal(_Entity):
    name: str = Field(min_length=1, max_length=80)
    kind: GoalKind
    target: Amount
    target_date: date | None = None
    account_ids: tuple[UUID, ...] = ()
    created_on: date
    archived: bool = False
    version: int = 1


Ledger.register_kind("goal", Goal)


def goals(ledger: Ledger) -> list[Goal]:
    return sorted(ledger.entities("goal").values(), key=lambda g: (g.archived, g.name.casefold()))


def _validate(ledger: Ledger, goal: Goal) -> None:
    if not goal.name.strip():
        raise DomainError("Dê um nome à meta.")
    if goal.target <= 0 or not is_cents(goal.target):
        raise DomainError("Informe o valor da meta em reais e centavos.")
    if goal.kind is GoalKind.ACCOUNTS:
        if not goal.account_ids:
            raise DomainError("Escolha as contas que formam a meta.")
        for account_id in goal.account_ids:
            account = ledger.accounts.get(account_id)
            if account is None or account.type is not AccountType.ASSET:
                raise DomainError("Metas somam contas de ativo (conta, poupança, investimento).")
    if goal.target_date is not None and goal.target_date <= goal.created_on:
        raise DomainError("A data da meta precisa ser futura.")


def add_goal(ledger: Ledger, goal: Goal) -> Goal:
    _validate(ledger, goal)
    return ledger.put("goal", goal)


def update_goal(ledger: Ledger, goal: Goal, reason: str) -> Goal:
    current = ledger.entities("goal").get(goal.id)
    if current is None:
        raise DomainError("Meta inexistente.")
    _validate(ledger, goal)
    return ledger.put("goal", goal.model_copy(update={"version": current.version + 1}), reason=reason)


def value_of(ledger: Ledger, goal: Goal, at: date) -> Decimal:
    if goal.kind is GoalKind.NET_WORTH:
        return queries.net_worth(ledger, at).net
    return sum((queries.balance(ledger, a, at) for a in goal.account_ids if a in ledger.accounts), ZERO)


@dataclass(frozen=True)
class Progress:
    goal: Goal
    current: Decimal
    share: Decimal  # 0.42 = 42% (capped at 1)
    missing: Decimal  # zero when reached
    months_left: int | None
    needed_per_month: Decimal | None  # None without a date, or when already reached
    pace: Decimal | None  # average monthly change over the last months with records
    reached_on_pace: YearMonth | None  # when the recent pace reaches the target; None if it does not grow

    @property
    def reached(self) -> bool:
        return self.missing == 0


def progress(ledger: Ledger, goal: Goal, today: date | None = None) -> Progress:
    from opesvault.domain.comparisons import first_activity

    today = today or date.today()
    current = value_of(ledger, goal, today)
    missing = max(goal.target - current, ZERO)
    share = min(current / goal.target, Decimal(1)) if current > 0 else ZERO
    months_left = None
    needed = None
    if goal.target_date is not None:
        now, then = YearMonth.of(today), YearMonth.of(goal.target_date)
        months_left = max((then.year - now.year) * 12 + then.month - now.month, 0)
        if missing > 0:
            needed = round_money(missing / months_left) if months_left else missing
    pace = None
    reached_on = None
    first = first_activity(ledger)
    if first is not None:
        this = YearMonth.of(today)
        span = min(PACE_MONTHS, (this.year - first.year) * 12 + this.month - first.month)
        if span > 0:
            past = value_of(ledger, goal, this.add(-span).last_day())
            pace = round_money((current - past) / span)
            if missing > 0 and pace > 0:
                months = int((missing / pace).to_integral_value(rounding="ROUND_CEILING"))
                reached_on = this.add(months)
    return Progress(goal, current, share.quantize(Decimal("0.0001")), missing, months_left, needed, pace, reached_on)
