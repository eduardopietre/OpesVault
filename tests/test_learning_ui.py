"""Learned categories on screen: the manual entry, the rules tab's proposals and a contradicted rule."""

from datetime import date
from pathlib import Path

import pytest
from PySide6.QtWidgets import QApplication

from opesvault.importing import rules
from opesvault.session import Session
from opesvault.ui.common import combo_value, select_combo
from opesvault.ui.dialogs import OperationDialog
from opesvault.ui.main_window import MainWindow
from opesvault.ui.pages.accounts import AccountsPage

from .domain_fixtures import Family, category, family


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    return instance if isinstance(instance, QApplication) else QApplication([])


@pytest.fixture
def setup(app: QApplication, tmp_path: Path) -> tuple[MainWindow, Family]:
    window = MainWindow()
    f = family()
    session = Session.new(tmp_path / "x.opesvault", "Teste")
    session.ledger = f.ledger
    window.session = session
    window._refresh()
    return window, f


def _taxi(f: Family, days: tuple[int, ...] = (1, 2, 3)) -> None:
    for day in days:
        f.ledger.record_expense(f.bank, category(f.ledger, "Transporte"), "25.00", date(2026, 3, day), "TAXI LUZ")


def test_the_manual_entry_suggests_the_usual_category_until_one_is_picked(setup: tuple[MainWindow, Family]) -> None:
    window, f = setup
    _taxi(f, (1, 2))
    dialog = OperationDialog(window, f.ledger, "expense")
    transport, leisure = category(f.ledger, "Transporte"), category(f.ledger, "Lazer")
    dialog.description.setText("Taxi Luz 22")
    assert combo_value(dialog.target) == transport
    assert not dialog.category_hint.isHidden() and "sugerida pelo uso" in dialog.category_hint.text()
    select_combo(dialog.target, leisure)
    dialog.target.activated.emit(dialog.target.currentIndex())  # what a person's pick emits
    dialog.description.setText("Taxi Luz 23")
    assert combo_value(dialog.target) == leisure and dialog.category_hint.isHidden()  # the pick stays
    dialog.deleteLater()


def test_an_unknown_description_leaves_the_category_alone(setup: tuple[MainWindow, Family]) -> None:
    window, f = setup
    dialog = OperationDialog(window, f.ledger, "income")
    first = combo_value(dialog.source)
    dialog.description.setText("Algo nunca visto")
    assert combo_value(dialog.source) == first and dialog.category_hint.isHidden()
    dialog.deleteLater()


def _rules_tab(window: MainWindow) -> AccountsPage:
    page = next(p for p in window.pages if isinstance(p, AccountsPage))
    window.show_page(window.pages.index(page))
    return page


def test_rules_tab_offers_what_the_family_repeats_and_creates_it(
    setup: tuple[MainWindow, Family], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.ui.rule_dialog import RuleDialog

    window, f = setup
    _taxi(f)
    window._refresh()
    tab = _rules_tab(window).rules_tab
    tab.refresh()
    assert not tab.learned.isHidden() and tab.proposals.rowCount() == 1
    assert tab.proposals.item(0, 0).text() == "TAXI LUZ"  # type: ignore[union-attr]
    tab.proposals.selectRow(0)
    opened: list[RuleDialog] = []

    def accept(dialog: RuleDialog) -> int:
        opened.append(dialog)
        return 1

    monkeypatch.setattr(RuleDialog, "exec", accept)
    tab.create_from_proposal()
    assert opened and opened[0].pattern.text() == "TAXI LUZ"
    assert opened[0].target.currentData() == category(f.ledger, "Transporte")
    created = [r for r in rules.rules(f.ledger).values() if r.pattern == "TAXI LUZ"]
    assert len(created) == 1
    assert tab.proposals.rowCount() == 0 and tab.learned.isHidden()  # now the rule says so
    assert window.session is not None and window.session.undo_stack().undo_label()  # one undo step


def test_rules_tab_warns_about_a_rule_the_family_keeps_overriding(setup: tuple[MainWindow, Family]) -> None:
    window, f = setup
    rules.add_rule(f.ledger, "TAXI", category(f.ledger, "Lazer"))
    _taxi(f, (1, 2))
    window._refresh()
    tab = _rules_tab(window).rules_tab
    tab.refresh()
    state = tab.table.item(0, 4).text()  # type: ignore[union-attr]
    assert "contrariada 2 de 2 vezes" in state and "Transporte" in state
