from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from opesvault.domain import queries
from opesvault.domain.cards import (
    BillStatus,
    CompetencePolicy,
    bills,
    cycle_by_due_month,
    cycle_for,
    plans,
    record_installment_purchase,
    schedule,
)
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import YearMonth
from opesvault.domain.periods import close_month, is_closed, pending_items, reopen_month
from opesvault.domain.recurrence import (
    ForecastStatus,
    RecurrenceRule,
    add_rule,
    auto_suggestions,
    candidates,
    forecasts,
    realize,
    skip,
)

from .domain_fixtures import Family, family

D = Decimal
JAN, FEB, MAR, APR = (YearMonth(year=2026, month=m) for m in (1, 2, 3, 4))


# ── bill cycles ──────────────────────────────────────


def test_cycle_closing_and_due() -> None:
    f = family()  # card closes on day 3, due on day 10
    card = f.ledger.cards[f.card]
    assert cycle_for(card, date(2026, 1, 2)).due == date(2026, 1, 10)
    assert cycle_for(card, date(2026, 1, 3)).due == date(2026, 1, 10)
    assert cycle_for(card, date(2026, 1, 4)).due == date(2026, 2, 10)
    assert cycle_by_due_month(card, FEB).closing == date(2026, 2, 3)


def test_cycle_due_next_month_and_short_months() -> None:
    f = family()
    card = f.ledger.cards[f.card].model_copy(update={"closing_day": 31, "due_day": 8})
    cycle = cycle_for(card, date(2026, 2, 15))
    assert cycle.closing == date(2026, 2, 28) and cycle.due == date(2026, 3, 8)


def test_bill_totals_status_and_payment() -> None:
    f = family()
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2026, 1, 1))
    f.ledger.record_card_purchase(f.card, f.groceries, "100.00", date(2026, 1, 5), "Mercado")
    f.ledger.record_card_purchase(f.card, f.groceries, "50.00", date(2026, 1, 20), "Feira")
    [feb] = bills(f.ledger, f.card, [FEB])
    assert feb.total == D("150.00")
    assert feb.status(date(2026, 2, 5)) is BillStatus.CLOSED
    assert feb.status(date(2026, 2, 11)) is BillStatus.OVERDUE
    f.ledger.record_card_payment(f.card, f.bank, "100.00", date(2026, 2, 9))
    [feb] = bills(f.ledger, f.card, [FEB])
    assert feb.payments == D("100.00") and feb.remaining == D("50.00")
    assert feb.status(date(2026, 2, 20)) is BillStatus.PARTIAL


def _two_bills() -> Family:
    """Feb bill R$ 150 (due 10/02) and Mar bill R$ 80 (due 10/03); card closes on day 3."""
    f = family()
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2026, 1, 1))
    f.ledger.record_card_purchase(f.card, f.groceries, "150.00", date(2026, 1, 20), "Mercado")
    f.ledger.record_card_purchase(f.card, f.groceries, "80.00", date(2026, 2, 15), "Feira")
    return f


def test_late_payment_settles_the_overdue_bill() -> None:
    f = _two_bills()
    f.ledger.record_card_payment(f.card, f.bank, "150.00", date(2026, 2, 20))  # ten days late
    feb, mar = bills(f.ledger, f.card, [FEB, MAR])
    assert feb.payments == D("150.00") and feb.status(date(2026, 2, 21)) is BillStatus.PAID
    assert mar.payments == 0 and mar.remaining == D("80.00")


def test_late_payment_beyond_the_overdue_bill_goes_to_the_current_one() -> None:
    f = _two_bills()
    f.ledger.record_card_payment(f.card, f.bank, "200.00", date(2026, 2, 20))
    feb, mar = bills(f.ledger, f.card, [FEB, MAR])
    assert (feb.payments, mar.payments) == (D("150.00"), D("50.00"))
    assert mar.remaining == D("30.00")


def test_oldest_overdue_bill_is_paid_first_even_outside_the_requested_months() -> None:
    f = _two_bills()
    f.ledger.record_card_payment(f.card, f.bank, "100.00", date(2026, 3, 20))  # both bills overdue
    [mar] = bills(f.ledger, f.card, [MAR])  # Feb is not requested, but it is older and still owed
    assert mar.payments == 0
    feb, mar = bills(f.ledger, f.card, [FEB, MAR])
    assert (feb.payments, feb.remaining, mar.payments) == (D("100.00"), D("50.00"), 0)


