"""Offscreen smoke tests: every page renders and the main dialogs apply to the ledger."""

from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from PySide6.QtWidgets import QApplication

from opesvault.domain import queries
from opesvault.session import Session
from opesvault.ui.common import select_combo, to_qdate
from opesvault.ui.dialogs import AccountDialog, OperationDialog
from opesvault.ui.main_window import MainWindow

from .domain_fixtures import family


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    return instance if isinstance(instance, QApplication) else QApplication([])


@pytest.fixture
def window(app: QApplication, tmp_path: Path) -> MainWindow:
    win = MainWindow()
    f = family()
    session = Session.new(tmp_path / "x.opesvault", "Teste")
    session.ledger = f.ledger
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2026, 1, 1))
    f.ledger.record_card_purchase(f.card, f.groceries, "100.00", date(2026, 1, 5), "Mercado")
    win.session = session
    win._refresh()
    return win


def test_all_pages_render(window: MainWindow) -> None:
    for row in range(window.nav.count()):
        window.nav.setCurrentRow(row)
        QApplication.processEvents()
    assert "Não salvo" in window.status.text()


def test_expense_dialog_applies(window: MainWindow) -> None:
    assert window.session is not None
    ledger = window.session.ledger
    dialog = OperationDialog(window, ledger, "expense")
    dialog.amount.setText("1.234,56")
    dialog.description.setText("Aluguel")
    dialog.when.setDate(to_qdate(date(2026, 1, 10)))
    bank = next(a.id for a in ledger.accounts.values() if a.name == "Banco A")
    select_combo(dialog.source, bank)
    dialog.validate()
    dialog.apply()
    assert queries.balance(ledger, bank) == Decimal("1000.00") - Decimal("1234.56")


def test_invalid_amount_is_reported(window: MainWindow) -> None:
    from opesvault.domain.ledger import DomainError

    assert window.session is not None
    dialog = OperationDialog(window, window.session.ledger, "income")
    dialog.amount.setText("12,3,4")
    with pytest.raises(DomainError):
        dialog.validate()


def test_account_dialog_with_opening_balance(window: MainWindow) -> None:
    assert window.session is not None
    ledger = window.session.ledger
    dialog = AccountDialog(window, ledger)
    dialog.name.setText("Corretora")
    dialog.opening.setText("500,00")
    dialog.validate()
    account = ledger.add_account(dialog.build())
    opening = dialog.opening_balance()
    assert opening is not None and opening[0] == Decimal("500.00")
    assert account.name == "Corretora"
