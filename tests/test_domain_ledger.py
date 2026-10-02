from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest

from opesvault.domain import queries
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import (
    AccountSubtype,
    AccountType,
    HistoryAction,
    LedgerAccount,
    Operation,
    OperationKind,
    Posting,
    YearMonth,
)
from opesvault.domain.money import MoneyError, allocate, format_brl, parse_brl, round_money, to_decimal
from opesvault.session import Session

from .domain_fixtures import category, family

JAN = YearMonth(year=2026, month=1)


def _p(account, amount: str) -> Posting:  # type: ignore[no-untyped-def]
    return Posting(account_id=account, amount=Decimal(amount))


FEB = YearMonth(year=2026, month=2)


# ── money ───────────────────────────────────────────


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("1.234,56", "1234.56"),
        ("R$ 1.234,56", "1234.56"),
        ("-R$ 10,00", "-10.00"),
        ("R$ -10,00", "-10.00"),
        ("−R$ 3,50", "-3.50"),
        ("40,00-", "-40.00"),
        ("538,12 D", "-538.12"),
        ("538,12 C", "538.12"),
        ("0,02", "0.02"),
        ("12", "12"),
    ],
)
def test_parse_brl(text: str, expected: str) -> None:
    assert parse_brl(text) == Decimal(expected)


@pytest.mark.parametrize("text", ["", "abc", "1,2,3", "-10,00-", "1.23,45"])
def test_parse_brl_rejects_ambiguous(text: str) -> None:
    with pytest.raises(MoneyError):
        parse_brl(text)


def test_floats_are_rejected() -> None:
    with pytest.raises(MoneyError):
        to_decimal(0.1)
    with pytest.raises(ValueError, match="float"):
        Posting(account_id=uuid4(), amount=0.1)  # type: ignore[arg-type]


def test_rounding_is_half_away_from_zero() -> None:
    assert round_money(Decimal("0.125")) == Decimal("0.13")
    assert round_money(Decimal("-0.125")) == Decimal("-0.13")
    assert round_money(Decimal("0.135")) == Decimal("0.14")


def test_format_brl() -> None:
    assert format_brl(Decimal("1234567.5")) == "R$ 1.234.567,50"
    assert format_brl(Decimal("-0.5")) == "-R$ 0,50"
    assert format_brl(Decimal("3"), sign=True) == "+R$ 3,00"


def test_allocate_is_exact() -> None:
    """TA-32: rateio sums exactly, residual cents assigned explicitly."""
    parts = allocate(Decimal("100.00"), [Decimal(1), Decimal(1), Decimal(1)])
    assert sum(parts) == Decimal("100.00")
    assert sorted(parts) == [Decimal("33.33"), Decimal("33.33"), Decimal("33.34")]


# ── invariants ──────────────────────────────────────


def test_unbalanced_operation_is_rejected() -> None:
    f = family()
    with pytest.raises(DomainError):
        f.ledger.add_operation(
            Operation(
                kind=OperationKind.OTHER,
                description="x",
                postings=(
                    _p(f.bank, "10"),
                    _p(f.groceries, "-9.99"),
                ),
            )
        )


def test_fractions_of_cent_are_rejected_for_brl() -> None:
    f = family()
    with pytest.raises(DomainError):
        f.ledger.record_expense(f.bank, f.groceries, "10.001", date(2026, 1, 5), "x")


def test_unknown_account_is_rejected() -> None:
    f = family()
    with pytest.raises(DomainError):
        f.ledger.record_expense(f.bank, uuid4(), "10", date(2026, 1, 5), "x")


def test_opening_balance_is_equity_not_income() -> None:
    f = family()
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2026, 1, 1))
    statement = queries.income_statement(f.ledger, JAN)
    assert statement.total_income == 0
    assert queries.balance(f.ledger, f.bank) == Decimal("1000.00")
    assert queries.net_worth(f.ledger).net == Decimal("1000.00")


def test_opening_balance_of_a_card_is_a_debt() -> None:
    f = family()
    f.ledger.record_opening_balance(f.card_account, "300.00", date(2026, 1, 1))
    assert queries.net_worth(f.ledger).liabilities == Decimal("300.00")


# ── accounting scenarios (docs/08) ───────────────────


