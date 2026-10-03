"""Interface flows: from what the user sees to where it is resolved, without hunting for commands."""

from collections.abc import Callable
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from PySide6.QtCore import QDate
from PySide6.QtWidgets import QApplication

from opesvault.domain.alerts import Target, alerts
from opesvault.domain.model import YearMonth
from opesvault.session import Session
from opesvault.ui import preferences, theme
from opesvault.ui.main_window import MainWindow
from opesvault.ui.pages.accounts_page import AccountsPage
from opesvault.ui.pages.base import Page
from opesvault.ui.pages.budget_page import BudgetPage
from opesvault.ui.pages.ledger import LedgerPage
from opesvault.ui.pages.overview_page import OverviewPage
from opesvault.ui.pages.settings_page import SettingsPage

from .domain_fixtures import Family, family
from .fake_ollama import FakeOllama
from .test_ai import _statement


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    app = instance if isinstance(instance, QApplication) else QApplication([])
    theme.apply_theme(app, dark=False)
    return app


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
        late = due + timedelta(days=5)  # paid after the due date: it still settles this overdue bill
        dialog.when.setDate(QDate(late.year, late.month, late.day))
        assert not dialog.late.isHidden()
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
    assert "março de 2026" in ledger.filters.period.itemText(1).lower()

    names = [
        item.text() if (item := overview.categories.item(r, 0)) else "" for r in range(overview.categories.rowCount())
    ]
    row = names.index("Alimentação")
    overview._open_row(overview.categories, row)
    assert window.stack.currentWidget() is ledger
    assert ledger.filters.period.currentData() == "month" and ledger.filters.account.currentData() == f.groceries
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
    monkeypatch.setattr("opesvault.ui.shell.vault.decide", lambda *_a: "save")
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
    assert window.welcome.recent_list.isHidden() and not window.welcome.remember_recents.isHidden()
    settings = preferences.app_settings()
    settings.setValue("recentes/ativo", True)
    settings.setValue("recentes/lista", [str(vault)])
    window._refresh()
    assert window.welcome.recent_list.count() == 1 and window.welcome.remember_recents.isHidden()
    assert window.welcome.restore_button.text() == "Restaurar backup…"


def test_operator_shows_only_with_several_members(setup: tuple[MainWindow, Family]) -> None:
    window, f = setup
    assert all(action.isVisible() for action in window._session_actions)
    f.ledger.update_member(f.ledger.members[f.bruno].model_copy(update={"active": False}), "saiu de casa")
    window._refresh()
    assert not window._session_actions[2].isVisible()


def test_budget_grid_sets_the_whole_month(setup: tuple[MainWindow, Family]) -> None:
    window, f = setup
    from opesvault.domain import budget
    from opesvault.ui.pages.budget_page import BudgetGridDialog

    ledger = f.ledger
    month = YearMonth(year=2026, month=5)
    budget.set_budget(ledger, f.groceries, month.add(-1), "600.00")
    dialog = BudgetGridDialog(window, ledger, month)
    rows = {category_id: index for index, (_, category_id) in enumerate(dialog.categories)}
    dialog.copy_previous()  # fills only what last month had
    assert dialog.edits[rows[f.groceries]].text() == "600,00"
    transport = next(c for name, c in dialog.categories if name == "Transporte")
    dialog.edits[rows[transport]].setText("150,00")
    assert dialog.apply() == 2
    assert {line.category_id: line.amount for line in budget.lines_of(ledger, month)} == {
        f.groceries: Decimal("600.00"),
        transport: Decimal("150.00"),
    }
    dialog.edits[rows[transport]].clear()  # empty means no plan
    assert dialog.apply() == 1 and budget.line_for(ledger, transport, month) is None
    dialog.deleteLater()


def test_reports_filter_by_account_and_open_the_ledger(setup: tuple[MainWindow, Family]) -> None:
    window, f = setup
    from opesvault.charts.data import Point
    from opesvault.ui.pages.reports_page import ReportsPage

    f.ledger.record_expense(f.bank, f.groceries, "70.00", date(2026, 3, 9), "Feira")
    window._refresh()
    reports = page_of(window, ReportsPage)
    window.show_page(window.pages.index(reports))
    reports.follow_month(YearMonth(year=2026, month=3))
    assert not reports.scope.isHidden()  # Entradas e saídas: filtered by account
    select = [reports.scope.itemData(i) for i in range(reports.scope.count())].index(f.bank)
    reports.scope.setCurrentIndex(select)
    reports.inspect("Saídas", Point("2026-03", Decimal("70.00")))
    assert reports.open_ledger.isEnabled()
    reports._open_ledger()
    ledger = page_of(window, LedgerPage)
    assert window.stack.currentWidget() is ledger
    assert ledger.filters.account.currentData() == f.bank and ledger.filters.period.currentData() == "month"
    assert [op.description for op in ledger.model.ops] == ["Feira"]

    window.navigate("reports", "composition")
    assert reports._key() == "composition" and reports.scope.isHidden()


