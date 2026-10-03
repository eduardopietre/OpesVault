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
    for index in range(len(window.pages)):
        window.show_page(index)
        QApplication.processEvents()
        assert window.stack.currentWidget() is window.pages[index]
    assert "não salvas" in window.status.text()


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


def test_import_page_review_flow(window: MainWindow) -> None:
    from opesvault.importing import pipeline
    from opesvault.importing.pipeline import ImportRequest
    from opesvault.ui.pages.import_page import ImportPage

    from . import synthetic_docs as docs

    assert window.session is not None
    batch = pipeline.import_document(window.session, ImportRequest("nu.pdf", docs.nubank_card_pdf()))
    page = next(p for p in window.pages if isinstance(p, ImportPage))
    window.show_page(window.pages.index(page))
    page.batch_id = batch.id
    page.refresh()
    assert page.items.rowCount() == len(pipeline.items_of(window.session.ledger, batch.id))
    page.items.selectRow(0)
    page._select_item()
    assert page.viewer.data is not None


def test_phase3_pages(window: MainWindow) -> None:
    from opesvault.domain.cards import record_installment_purchase
    from opesvault.ui.pages.accounts_page import AccountsPage
    from opesvault.ui.pages.recurrences_page import RecurrencesPage, RuleDialog

    assert window.session is not None
    ledger = window.session.ledger
    card = next(iter(ledger.cards.values()))
    category = ledger.categories(__import__("opesvault.domain.model", fromlist=["AccountType"]).AccountType.EXPENSE)[0]
    record_installment_purchase(ledger, card.id, category.id, "300.00", date.today(), "TV", 3)
    accounts = next(p for p in window.pages if isinstance(p, AccountsPage))
    accounts.refresh()
    assert accounts.bills.rowCount() >= 1
    recurrences = next(p for p in window.pages if isinstance(p, RecurrencesPage))
    dialog = RuleDialog(recurrences, ledger)
    dialog.description.setText("Aluguel")
    dialog.amount.setText("2.000,00")
    from opesvault.domain.recurrence import add_rule

    add_rule(ledger, dialog.build())
    recurrences.refresh()
    assert recurrences.forecast_table.rowCount() > 0


def test_phase4_investments_and_reports(window: MainWindow) -> None:
    from opesvault.charts import data as charts
    from opesvault.domain.model import YearMonth
    from opesvault.investments import service as inv
    from opesvault.investments.model import AssetClass, ValueNature
    from opesvault.ui.pages.investments import InvestmentsPage
    from opesvault.ui.pages.reports_page import CHARTS, ReportsPage

    assert window.session is not None
    ledger = window.session.ledger
    bank = next(a.id for a in ledger.accounts.values() if a.name == "Banco A")
    pos = inv.create_position(
        ledger, "CDB", AssetClass.FIXED_INCOME, date(2026, 1, 1), initial_cost="500", from_account=bank
    )
    inv.add_valuation(ledger, pos.id, date(2026, 2, 1), "510", ValueNature.GROSS)
    inv.add_valuation(ledger, pos.id, date(2026, 3, 1), "505", ValueNature.NET_INFORMED)
    page = next(p for p in window.pages if isinstance(p, InvestmentsPage))
    window.show_page(window.pages.index(page))
    page.positions.selectRow(0)
    page._show_detail()
    assert page.detail.valuations.rowCount() == 3
    evolution = charts.investment_evolution(ledger, pos.id)
    assert {s.name for s in evolution.series} >= {"Valor bruto", "Valor líquido informado", "Aporte"}
    tooltip = page.detail.evolution.tooltip_text("Valor bruto", evolution.series[0].points[0])
    assert "R$" in tooltip and "natureza" in tooltip
    reports = next(p for p in window.pages if isinstance(p, ReportsPage))
    for index in range(len(CHARTS)):
        reports.kind.setCurrentRow(index)
        reports.refresh()
    in_out = charts.monthly_in_out(ledger, YearMonth(year=2026, month=1), YearMonth(year=2026, month=3))
    assert in_out.regime == "caixa"


def test_phase5_returns_tab(window: MainWindow) -> None:
    from opesvault.investments import service as inv
    from opesvault.investments.model import AssetClass, TrackingMode, ValueNature
    from opesvault.investments.trades import buy
    from opesvault.ui.pages.investments import InvestmentsPage

    assert window.session is not None
    ledger = window.session.ledger
    bank = next(a.id for a in ledger.accounts.values() if a.name == "Banco A")
    pos = inv.create_position(
        ledger, "ITSA4", AssetClass.STOCK, date(2026, 1, 2), mode=TrackingMode.QUANTITY, ticker="ITSA4"
    )
    buy(ledger, pos.id, date(2026, 1, 2), "10", "10.00", bank)
    inv.add_valuation(ledger, pos.id, date(2026, 1, 2), "100", ValueNature.GROSS)
    inv.add_valuation(ledger, pos.id, date(2026, 2, 2), "110", ValueNature.GROSS)
    page = next(p for p in window.pages if isinstance(p, InvestmentsPage))
    window.show_page(window.pages.index(page))
    page.positions.selectRow(0)
    page._show_detail()
    assert page.detail.lots.rowCount() == 1
    assert page.detail.returns_table.rowCount() == 4

    def cell(row: int, column: int) -> str:
        item = page.detail.returns_table.item(row, column)
        assert item is not None
        return item.text()

    by_method = {cell(r, 0).split(" ")[0]: cell(r, 1) for r in range(page.detail.returns_table.rowCount())}
    assert by_method["TWR"] == "10,00%"
    assert by_method["XIRR"] != "indisponível"  # annualized, labeled as such


def test_phase6_commands(window: MainWindow, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from opesvault.ui.pages.settings_page import SettingsPage

    page = next(p for p in window.pages if isinstance(p, SettingsPage))
    window.show_page(window.pages.index(page))
    from opesvault.ui.coverage import CoverageDialog

    coverage = CoverageDialog(window)
    assert coverage.table.rowCount() >= 8
    coverage.deleteLater()
    labels = [a.text() for a in window.vault_menu.actions()]
    assert "Trocar senha…" in labels and "Restaurar backup…" in labels
    assert window.session is not None
    window.session.ledger.record_opening_balance(
        next(a.id for a in window.session.ledger.accounts.values() if a.name == "Poupança"),
        "1,00".replace(",", "."),
        date(2026, 1, 1),
    )
    window._remind()
    window._remind()  # first call starts the clock; reminder threshold not reached
