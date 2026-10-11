"""Manual balance check for accounts without import (docs/09 §1.3 E, RF-08).

The user types the balance the bank shows on a date; the app compares it with its own
balance on that date. A difference is shown, never adjusted silently: the fix is to find
the missing or wrong operation. The comparison is live, so registering the missing
operation clears it.
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from uuid import UUID

from pydantic import Field

from opesvault.domain import queries
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountType, Amount, _Entity
from opesvault.domain.money import is_cents, to_decimal


class BalanceCheck(_Entity):
    account_id: UUID
    on: date
    informed: Amount  # the account's balance as the bank shows it (natural sign: owed amount for debts)
    note: str | None = Field(default=None, max_length=500)


Ledger.register_kind("balance_check", BalanceCheck)


def checks(ledger: Ledger) -> dict[UUID, BalanceCheck]:
    return ledger.entities("balance_check")


def record(ledger: Ledger, account_id: UUID, on: date, informed: object, note: str | None = None) -> BalanceCheck:
    account = ledger.accounts.get(account_id)
    if account is None or account.type not in (AccountType.ASSET, AccountType.LIABILITY):
        raise DomainError("Escolha uma conta.")
    value = to_decimal(informed)
    if not is_cents(value):
        raise DomainError("Informe o saldo em reais e centavos.")
    return ledger.put(
        "balance_check", BalanceCheck(account_id=account_id, on=on, informed=value, note=(note or "").strip() or None)
    )


def remove(ledger: Ledger, check_id: UUID) -> None:
    if check_id in checks(ledger):
        del checks(ledger)[check_id]


@dataclass(frozen=True)
class CheckResult:
    check: BalanceCheck
    computed: Decimal  # the app's balance at the end of that day

    @property
    def difference(self) -> Decimal:
        """Bank minus app: positive means the bank shows more than the app."""
        return self.check.informed - self.computed

    @property
    def matches(self) -> bool:
        return self.difference == 0


def results(ledger: Ledger, account_id: UUID | None = None) -> list[CheckResult]:
    """Newest first."""
    out = [
        CheckResult(c, queries.balance(ledger, c.account_id, c.on))
        for c in checks(ledger).values()
        if account_id is None or c.account_id == account_id
    ]
    return sorted(out, key=lambda r: (r.check.on, str(r.check.id)), reverse=True)


def latest(ledger: Ledger) -> dict[UUID, CheckResult]:
    """The most recent check of each account."""
    out: dict[UUID, CheckResult] = {}
    for result in results(ledger):
        out.setdefault(result.check.account_id, result)
    return out


def divergent(ledger: Ledger) -> list[CheckResult]:
    """Accounts whose latest check does not match the app (alerts)."""
    return [r for r in latest(ledger).values() if not r.matches and r.check.account_id in ledger.accounts]