def test_payment_on_time_stays_in_its_own_bill() -> None:
    f = _two_bills()
    f.ledger.record_card_payment(f.card, f.bank, "150.00", date(2026, 2, 10))  # on the due date
    f.ledger.record_card_payment(f.card, f.bank, "80.00", date(2026, 3, 1))  # early for March
    feb, mar = bills(f.ledger, f.card, [FEB, MAR])
    assert (feb.remaining, mar.remaining) == (0, 0)


# ── installments ─────────────────────────────────────


def test_installments_purchase_policy() -> None:
    """Whole expense in the purchase month; bills carry one installment each; cash leaves monthly."""
    f = family()
    plan = record_installment_purchase(f.ledger, f.card, f.groceries, "100.00", date(2026, 1, 5), "Geladeira", 3)
    assert [str(a) for a in plan.amounts] == ["33.34", "33.33", "33.33"]
    assert queries.income_statement(f.ledger, JAN).total_expense == D("100.00")
    assert queries.income_statement(f.ledger, FEB).total_expense == 0
    totals = [b.total for b in bills(f.ledger, f.card, [FEB, MAR, APR])]
    assert totals == [D("33.34"), D("33.33"), D("33.33")]
    assert queries.balance(f.ledger, f.card_account) == D("100.00")  # the full debt exists
    assert [s.cycle.due for s in schedule(f.ledger, plan)] == [date(2026, 2, 10), date(2026, 3, 10), date(2026, 4, 10)]


def test_installments_spread_policy() -> None:
    f = family()
    record_installment_purchase(
        f.ledger, f.card, f.groceries, "90.00", date(2026, 1, 5), "Curso", 3, CompetencePolicy.SPREAD
    )
    assert [queries.income_statement(f.ledger, m).total_expense for m in (JAN, FEB, MAR, APR)] == [
        0,
        D("30.00"),
        D("30.00"),
        D("30.00"),
    ]
    assert [b.total for b in bills(f.ledger, f.card, [FEB, MAR, APR])] == [D("30.00")] * 3


def test_installment_count_and_value_are_never_mixed() -> None:
    f = family()
    with pytest.raises(DomainError):
        record_installment_purchase(f.ledger, f.card, f.groceries, "100", date(2026, 1, 1), "x", 1)


def test_imported_installment_of_registered_plan_is_not_a_new_expense(tmp_path: Path) -> None:
    from opesvault.importing import pipeline
    from opesvault.importing.model import ItemStatus
    from opesvault.importing.pipeline import ImportRequest
    from opesvault.session import Session

    f = family()
    session = Session.new(tmp_path / "x.opesvault")
    session.ledger = f.ledger
    record_installment_purchase(f.ledger, f.card, f.groceries, "150.00", date(2026, 1, 20), "Loja Z", 5)
    csv = b"date,title,amount\n2026-01-20,Loja Z - Parcela 2/5,30.00\n2026-02-25,Uber,10.00\n"
    batch = pipeline.import_document(session, ImportRequest("c.csv", csv, card_id=f.card))
    statuses = {i.description: i.status for i in pipeline.items_of(f.ledger, batch.id)}
    assert statuses["Loja Z"] is ItemStatus.DUPLICATE
    before = queries.income_statement(f.ledger, JAN).total_expense
    pipeline.approve(f.ledger, batch.id)
    assert queries.income_statement(f.ledger, JAN).total_expense == before


# ── recurrences (RF-11, TA-17) ──────────────────────


def _salary_rule(f) -> RecurrenceRule:  # type: ignore[no-untyped-def]
    return add_rule(
        f.ledger,
        RecurrenceRule(
            description="Salário Ana",
            account_id=f.bank,
            counterpart_id=f.salary,
            amount=D("5000.00"),
            tolerance=D("50.00"),
            day=5,
            start=date(2026, 1, 1),
        ),
    )


def test_forecast_does_not_change_balances() -> None:
    f = family()
    _salary_rule(f)
    projected = forecasts(f.ledger, date(2026, 1, 1), date(2026, 3, 31), today=date(2026, 1, 1))
    assert [p.due_on for p in projected] == [date(2026, 1, 5), date(2026, 2, 5), date(2026, 3, 5)]
    assert queries.balance(f.ledger, f.bank) == 0


