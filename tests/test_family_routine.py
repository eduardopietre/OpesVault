"""Rules, budget, alerts and undo as the window exposes them."""

from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from PySide6.QtWidgets import QApplication

from opesvault.domain import budget
from opesvault.domain.model import YearMonth
from opesvault.importing import pipeline, rules
from opesvault.importing.pipeline import ImportRequest
from opesvault.session import Session
from opesvault.ui.main_window import MainWindow
from opesvault.ui.pages.budget_page import BudgetPage
from opesvault.ui.pages.import_page import ImportPage
from opesvault.ui.pages.overview_page import OverviewPage

from . import synthetic_docs as docs
from .domain_fixtures import category, family


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
    win.session = session
    win.on_changed()
    return win


def page(window: MainWindow, kind: type) -> object:
    found = next(p for p in window.pages if isinstance(p, kind))
    window.show_page(window.pages.index(found))
    return found


def bank(window: MainWindow):  # type: ignore[no-untyped-def]
    assert window.session is not None
    return next(a.id for a in window.session.ledger.accounts.values() if a.name == "Banco A")


def test_undo_and_redo_from_the_edit_menu(window: MainWindow) -> None:
    assert window.session is not None
    ledger = window.session.ledger
    assert not window.undo_action.isEnabled()  # nothing since the vault was "opened"
    window.session.undo_stack().clear()
    window.on_changed()
    op = ledger.record_expense(bank(window), category(ledger, "Lazer"), "80.00", date(2026, 1, 4), "Show")
    window.on_changed()
    assert window.undo_action.isEnabled() and window.undo_action.text() == "Desfazer lançamento"
    window.undo()
    assert op.id not in ledger.operations
    assert window.redo_action.text() == "Refazer lançamento"
    window.redo()
    assert op.id in ledger.operations
    window._page_busy(True)
    window.undo()  # blocked while an import runs
    assert op.id in ledger.operations
    window._page_busy(False)


def test_budget_page_states_and_overspend_notice(window: MainWindow, monkeypatch: pytest.MonkeyPatch) -> None:
    assert window.session is not None
    ledger = window.session.ledger
    budget_page = page(window, BudgetPage)
    assert isinstance(budget_page, BudgetPage)
    month = YearMonth(year=2026, month=1)
    budget_page.month.set_month(month)
    budget.set_budget(ledger, category(ledger, "Lazer"), month, "100.00")
    window.on_changed()
    messages: list[str] = []
    monkeypatch.setattr(window, "notify", messages.append)
    ledger.record_expense(bank(window), category(ledger, "Lazer"), "120.00", date(2026, 1, 9), "Parque")
    window.on_changed()
    assert any(m.startswith("Orçamento estourado: Lazer em janeiro de 2026") for m in messages)
    status = budget.status(ledger, month)
    assert status.rows[0].remaining == Decimal("-20.00")


def test_alerts_open_on_the_overview(window: MainWindow) -> None:
    assert window.session is not None
    pipeline.import_document(window.session, ImportRequest("nu.pdf", docs.nubank_card_pdf()))
    window.on_changed()
    window.show_page(3)
    window.show_alerts_on_open()
    overview = window.stack.currentWidget()
    assert isinstance(overview, OverviewPage)
    assert not overview.alerts.isHidden() and "Atenção" in overview.alerts.heading.text()
    overview.alerts.dismiss()
    assert overview.alerts.isHidden()
    window.show_alerts_on_open()
    assert not overview.alerts.isHidden()  # back on the next opening


def test_rule_offer_after_a_manual_category(window: MainWindow, monkeypatch: pytest.MonkeyPatch) -> None:
    assert window.session is not None
    ledger = window.session.ledger
    batch = pipeline.import_document(window.session, ImportRequest("nu.pdf", docs.nubank_card_pdf()))
    window.on_changed()
    import_page = page(window, ImportPage)
    assert isinstance(import_page, ImportPage)
    import_page.batch_id = batch.id
    import_page.refresh()
    item = next(i for i in pipeline.items_of(ledger, batch.id) if "Padaria" in i.description)
    import_page._set_target(item.id, category(ledger, "Lazer"))
    assert not import_page.rule_offer.isHidden()
    assert "PADARIA" in import_page.rule_offer_text.text()

    from opesvault.ui import rule_dialog

    def accept(self: rule_dialog.RuleDialog) -> int:
        return 1

    monkeypatch.setattr(rule_dialog.RuleDialog, "exec", accept)
    import_page._accept_rule_offer()
    [rule] = rules.rules(ledger).values()
    assert rule.pattern == "PADARIA" and rule.target_account_id == category(ledger, "Lazer")
    assert rule.account_id is None  # "any account" is the default scope
