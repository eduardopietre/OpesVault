from datetime import date
from decimal import Decimal

import pytest

from opesvault.domain import budget
from opesvault.domain.budget import BudgetState
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount, YearMonth

from .domain_fixtures import category, family

MAR = YearMonth(year=2026, month=3)
APR = YearMonth(year=2026, month=4)


def test_planned_actual_remaining_and_states() -> None:
    f = family()
    ledger = f.ledger
    food, transport = f.groceries, category(ledger, "Transporte")
    budget.set_budget(ledger, food, MAR, "1000.00")
    budget.set_budget(ledger, transport, MAR, "100.00")
    # Card purchase counts in March (competence), the April bill payment does not repeat it.
    ledger.record_card_purchase(f.card, food, "950.00", date(2026, 3, 10), "Mercado")
    ledger.record_card_payment(f.card, f.bank, "950.00", date(2026, 4, 10))
    ledger.record_expense(f.bank, transport, "130.00", date(2026, 3, 12), "Combustível")
    ledger.record_expense(f.bank, category(ledger, "Lazer"), "40.00", date(2026, 3, 13), "Cinema")
    s = budget.status(ledger, MAR)
    rows = {r.category_id: r for r in s.rows}
    assert rows[food].actual == Decimal("950.00") and rows[food].remaining == Decimal("50.00")
    assert rows[food].state is BudgetState.NEAR  # 95%
    assert rows[transport].state is BudgetState.OVER and rows[transport].remaining == Decimal("-30.00")
    assert s.over == (rows[transport],)
    assert s.unbudgeted == Decimal("40.00")
    assert (s.total_planned, s.total_actual) == (Decimal("1100.00"), Decimal("1080.00"))
    assert budget.status(ledger, APR).rows == ()


def test_parent_budget_covers_sub_categories() -> None:
    f = family()
    ledger = f.ledger
    food = f.groceries
    snacks = ledger.add_account(
        LedgerAccount(name="Lanches", type=AccountType.EXPENSE, subtype=AccountSubtype.CATEGORY, parent_id=food)
    ).id
    budget.set_budget(ledger, food, MAR, "500.00")
    budget.set_budget(ledger, snacks, MAR, "50.00")
    ledger.record_expense(f.bank, snacks, "60.00", date(2026, 3, 2), "Lanche")
    ledger.record_expense(f.bank, food, "100.00", date(2026, 3, 3), "Feira")
    rows = {r.category_id: r for r in budget.status(ledger, MAR).rows}
    assert rows[food].actual == Decimal("160.00") and rows[snacks].state is BudgetState.OVER
    s = budget.status(ledger, MAR)
    assert s.total_planned == Decimal("500.00")  # the child plan is inside the parent's


def test_copy_update_remove_and_validation() -> None:
    f = family()
    ledger = f.ledger
    budget.set_budget(ledger, f.groceries, MAR, "800.00")
    assert budget.copy_month(ledger, MAR, APR) == 1
    assert budget.copy_month(ledger, MAR, APR) == 0  # never overwrites by default
    line = budget.set_budget(ledger, f.groceries, APR, "900.00")
    assert line.version == 2 and ledger.history_of(line.id)[-1].reason == "valor do orçamento alterado"
    budget.remove_budget(ledger, f.groceries, APR)
    assert budget.line_for(ledger, f.groceries, APR) is None
    with pytest.raises(DomainError):
        budget.set_budget(ledger, f.salary, MAR, "10.00")  # income category
    with pytest.raises(DomainError):
        budget.set_budget(ledger, f.groceries, MAR, "0")
    with pytest.raises(DomainError):
        budget.set_budget(ledger, f.groceries, MAR, "1.001")
    restored = Ledger.from_records(ledger.to_records())
    assert budget.line_for(restored, f.groceries, MAR) is not None