def test_card_purchase_and_bill_payment_ta15() -> None:
    f = family()
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2026, 1, 1))
    f.ledger.record_card_purchase(f.card, f.groceries, "100.00", date(2026, 1, 5), "Mercado")
    f.ledger.record_card_payment(f.card, f.bank, "100.00", date(2026, 2, 10))

    assert queries.expenses_by_category(f.ledger, JAN, FEB) == {f.groceries: Decimal("100.00")}
    assert queries.balance(f.ledger, f.card_account) == 0
    assert queries.balance(f.ledger, f.bank) == Decimal("900.00")
    flows = queries.cash_flow(f.ledger, JAN, FEB)
    assert flows[JAN].outflow == 0  # the purchase did not touch cash
    assert flows[FEB].outflow == Decimal("100.00")


def test_own_transfer_ta16() -> None:
    f = family()
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2026, 1, 1))
    f.ledger.record_transfer(f.bank, f.savings, "500.00", date(2026, 1, 15))
    assert queries.income_statement(f.ledger, JAN).total_income == 0
    assert queries.net_worth(f.ledger).net == Decimal("1000.00")
    flows = queries.cash_flow(f.ledger, JAN, JAN)
    assert flows[JAN].inflow == 0 and flows[JAN].outflow == 0
    # Seen from the bank account alone, the transfer is an outflow.
    only_bank = queries.cash_flow(f.ledger, JAN, JAN, accounts=[f.bank])
    assert only_bank[JAN].outflow == Decimal("500.00")


def test_joint_account_counts_once_ta18() -> None:
    f = family()
    f.ledger.record_opening_balance(f.joint, "2000.00", date(2026, 1, 1))
    assert queries.net_worth(f.ledger).assets == Decimal("2000.00")


def test_rateio_by_member() -> None:
    f = family()
    f.ledger.record_opening_balance(f.joint, "2000.00", date(2026, 1, 1))
    ana_part, bruno_part = allocate(Decimal("100.01"), [Decimal(1), Decimal(1)])
    f.ledger.add_operation(
        Operation(
            kind=OperationKind.EXPENSE,
            description="Mercado",
            postings=(
                Posting(account_id=f.groceries, amount=ana_part, member_id=f.ana),
                Posting(account_id=f.groceries, amount=bruno_part, member_id=f.bruno),
                _p(f.joint, "-100.01"),
            ),
            occurred_on=date(2026, 1, 3),
        )
    )
    total = queries.income_statement(f.ledger, JAN).total_expense
    ana = queries.income_statement(f.ledger, JAN, member_id=f.ana).total_expense
    bruno = queries.income_statement(f.ledger, JAN, member_id=f.bruno).total_expense
    assert total == ana + bruno == Decimal("100.01")


def test_split_must_sum_total() -> None:
    f = family()
    housing = category(f.ledger, "Moradia")
    with pytest.raises(DomainError):
        f.ledger.record_expense(f.bank, [(f.groceries, "10"), (housing, "5")], "20", date(2026, 1, 1), "x")
    op = f.ledger.record_expense(f.bank, [(f.groceries, "10"), (housing, "5")], "15", date(2026, 1, 1), "x")
    assert len(op.postings) == 3


def test_salary_income_and_competence() -> None:
    f = family()
    f.ledger.record_income(f.bank, f.salary, "5000.00", date(2026, 2, 5), "Salário", accrual_month=JAN)
    assert queries.income_statement(f.ledger, JAN).total_income == Decimal("5000.00")
    assert queries.income_statement(f.ledger, FEB).total_income == 0
    assert queries.cash_flow(f.ledger, FEB, FEB)[FEB].inflow == Decimal("5000.00")


def test_unknown_date_is_not_filled() -> None:
    f = family()
    op = f.ledger.add_operation(
        Operation(
            kind=OperationKind.EXPENSE,
            description="sem data",
            postings=(
                _p(f.groceries, "5"),
                _p(f.bank, "-5"),
            ),
        )
    )
    assert op.cash_date is None and op.competence is None
    assert queries.balance(f.ledger, f.bank, at=date(2030, 1, 1)) == 0


# ── history and corrections (RF-22) ─────────────────


def test_correction_keeps_previous_version_and_reason() -> None:
    f = family()
    f.ledger.operator = "Ana"
    op = f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 1, 1), "Padaria")
    fixed = op.model_copy(
        update={
            "postings": (
                _p(f.groceries, "12.00"),
                _p(f.bank, "-12.00"),
            )
        }
    )
    with pytest.raises(DomainError):
        f.ledger.update_operation(fixed, reason=" ")
    f.ledger.update_operation(fixed, reason="valor errado")
    entries = f.ledger.history_of(op.id)
    assert [e.action for e in entries] == [HistoryAction.CREATE, HistoryAction.UPDATE]
    assert entries[1].reason == "valor errado" and entries[1].operator == "Ana"
    before = entries[1].before
    assert before is not None and before["postings"] == [
        {"account_id": str(f.groceries), "amount": "10.00", "member_id": None},
        {"account_id": str(f.bank), "amount": "-10.00", "member_id": None},
    ]
    assert f.ledger.operations[op.id].version == 2