def test_member_role_in_the_dialog(setup: tuple[MainWindow, Family]) -> None:
    window, f = setup
    from opesvault.domain.model import MemberRole
    from opesvault.ui.dialogs import MemberDialog

    dialog = MemberDialog(window, f.ledger)
    dialog.name.setText("Lia")
    dialog.role.setCurrentIndex(1)
    dialog.validate()
    lia = dialog.apply()
    assert lia.role is MemberRole.DEPENDENT
    edit = MemberDialog(window, f.ledger, lia)
    edit.role.setCurrentIndex(0)
    assert edit.apply().role is MemberRole.HOLDER
    for widget in (dialog, edit):
        widget.deleteLater()


def _local_ai(window: MainWindow, f: Family, url: str, monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    import json

    from opesvault.ai.ollama import OllamaClient
    from opesvault.domain.settings import update_settings
    from opesvault.ui.pages.imports import ImportPage

    update_settings(f.ledger, ai_enabled=True, ai_model="gemma4:12b")
    monkeypatch.setattr(
        "opesvault.importing.ai_suggestions.client_from_settings", lambda _ledger: OllamaClient("gemma4:12b", url)
    )
    FakeOllama.answer = json.dumps({"suggestions": [{"index": 0, "category": "Lazer"}]})
    return page_of(window, ImportPage)


def _wait(window: MainWindow) -> None:
    from PySide6.QtCore import QThreadPool

    for _ in range(3):  # an import, then the AI it starts
        QThreadPool.globalInstance().waitForDone(5000)
        for _ in range(20):
            QApplication.processEvents()


def test_local_ai_suggests_while_the_review_stays_open(
    setup: tuple[MainWindow, Family], ollama: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.importing import pipeline
    from opesvault.importing.pipeline import ImportRequest, import_document
    from opesvault.ui.pages.imports.labels import source_label

    window, f = setup
    page = _local_ai(window, f, ollama, monkeypatch)
    assert window.session is not None
    batch = import_document(window.session, ImportRequest("x.csv", _statement("XPTO 1", "XPTO 2"), account_id=f.bank))
    page.batch_id = batch.id
    page.refresh()
    assert not page.ai_button.isHidden() and page.ai_button.text() == "Sugerir com IA (2)"
    page.suggest_ai()
    assert not page.ai_row.isHidden() and page.isEnabled()  # the review is not blocked meanwhile
    _wait(window)
    assert page.ai_row.isHidden()
    sources = {i.suggestion_source for i in pipeline.items_of(f.ledger, batch.id)}
    assert len(sources) == 1 and source_label(sources.pop() or "") == "sugestão (IA local, gemma4:12b)"
    assert page.ai_button.text() == "Sugerir com IA" and not page.ai_button.isEnabled()


def test_local_ai_runs_by_itself_after_an_import(
    setup: tuple[MainWindow, Family], ollama: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from opesvault.importing import pipeline

    window, f = setup
    page = _local_ai(window, f, ollama, monkeypatch)
    path = tmp_path / "extrato.csv"
    path.write_bytes(_statement("QWERTY LOJA"))
    monkeypatch.setattr("opesvault.ui.pages.imports.review.QMessageBox.information", lambda *a, **k: None)
    page._queue.append(path)
    page._next_import()
    _wait(window)
    assert page.batch_id is not None
    (item,) = pipeline.items_of(f.ledger, page.batch_id)
    assert (item.suggestion_source or "").startswith("ollama:gemma4:12b")


def test_settings_check_runs_off_the_ui_thread(
    setup: tuple[MainWindow, Family], ollama: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.ai import ollama as module

    window, _ = setup
    monkeypatch.setattr(module, "DEFAULT_URL", ollama)
    monkeypatch.setattr(module.OllamaClient.__init__, "__defaults__", (ollama,))
    page = page_of(window, SettingsPage)
    page.ai_model.setCurrentText("llama9")
    page.test_ai()
    assert page.ai_status.text() == "Verificando o Ollama local…" and not page.ai_check.isEnabled()
    _wait(window)
    assert "llama9 não está instalado" in page.ai_status.text() and page.ai_check.isEnabled()
