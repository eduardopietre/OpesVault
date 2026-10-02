"""Interface flows: from what the user sees to where it is resolved, without hunting for commands."""

from collections.abc import Callable
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from PySide6.QtCore import QDate, QSettings
from PySide6.QtWidgets import QApplication

from opesvault.domain.alerts import Target, alerts
from opesvault.domain.model import YearMonth
from opesvault.session import Session
from opesvault.ui import theme
from opesvault.ui.main_window import MainWindow
from opesvault.ui.pages.accounts_page import AccountsPage
from opesvault.ui.pages.base import Page
from opesvault.ui.pages.budget_page import BudgetPage
from opesvault.ui.pages.ledger_page import LedgerPage
from opesvault.ui.pages.overview_page import OverviewPage
from opesvault.ui.pages.settings_page import SettingsPage

from .domain_fixtures import Family, family


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    app = instance if isinstance(instance, QApplication) else QApplication([])
    theme.apply_theme(app, dark=False)
    return app


@pytest.fixture
def settings_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Computer preferences go to a temporary file, never to the real user profile."""
    path = tmp_path / "prefs.ini"
    monkeypatch.setattr(
        MainWindow, "app_settings", staticmethod(lambda: QSettings(str(path), QSettings.Format.IniFormat))
    )
    return path


@pytest.fixture
def setup(app: QApplication, tmp_path: Path, settings_file: Path) -> tuple[MainWindow, Family]:
    window = MainWindow()
    f = family()
    session = Session.new(tmp_path / "x.opesvault", "Teste")
    session.ledger = f.ledger
    window.session = session
    window._refresh()
    return window, f


def page_of[T: Page](window: MainWindow, kind: type[T]) -> T:
    return next(p for p in window.pages if isinstance(p, kind))


def test_bill_alert_opens_the_bill_and_pays_it(
    setup: tuple[MainWindow, Family], monkeypatch: pytest.MonkeyPatch
) -> None:
    window, f = setup
    ledger = f.ledger
    today = date.today()
    ledger.record_card_purchase(f.card, f.groceries, "300.00", today - timedelta(days=40), "Mercado")
    bill_alerts = [a for a in alerts(ledger) if a.target is Target.ACCOUNTS]
    assert bill_alerts and bill_alerts[0].ref is not None
    card_id, month = bill_alerts[0].ref  # type: ignore[misc]
    assert card_id == f.card and isinstance(month, YearMonth)

    from opesvault.ui.dialogs import BillPaymentDialog

    opened: list[BillPaymentDialog] = []

    def run(dialog: BillPaymentDialog) -> bool:
        opened.append(dialog)
        assert dialog.amount.text() == "300,00"  # the remaining amount comes filled in
        due = bill_alerts[0].due_on
        assert due is not None
        dialog.when.setDate(QDate(due.year, due.month, due.day))  # paid on time: it settles this bill
        return True

    monkeypatch.setattr(BillPaymentDialog, "exec", run)
    window._refresh()
    window.navigate("accounts", bill_alerts[0].ref, act=True)
    page = page_of(window, AccountsPage)
    assert window.stack.currentWidget() is page
    assert page.tabs.currentIndex() == page.bills_tab
    assert opened, "the alert's action opens the payment directly"
    assert not [a for a in alerts(ledger) if a.target is Target.ACCOUNTS and a.ref == bill_alerts[0].ref]


def test_budget_alert_opens_the_category_in_its_month(setup: tuple[MainWindow, Family]) -> None:
    window, f = setup
    from opesvault.domain import budget

    month = YearMonth.of(date.today())
    budget.set_budget(f.ledger, f.groceries, month, "100.00")
    f.ledger.record_expense(f.bank, f.groceries, "150.00", date.today(), "Feira")
    window._refresh()
    alert = next(a for a in alerts(f.ledger) if a.target is Target.BUDGET)
    window.navigate("budget", alert.ref)
    page = page_of(window, BudgetPage)
    assert page.month.current() == month
    assert page._selected_category() == f.groceries


def test_overview_month_is_shared_and_lines_open_the_ledger(setup: tuple[MainWindow, Family]) -> None:
    window, f = setup
    f.ledger.record_expense(f.bank, f.groceries, "20.00", date(2026, 3, 5), "Padaria")
    f.ledger.record_expense(f.bank, f.groceries, "30.00", date(2026, 4, 5), "Mercado")
    window._refresh()
    overview = page_of(window, OverviewPage)
    budget_page = page_of(window, BudgetPage)
    ledger = page_of(window, LedgerPage)
    march = YearMonth(year=2026, month=3)
    overview.month.set_month(march)
    assert budget_page.month.current() == march  # the Budget follows the Overview
    assert "março de 2026" in ledger.period.itemText(1).lower()

    names = [
        item.text() if (item := overview.categories.item(r, 0)) else "" for r in range(overview.categories.rowCount())
    ]
    row = names.index("Alimentação")
    overview._open_row(overview.categories, row)
    assert window.stack.currentWidget() is ledger
    assert ledger.period.currentData() == "month" and ledger.filter_account.currentData() == f.groceries
    assert [op.description for op in ledger.model.ops] == ["Padaria"]


def test_settings_have_one_contract(setup: tuple[MainWindow, Family]) -> None:
    window, f = setup
    page = page_of(window, SettingsPage)
    assert not hasattr(page, "apply_button")
    page.backup_keep.setValue(7)
    page.flush()  # what saving does before writing
    from opesvault.domain.settings import get_settings

    assert get_settings(f.ledger).backup_keep == 7
    assert window.session is not None and window.session.dirty  # written by the toolbar's Salvar
    assert "Bloqueio por inatividade…" not in [a.text() for a in window.view_menu.actions()]


def test_save_choice_resumes_the_interrupted_action(
    setup: tuple[MainWindow, Family], monkeypatch: pytest.MonkeyPatch
) -> None:
    window, _ = setup
    assert window.session is not None and window.session.dirty
    resumed: list[Callable[[], object] | None] = []
    monkeypatch.setattr("opesvault.ui.main_window.decide", lambda *_a: "save")
    monkeypatch.setattr(window, "save_vault", lambda then=None: resumed.append(then))
    assert not window._confirm_discard("fechar o cofre", window.close_vault)
    assert resumed == [window.close_vault]


def test_simple_correction_rebuilds_the_postings(setup: tuple[MainWindow, Family]) -> None:
    window, f = setup
    from opesvault.domain.ledger import Ledger
    from opesvault.ui.operation_edit import SimpleEditDialog, is_simple

    ledger: Ledger = f.ledger
    op = ledger.record_expense(f.bank, f.groceries, "40.00", date(2026, 2, 1), "Feira")
    assert is_simple(ledger, op)
    dialog = SimpleEditDialog(window, ledger, op)
    dialog.amount.setText("45,50")
    dialog.reason.setText("valor do cupom")
    dialog.validate()
    updated = dialog.apply()
    assert {p.account_id: p.amount for p in updated.postings} == {
        f.groceries: Decimal("45.50"),
        f.bank: Decimal("-45.50"),
    }
    dialog.deleteLater()


def test_welcome_lists_recent_vaults_only_with_consent(app: QApplication, tmp_path: Path, settings_file: Path) -> None:
    vault = tmp_path / "familia.opesvault"
    vault.write_bytes(b"")
    window = MainWindow()
    assert window.shell.currentWidget() is window.welcome
    assert window.recent_list.isHidden() and not window.remember_recents.isHidden()
    settings = MainWindow.app_settings()
    settings.setValue("recentes/ativo", True)
    settings.setValue("recentes/lista", [str(vault)])
    window._refresh()
    assert window.recent_list.count() == 1 and window.remember_recents.isHidden()
    assert window.welcome_restore.text() == "Restaurar backup…"


def test_operator_shows_only_with_several_members(setup: tuple[MainWindow, Family]) -> None:
    window, f = setup
    assert all(action.isVisible() for action in window._session_actions)
    f.ledger.update_member(f.ledger.members[f.bruno].model_copy(update={"active": False}), "saiu de casa")
    window._refresh()
    assert not window._session_actions[2].isVisible()