def test_cancel_and_reverse() -> None:
    f = family()
    f.ledger.record_opening_balance(f.bank, "100.00", date(2026, 1, 1))
    op = f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 1, 2), "x")
    f.ledger.reverse_operation(op.id, date(2026, 1, 3), "compra devolvida")
    assert queries.balance(f.ledger, f.bank) == Decimal("100.00")
    with pytest.raises(DomainError):
        f.ledger.cancel_operation(op.id, "")
    f.ledger.cancel_operation(op.id, "lançado em duplicidade")
    assert not f.ledger.operations[op.id].active


def test_member_names_are_unique() -> None:
    f = family()
    with pytest.raises(DomainError):
        f.ledger.add_member("ana")


def test_card_requires_credit_card_account() -> None:
    f = family()
    from opesvault.domain.model import Card

    with pytest.raises(DomainError):
        f.ledger.add_card(
            Card(name="x", liability_account_id=f.bank, holder_id=f.ana, last4="0000", closing_day=1, due_day=8)
        )


def test_category_cycle_is_rejected() -> None:
    f = family()
    parent = f.ledger.add_account(LedgerAccount(name="Pai", type=AccountType.EXPENSE, subtype=AccountSubtype.CATEGORY))
    child = f.ledger.add_account(
        LedgerAccount(name="Filho", type=AccountType.EXPENSE, subtype=AccountSubtype.CATEGORY, parent_id=parent.id)
    )
    with pytest.raises(DomainError):
        f.ledger.update_account(parent.model_copy(update={"parent_id": child.id}), "x")


# ── persistence ─────────────────────────────────────


def test_records_roundtrip() -> None:
    f = family()
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2026, 1, 1))
    f.ledger.record_card_purchase(f.card, f.groceries, "99.99", date(2026, 1, 5), "Mercado")
    restored = Ledger.from_records(f.ledger.to_records())
    assert restored.operations == f.ledger.operations
    assert restored.accounts == f.ledger.accounts
    assert restored.cards == f.ledger.cards
    assert len(restored.history) == len(f.ledger.history)
    assert restored.change_count == 0
    assert queries.balance(restored, f.bank) == Decimal("1000.00")


def test_newer_schema_is_refused() -> None:
    rows = Ledger.new("x").to_records()
    rows[0] = (rows[0][0], rows[0][1], {**rows[0][2], "schema_version": 999})
    with pytest.raises(DomainError):
        Ledger.from_records(rows)


def test_unknown_kind_is_refused() -> None:
    rows = [*Ledger.new("x").to_records(), (uuid4(), "future_thing", {})]
    with pytest.raises(DomainError):
        Ledger.from_records(rows)


def test_session_vault_roundtrip(tmp_path) -> None:  # type: ignore[no-untyped-def]
    from opesvault.vault import sqlcipher_store as store

    session = Session.new(tmp_path / "f.opesvault", "Silva")
    bank = session.ledger.add_account(
        LedgerAccount(name="Banco", type=AccountType.ASSET, subtype=AccountSubtype.CHECKING)
    )
    session.ledger.record_opening_balance(bank.id, "123.45", date(2026, 1, 1))
    frozen = session.freeze()
    info = store.save(session.path, "pw", frozen.snapshot, None)
    _, snapshot = store.load(session.path, "pw")
    reopened = Session.from_snapshot(session.path, info, snapshot)
    assert reopened.ledger.meta.family_name == "Silva"
    assert queries.balance(reopened.ledger, bank.id) == Decimal("123.45")
    assert not reopened.dirty


def test_registry_loads_every_kind_in_a_fresh_process() -> None:
    import subprocess
    import sys

    code = (
        "from opesvault.domain.ledger import Ledger; Ledger();"
        "kinds = set(Ledger.KINDS);"
        "expected = {'installment_plan','recurrence_rule','forecast_link','period_close','settings',"
        "'import_batch','evidence','extracted_item','asset','position','valuation','investment_event','tax_rule'};"
        "missing = expected - kinds; assert not missing, missing;"
        "assert Ledger._operation_guards and Ledger._update_guards"
    )
    subprocess.run([sys.executable, "-c", code], check=True)
