"""Monthly budget per expense category: planned, actual by competence, remaining (docs/09 §1.3).

A budget is a plan, not a financial fact: it never touches balances or results. The
actual comes from the same competence view as the overview, so card purchases count
in the month they happened, refunds reduce it and bill payments do not repeat it.
A budget on a parent category covers its sub-categories.
"""

from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from opesvault.domain import queries
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, Amount, YearMonth, _Entity
from opesvault.domain.money import ROUND_HALF_UP, ZERO, is_cents, to_decimal

NEAR_LIMIT = Decimal("0.9")  # warn from 90% of the plan


class BudgetLine(_Entity):
    category_id: UUID
    month: YearMonth
    amount: Amount
    version: int = 1


Ledger.register_kind("budget_line", BudgetLine)


class BudgetState(StrEnum):
    OK = "ok"
    NEAR = "near"
    OVER = "over"


@dataclass(frozen=True)
class BudgetRow:
    category_id: UUID
    name: str
    planned: Decimal
    actual: Decimal
    remaining: Decimal  # negative when over
    used: Decimal  # actual / planned, e.g. 0.82
    state: BudgetState


@dataclass(frozen=True)
class BudgetStatus:
    month: YearMonth
    rows: tuple[BudgetRow, ...]
    total_planned: Decimal
    total_actual: Decimal  # budgeted categories only
    unbudgeted: Decimal  # spending in categories without a plan

    @property
    def over(self) -> tuple[BudgetRow, ...]:
        return tuple(r for r in self.rows if r.state is BudgetState.OVER)

    @property
    def near(self) -> tuple[BudgetRow, ...]:
        return tuple(r for r in self.rows if r.state is BudgetState.NEAR)


def lines(ledger: Ledger) -> dict[UUID, BudgetLine]:
    return ledger.entities("budget_line")


def lines_of(ledger: Ledger, month: YearMonth) -> list[BudgetLine]:
    return [line for line in lines(ledger).values() if line.month == month]


def line_for(ledger: Ledger, category_id: UUID, month: YearMonth) -> BudgetLine | None:
    return next((x for x in lines(ledger).values() if x.category_id == category_id and x.month == month), None)


def _expense_category(ledger: Ledger, category_id: UUID) -> None:
    account = ledger.accounts.get(category_id)
    if account is None or account.type is not AccountType.EXPENSE or account.subtype is not AccountSubtype.CATEGORY:
        raise DomainError("O orçamento é definido para categorias de despesa.")


def set_budget(ledger: Ledger, category_id: UUID, month: YearMonth, amount: object) -> BudgetLine:
    _expense_category(ledger, category_id)
    value = to_decimal(amount)
    if value <= 0:
        raise DomainError("Informe um valor positivo para o orçamento.")
    if not is_cents(value):
        raise DomainError("Use valores em centavos.")
    current = line_for(ledger, category_id, month)
    if current is None:
        return ledger.put("budget_line", BudgetLine(category_id=category_id, month=month, amount=value))
    if current.amount == value:
        return current
    updated = current.model_copy(update={"amount": value, "version": current.version + 1})
    return ledger.put("budget_line", updated, reason="valor do orçamento alterado")


def remove_budget(ledger: Ledger, category_id: UUID, month: YearMonth) -> None:
    current = line_for(ledger, category_id, month)
    if current is not None:
        del lines(ledger)[current.id]


def copy_month(ledger: Ledger, source: YearMonth, target: YearMonth, *, overwrite: bool = False) -> int:
    """Repeats last month's plan; existing lines of the target month stay unless overwrite."""
    copied = 0
    for line in lines_of(ledger, source):
        if not overwrite and line_for(ledger, line.category_id, target) is not None:
            continue
        set_budget(ledger, line.category_id, target, line.amount)
        copied += 1
    return copied


def _ancestors(ledger: Ledger, category_id: UUID) -> list[UUID]:
    chain, seen = [category_id], {category_id}
    account = ledger.accounts.get(category_id)
    while account is not None and account.parent_id is not None and account.parent_id not in seen:
        chain.append(account.parent_id)
        seen.add(account.parent_id)
        account = ledger.accounts.get(account.parent_id)
    return chain


def status(ledger: Ledger, month: YearMonth) -> BudgetStatus:
    spending = queries.expenses_by_category(ledger, month, month)
    planned = {line.category_id: line.amount for line in lines_of(ledger, month)}
    actual = dict.fromkeys(planned, ZERO)
    unbudgeted = ZERO
    for category_id, value in spending.items():
        covering = [c for c in _ancestors(ledger, category_id) if c in planned]
        if not covering:
            unbudgeted += value
        for c in covering:  # a parent's plan covers its sub-categories
            actual[c] += value
    rows = []
    for category_id, plan in planned.items():
        spent = actual[category_id]
        used = (spent / plan).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
        state = BudgetState.OVER if spent > plan else BudgetState.NEAR if used >= NEAR_LIMIT else BudgetState.OK
        account = ledger.accounts.get(category_id)
        rows.append(BudgetRow(category_id, account.name if account else "?", plan, spent, plan - spent, used, state))
    rows.sort(key=lambda r: (-r.used, r.name.casefold()))
    top_level = [c for c in planned if not any(a in planned for a in _ancestors(ledger, c)[1:])]
    return BudgetStatus(
        month=month,
        rows=tuple(rows),
        total_planned=sum((planned[c] for c in top_level), ZERO),
        total_actual=sum((actual[c] for c in top_level), ZERO),
        unbudgeted=unbudgeted,
    )
