from datetime import date
from decimal import Decimal

import pytest

from opesvault.domain import queries
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype
from opesvault.domain.onboarding import AccountPlan, CardPlan, SetupPlan, apply_setup


def plan(**changes: object) -> SetupPlan:
    base = SetupPlan(
        members=("Ana", "Bruno"),
        accounts=(
            AccountPlan("Banco A", AccountSubtype.CHECKING, ("Ana",), "Banco", Decimal("1500.00"), date(2026, 1, 1)),
            AccountPlan("Conjunta", AccountSubtype.CHECKING, ("Ana", "Bruno")),
            AccountPlan("Financiamento", AccountSubtype.LOAN, (), None, Decimal("90000.00"), date(2026, 1, 1)),
        ),
        cards=(CardPlan("Cartão Ana", "Ana", "1234", 3, 10, "Banco A"),),
    )
    from dataclasses import replace

    return replace(base, **changes)  # type: ignore[arg-type]


def test_setup_creates_everything() -> None:
    ledger = Ledger.new("Família")
    result = apply_setup(ledger, plan())
    assert (result.members, result.accounts, result.cards, result.opening_balances) == (2, 3, 1, 2)
    accounts = {a.name: a for a in ledger.accounts.values()}
    assert queries.balance(ledger, accounts["Banco A"].id) == Decimal("1500.00")
    assert queries.balance(ledger, accounts["Conjunta"].id) == Decimal("0")
    # A liability balance is reported as the amount owed.
    assert queries.balance(ledger, accounts["Financiamento"].id) == Decimal("90000.00")
    card = next(iter(ledger.cards.values()))
    assert card.settlement_account_id == accounts["Banco A"].id
    assert accounts["Cartão Ana"].subtype is AccountSubtype.CREDIT_CARD
    assert len(accounts["Conjunta"].holders) == 2


@pytest.mark.parametrize(
    "changes",
    [
        {"members": ("Ana", "ana")},
        {"members": ("Ana", " ")},
        {"accounts": (AccountPlan("X", AccountSubtype.CHECKING, ("Carla",)),)},
        {"accounts": (AccountPlan("X", AccountSubtype.CHECKING, (), None, Decimal("1"), None),)},
        {"accounts": (AccountPlan("X", AccountSubtype.CHECKING), AccountPlan("x", AccountSubtype.SAVINGS))},
        {"accounts": (AccountPlan("X", AccountSubtype.CREDIT_CARD),)},
        {"cards": (CardPlan("C", "Ana", "12a4", 3, 10),)},
        {"cards": (CardPlan("C", "Ana", "1234", 0, 10),)},
        {"cards": (CardPlan("C", "Zé", "1234", 3, 10),)},
        {"cards": (CardPlan("C", "Ana", "1234", 3, 10, "Inexistente"),)},
        # Only the domain knows a loan cannot pay a card: caught by the dry run.
        {"cards": (CardPlan("C", "Ana", "1234", 3, 10, "Financiamento"),)},
    ],
)
def test_invalid_plan_changes_nothing(changes: dict[str, object]) -> None:
    ledger = Ledger.new("Família")
    before = ledger.change_count
    with pytest.raises(DomainError):
        apply_setup(ledger, plan(**changes))
    assert ledger.change_count == before