def test_realized_salary_is_linked_and_not_counted_twice_ta17() -> None:
    f = family()
    rule = _salary_rule(f)
    op = f.ledger.record_income(f.bank, f.salary, "4980.00", date(2026, 1, 6), "SALARIO EMPRESA")
    [forecast] = forecasts(f.ledger, date(2026, 1, 1), date(2026, 1, 31), today=date(2026, 1, 10))
    assert [c.id for c in candidates(f.ledger, forecast)] == [op.id]
    assert auto_suggestions(f.ledger, date(2026, 1, 1), date(2026, 1, 31))[0][1].id == op.id
    realize(f.ledger, rule.id, forecast.due_on, op.id)
    [after] = forecasts(f.ledger, date(2026, 1, 1), date(2026, 1, 31), today=date(2026, 1, 10))
    assert after.status is ForecastStatus.REALIZED and after.operation_id == op.id
    assert queries.income_statement(f.ledger, JAN).total_income == D("4980.00")
    assert f.ledger.operations[op.id].forecast_id == rule.id


def test_value_outside_tolerance_is_not_a_candidate() -> None:
    f = family()
    _salary_rule(f)
    f.ledger.record_income(f.bank, f.salary, "4000.00", date(2026, 1, 5), "x")
    [forecast] = forecasts(f.ledger, date(2026, 1, 1), date(2026, 1, 31))
    assert candidates(f.ledger, forecast) == []


def test_skip_and_late_forecasts() -> None:
    f = family()
    rule = _salary_rule(f)
    [late] = forecasts(f.ledger, date(2026, 1, 1), date(2026, 1, 31), today=date(2026, 1, 20))
    assert late.status is ForecastStatus.LATE
    skip(f.ledger, rule.id, date(2026, 1, 5))
    [skipped] = forecasts(f.ledger, date(2026, 1, 1), date(2026, 1, 31), today=date(2026, 1, 20))
    assert skipped.status is ForecastStatus.SKIPPED


# ── closing (RF-13, TA-19) ──────────────────────────


def test_closed_month_blocks_changes_until_reopened_ta19() -> None:
    f = family()
    op = f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 1, 10), "Padaria")
    close_month(f.ledger, JAN)
    assert is_closed(f.ledger, JAN)
    with pytest.raises(DomainError):
        f.ledger.record_expense(f.bank, f.groceries, "5.00", date(2026, 1, 11), "x")
    fixed = op.model_copy(update={"description": "Padaria do bairro"})
    f.ledger.update_operation(fixed, "descrição não altera números")  # allowed
    with pytest.raises(DomainError):
        f.ledger.cancel_operation(op.id, "erro")
    with pytest.raises(DomainError):
        reopen_month(f.ledger, JAN, " ")
    reopen_month(f.ledger, JAN, "nota fiscal atrasada")
    f.ledger.cancel_operation(op.id, "erro")
    period = close_month(f.ledger, JAN)
    assert period.reopen_reasons == ("nota fiscal atrasada",)
    assert [h.reason for h in f.ledger.history_of(period.id)][-1] == "novo fechamento"


def test_closing_with_pending_requires_justification() -> None:
    f = family()
    _salary_rule(f)
    assert pending_items(f.ledger, JAN)
    with pytest.raises(DomainError):
        close_month(f.ledger, JAN)
    closed = close_month(f.ledger, JAN, "salário caiu no dia 10, previsão ajustada depois")
    assert closed.pending_note


def test_closing_summary_snapshot() -> None:
    f = family()
    f.ledger.record_income(f.bank, f.salary, "5000.00", date(2026, 1, 5), "Salário")
    period = close_month(f.ledger, JAN, "ok")
    assert period.summary.income == D("5000.00") and period.summary.cash_in == D("5000.00")


def test_closing_survives_persistence() -> None:
    f = family()
    close_month(f.ledger, JAN)
    restored = Ledger.from_records(f.ledger.to_records())
    assert is_closed(restored, JAN)
    with pytest.raises(DomainError):
        restored.record_expense(f.bank, f.groceries, "1.00", date(2026, 1, 2), "x")
    assert len(plans(restored)) == 0
