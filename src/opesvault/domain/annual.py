"""Year-end summary: support material for the annual tax return (docs/09 §1.3 C, docs/00 §5).

What the family already recorded, organized by year: balances on 31/12 (and a year before),
income by category, investment income, tax withheld, realized gains and deductible expenses.
It is not the tax return: it applies no legal rule, classifies nothing as exempt or taxable
on its own, and every figure keeps its quality (incomplete events are counted and flagged).
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from uuid import UUID

from opesvault.domain import queries
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountType, YearMonth
from opesvault.domain.money import ZERO

NOTICE = (
    "Material de apoio à declaração anual, a partir do que foi registrado. Não aplica regras fiscais "
    "nem classifica rendimentos como isentos ou tributáveis; confira com os informes das instituições."
)


@dataclass(frozen=True)
class BalanceLine:
    account_id: UUID
    name: str
    kind: AccountType
    year_end: Decimal
    previous_year_end: Decimal


@dataclass
class AnnualSummary:
    year: int
    balances: list[BalanceLine] = field(default_factory=list)
    income: dict[UUID, Decimal] = field(default_factory=dict)  # by income category, competence
    expense_total: Decimal = ZERO
    investment_income: Decimal = ZERO  # distributions received (gross when known)
    tax_withheld: Decimal = ZERO
    realized_gains: Decimal = ZERO
    incomplete_events: int = 0  # redemptions without gross or cost: not in the gains

    @property
    def net_worth(self) -> Decimal:
        return sum((b.year_end if b.kind is AccountType.ASSET else -b.year_end for b in self.balances), ZERO)


def annual(ledger: Ledger, year: int) -> AnnualSummary:
    from opesvault.investments.model import EventKind
    from opesvault.investments.service import events

    summary = AnnualSummary(year)
    end, before = date(year, 12, 31), date(year - 1, 12, 31)
    now, then = queries.balances(ledger, end), queries.balances(ledger, before)
    for account in sorted(ledger.accounts.values(), key=lambda a: (a.type.value, a.name.casefold())):
        if account.type not in (AccountType.ASSET, AccountType.LIABILITY):
            continue
        value, previous = now.get(account.id, ZERO), then.get(account.id, ZERO)
        if value or previous:
            summary.balances.append(BalanceLine(account.id, account.name, account.type, value, previous))
    income: dict[UUID, Decimal] = defaultdict(lambda: ZERO)
    for month in range(1, 13):
        statement = queries.income_statement(ledger, YearMonth(year=year, month=month))
        for category_id, value in statement.income.items():
            income[category_id] += value
        summary.expense_total += statement.total_expense
    summary.income = {k: v for k, v in income.items() if v}
    for event in events(ledger).values():
        if event.on.year != year:
            continue
        summary.tax_withheld += event.tax_withheld
        if event.kind is EventKind.DISTRIBUTION:
            summary.investment_income += event.gross if event.gross is not None else (event.net or ZERO)
        if event.kind in (EventKind.WITHDRAWAL, EventKind.SELL):
            gain = event.realized_gain
            if gain is None:
                summary.incomplete_events += 1
            else:
                summary.realized_gains += gain
    return summary
