"""Month against the recent average and against the same month last year (docs/09 §1.3 E).

"Gastei mais que o normal?" Months before the family started recording are unknown,
not zero: they never enter an average, and a comparison without known months is None.
"""

from dataclasses import dataclass
from decimal import Decimal
from uuid import UUID

from opesvault.domain import queries
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountType, OperationKind, YearMonth
from opesvault.domain.money import ZERO, round_money

DEFAULT_WINDOW = 3


def first_activity(ledger: Ledger) -> YearMonth | None:
    """The first competence month with income or expense: before it, nothing is known."""
    from opesvault.domain.queries import index

    found = None
    for month, ops in index(ledger).by_competence.items():
        if found is not None and not month < found:
            continue
        for op in ops:
            if op.kind is OperationKind.OPENING_BALANCE:
                continue
            if any(ledger.account(p.account_id).type in (AccountType.INCOME, AccountType.EXPENSE) for p in op.postings):
                found = month
                break
    return found


def known_months(ledger: Ledger, months: list[YearMonth]) -> list[YearMonth]:
    first = first_activity(ledger)
    return [m for m in months if first is not None and first <= m]


@dataclass(frozen=True)
class Comparison:
    category_id: UUID | None  # None for the totals
    name: str
    current: Decimal
    average: Decimal | None
    months_averaged: int
    last_year: Decimal | None

    @property
    def delta(self) -> Decimal | None:
        return None if self.average is None else self.current - self.average

    @property
    def change(self) -> Decimal | None:
        """Relative to the average: 0.25 = 25% above. None without an average or with a zero one."""
        if self.average is None or self.average == 0:
            return None
        return (self.current / self.average - 1).quantize(Decimal("0.0001"))


def _average(values: list[Decimal]) -> Decimal | None:
    return round_money(sum(values, ZERO) / len(values)) if values else None


def category_comparison(ledger: Ledger, month: YearMonth, window: int = DEFAULT_WINDOW) -> list[Comparison]:
    """Expense per category: this month, the average of the `window` months before, and a year ago."""
    previous = known_months(ledger, [month.add(-i) for i in range(1, window + 1)])
    year_ago = month.add(-12)
    has_year_ago = bool(known_months(ledger, [year_ago]))
    current = queries.expenses_by_category(ledger, month, month)
    history = [queries.expenses_by_category(ledger, m, m) for m in previous]
    last_year = queries.expenses_by_category(ledger, year_ago, year_ago) if has_year_ago else {}
    categories = set(current) | {c for totals in history for c in totals}
    out = []
    for category_id in categories:
        out.append(
            Comparison(
                category_id,
                ledger.account(category_id).name,
                current.get(category_id, ZERO),
                _average([totals.get(category_id, ZERO) for totals in history]),
                len(history),
                last_year.get(category_id, ZERO) if has_year_ago else None,
            )
        )
    return sorted(out, key=lambda c: (-c.current, -(c.average or ZERO), c.name.casefold()))


def totals_comparison(ledger: Ledger, month: YearMonth, window: int = DEFAULT_WINDOW) -> list[Comparison]:
    """Income, expense and result (competence) against the average and a year ago."""
    previous = known_months(ledger, [month.add(-i) for i in range(1, window + 1)])
    year_ago = month.add(-12)
    has_year_ago = bool(known_months(ledger, [year_ago]))
    now = queries.income_statement(ledger, month)
    past = [queries.income_statement(ledger, m) for m in previous]
    then = queries.income_statement(ledger, year_ago) if has_year_ago else None
    rows = (
        ("Receitas", lambda s: s.total_income),
        ("Despesas", lambda s: s.total_expense),
        ("Resultado", lambda s: s.result),
    )
    return [
        Comparison(
            None,
            name,
            value(now),
            _average([value(s) for s in past]),
            len(past),
            value(then) if then is not None else None,
        )
        for name, value in rows
    ]
