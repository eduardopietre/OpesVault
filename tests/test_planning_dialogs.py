"""The planning dialogs filled the way a person does, then applied (ui/planning_dialogs.py).

Each test types into the form, runs the same validation the Confirm button runs, applies it and
checks the ledger; the invalid cases show their message inside the form, never a crash.
"""

from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from PySide6.QtCore import QDate
from PySide6.QtWidgets import QApplication, QDialog

from opesvault.domain import balance_checks, deductibles, loans, queries, sharing, tags
from opesvault.ui import planning_dialogs as dialogs
from opesvault.ui.common import select_combo

from .domain_fixtures import Family, category, family


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    return instance if isinstance(instance, QApplication) else QApplication([])


@pytest.fixture
def f(app: QApplication) -> Family:
    found = family()
    found.ledger.record_opening_balance(found.bank, "10000.00", date(2026, 1, 1))
    return found


def _confirm(dialog: object) -> None:
    """What the Confirm button does: an error stays in the form and the dialog stays open."""
    dialog._try_accept()  # type: ignore[attr-defined]
    assert dialog.result() == QDialog.DialogCode.Accepted, dialog.error.text()  # type: ignore[attr-defined]


def _refused(dialog: object, words: str) -> None:
    dialog._try_accept()  # type: ignore[attr-defined]
    assert dialog.result() != QDialog.DialogCode.Accepted  # type: ignore[attr-defined]
    assert not dialog.error.isHidden() and words in dialog.error.text()  # type: ignore[attr-defined]


def _date(widget: object, day: date) -> None:
    widget.setDate(QDate(day.year, day.month, day.day))  # type: ignore[attr-defined]


def test_tags_are_added_renamed_and_removed(f: Family) -> None:
    ops = [
        f.ledger.record_expense(f.bank, category(f.ledger, "Lazer"), "100.00", date(2026, 2, d), "Passeio")
        for d in (1, 2)
    ]
    ids = [op.id for op in ops]
    dialog = dialogs.TagDialog(None, f.ledger, ids)
    _refused(dialog, "")  # an empty tag is not a tag
    dialog.tag.setText("  viagem   serra ")
    _confirm(dialog)
    assert dialog.apply() == 2
    assert {tags.tags_of(f.ledger, op_id) for op_id in ids} == {tags.tags_of(f.ledger, ids[0])}  # one tag for both
    current = tags.tags_of(f.ledger, ids[0])[0]
    rename = dialogs.RenameTagDialog(None, f.ledger, current)
    rename.name.setText("Serra 2026")
    _confirm(rename)
    assert rename.apply() == 2 and tags.tags_of(f.ledger, ids[1]) == ("Serra 2026",)
    remove = dialogs.TagDialog(None, f.ledger, ids[:1])
    remove.tag.setText("Serra 2026")
    select_combo(remove.action, "remove")
    assert remove.apply() == 1
    assert tags.tags_of(f.ledger, ids[0]) == () and tags.tags_of(f.ledger, ids[1]) == ("Serra 2026",)


def test_a_reimbursement_is_requested_and_received(f: Family) -> None:
    health = category(f.ledger, "Saúde")
    op = f.ledger.record_expense(f.bank, health, "450.00", date(2026, 3, 6), "Consulta")
    request = dialogs.ReimbursementDialog(None, f.ledger, op)
    assert request.expected.text() == "450,00"  # the whole expense, ready to change
    _refused(request, "quem reembolsa")
    request.payer.setText("Plano de saúde")
    request.expected.setText("300,00")
    _confirm(request)
    item: Any = request.apply()
    receive = dialogs.ReceiveDialog(None, f.ledger, item)
    assert receive.amount.text() == "300,00"  # what is still missing
    receive.amount.setText("120,00")
    _date(receive.when, date(2026, 3, 20))
    _confirm(receive)
    receive.apply()
    item = sharing.reimbursements(f.ledger)[item.id]  # the stored version knows its receipts
    assert sharing.received(f.ledger, item) == Decimal("120.00")
    assert queries.balance(f.ledger, health) == Decimal("330.00")  # a refund of the original category
    again = dialogs.ReceiveDialog(None, f.ledger, item)
    assert again.amount.text() == "180,00"


