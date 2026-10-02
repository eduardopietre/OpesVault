from datetime import date
from decimal import Decimal

import pytest

from opesvault.domain import queries
from opesvault.domain.edits import reclassify
from opesvault.domain.ledger import DomainError
from opesvault.domain.model import Posting, YearMonth
from opesvault.domain.periods import close_month

from .domain_fixtures import category, family

JAN = YearMonth(year=2026, month=1)


def test_reclassify_single_category_operations() -> None:
    f = family()
    leisure = category(f.ledger, "Lazer")
    a = f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 1, 2), "Cinema")
    b = f.ledger.record_expense(f.bank, f.groceries, "20.00", date(2026, 1, 3), "Show")
    result = reclassify(f.ledger, [a.id, b.id], leisure, "eram lazer")
    assert result.changed == 2
    assert queries.expenses_by_category(f.ledger, JAN, JAN) == {leisure: Decimal("30.00")}
    assert f.ledger.history_of(a.id)[-1].reason == "eram lazer"


def test_split_is_not_collapsed_without_source() -> None:
    f = family()
    housing = category(f.ledger, "Moradia")
    leisure = category(f.ledger, "Lazer")
    op = f.ledger.record_expense(f.bank, [(f.groceries, "10"), (housing, "5")], "15", date(2026, 1, 2), "Misto")
    assert reclassify(f.ledger, [op.id], leisure, "x").changed == 0
    assert reclassify(f.ledger, [op.id], leisure, "x", source_id=housing).changed == 1
    assert {p.account_id for p in f.ledger.operations[op.id].postings} >= {f.groceries, leisure}


def test_reclassify_respects_closed_months_and_needs_reason() -> None:
    f = family()
    leisure = category(f.ledger, "Lazer")
    op = f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 1, 2), "Cinema")
    with pytest.raises(DomainError):
        reclassify(f.ledger, [op.id], leisure, " ")
    close_month(f.ledger, JAN)
    result = reclassify(f.ledger, [op.id], leisure, "tarde demais")
    assert result.changed == 0 and result.errors


def test_full_edit_changes_amount_accounts_and_split() -> None:
    f = family()
    op = f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 1, 2), "Mercado")
    edited = op.model_copy(
        update={
            "postings": (
                Posting(account_id=f.groceries, amount=Decimal("6.00"), member_id=f.ana),
                Posting(account_id=f.groceries, amount=Decimal("6.50"), member_id=f.bruno),
                Posting(account_id=f.joint, amount=Decimal("-12.50")),
            ),
            "settled_on": date(2026, 1, 3),
        }
    )
    f.ledger.update_operation(edited, "valor e conta corrigidos")
    assert queries.balance(f.ledger, f.joint) == Decimal("-12.50")
    assert queries.income_statement(f.ledger, JAN, member_id=f.bruno).total_expense == Decimal("6.50")