def test_a_settlement_needs_two_different_members(f: Family) -> None:
    dialog = dialogs.SettlementDialog(None, f.ledger, debtor=f.bruno)
    assert dialog.creditor.currentData() != dialog.debtor.currentData()  # someone else by default
    select_combo(dialog.creditor, f.bruno)
    _refused(dialog, "dois integrantes diferentes")
    select_combo(dialog.creditor, f.ana)
    dialog.amount.setText("75,50")
    _confirm(dialog)
    settled = dialog.apply()
    assert settled is not None and sharing.settlements(f.ledger)


def test_a_loan_is_created_paid_and_prepaid_through_the_dialogs(f: Family) -> None:
    dialog = dialogs.LoanDialog(None, f.ledger)
    _refused(dialog, "nome")
    dialog.name.setText("Financiamento do carro")
    dialog.principal.setText("12.000,00")
    dialog.rate.setText("12,5")
    select_combo(dialog.rate_basis, "year")
    dialog.term.setValue(24)
    _date(dialog.first_due, date(2026, 2, 10))
    _date(dialog.opened_on, date(2026, 1, 10))
    _confirm(dialog)
    assert Decimal("0.0098") < dialog.monthly_rate() < Decimal("0.0099")  # 12,5% a.a. ≈ 0,9864% a.m.
    plan: Any = dialog.apply()
    status = loans.status(f.ledger, plan.id)
    assert status.paid == 0 and len(status.installments) == 24 and status.outstanding == Decimal("12000.00")

    first = status.installments[0]
    pay = dialogs.PayInstallmentDialog(None, f.ledger, plan, first)
    pay.amount.setText("1,00")
    _refused(pay, "menor que a parcela")
    pay.amount.setText(str(first.payment).replace(".", ","))
    _date(pay.when, first.due)
    _confirm(pay)
    pay.apply()
    assert loans.status(f.ledger, plan.id).paid == 1

    prepay = dialogs.PrepaymentDialog(None, f.ledger, plan)
    prepay.amount.setText("2.000,00")
    assert "economia" in prepay.simulation.text()  # simulated as the person types, nothing recorded
    assert loans.status(f.ledger, plan.id).outstanding == status.outstanding - first.amortization
    _date(prepay.when, date(2026, 2, 20))
    _confirm(prepay)
    prepay.apply()
    after = loans.status(f.ledger, plan.id)
    assert after.outstanding == status.outstanding - first.amortization - Decimal("2000.00")


def test_a_bad_rate_is_explained(f: Family) -> None:
    dialog = dialogs.LoanDialog(None, f.ledger)
    dialog.name.setText("Empréstimo")
    dialog.principal.setText("1.000,00")
    for typed, words in (("abc", "Taxa inválida"), ("150", "entre 0 e 100")):
        dialog.rate.setText(typed)
        _refused(dialog, words)


def test_a_balance_check_compares_with_the_ledger(f: Family) -> None:
    dialog = dialogs.BalanceCheckDialog(None, f.ledger, f.bank)
    _date(dialog.when, date(2026, 1, 31))
    dialog.informed.setText("9.950,00")
    dialog.note.setText("extrato")
    _confirm(dialog)
    check: Any = dialog.apply()
    [result] = [r for r in balance_checks.results(f.ledger, f.bank) if r.check.id == check.id]
    assert result.difference == Decimal("-50.00") and not result.matches


def test_a_category_is_marked_deductible_and_unmarked(f: Family) -> None:
    health = category(f.ledger, "Saúde")
    dialog = dialogs.DeductibleDialog(None, f.ledger, health)
    select_combo(dialog.kind, deductibles.DeductibleKind.HEALTH)
    dialog.apply()
    assert deductibles.kind_of(f.ledger, health) is deductibles.DeductibleKind.HEALTH
    clear = dialogs.DeductibleDialog(None, f.ledger, health)
    assert clear.kind.currentData() == deductibles.DeductibleKind.HEALTH  # opens on the current choice
    clear.kind.setCurrentIndex(0)
    clear.apply()
    assert deductibles.kind_of(f.ledger, health) is None


def test_the_rate_label_reads_as_a_monthly_percentage() -> None:
    assert dialogs.rate_label(Decimal("0.0149")) == "1,4900% ao mês"
