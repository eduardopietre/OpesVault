"""Interface behavior that the redesign promises: states, responsiveness, feedback."""

from datetime import date
from pathlib import Path

import pytest
from PySide6.QtWidgets import QApplication

from opesvault.session import Session
from opesvault.ui import theme
from opesvault.ui.main_window import BADGE_ROLE, MainWindow

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
    f.ledger.record_expense(f.bank, f.groceries, "50.00", date(2026, 1, 3), "Feira")
    win.session = session
    win._refresh()
    return win


def test_welcome_state_without_a_vault(app: QApplication) -> None:
    window = MainWindow()
    assert window.shell.currentWidget() is window.welcome
    assert not window.save_action.isEnabled()
    assert all(not action.isVisible() for action in window._session_actions)


def test_save_state_is_visible_in_the_toolbar(window: MainWindow) -> None:
    assert window.shell.currentWidget() is window.content
    assert window.status.text() == "Alterações não salvas"
    assert window.save_dot.property("state") == "dirty"
    assert window.save_button.property("role") == "primary"
    assert "Teste" in window.context_label.text()


def test_sidebar_groups_and_badge(window: MainWindow) -> None:
    from opesvault.importing import pipeline
    from opesvault.importing.pipeline import ImportRequest
    from opesvault.ui.pages.import_page import ImportPage

    from . import synthetic_docs as docs

    assert window.nav.count() > len(window.pages)  # group labels between destinations
    assert window.session is not None
    pipeline.import_document(window.session, ImportRequest("nu.pdf", docs.nubank_card_pdf()))
    window._refresh()
    index = next(i for i, p in enumerate(window.pages) if isinstance(p, ImportPage))
    item = window.nav.item(window._nav_rows[index])
    assert item.data(BADGE_ROLE) and item.data(BADGE_ROLE) > 0
    window.show_page(index)
    assert window.stack.currentWidget() is window.pages[index]


def test_window_fits_a_small_desktop(window: MainWindow) -> None:
    window.resize(1280, 800)
    window.show()
    for index in range(len(window.pages)):
        window.show_page(index)
        QApplication.processEvents()
        assert window.minimumSizeHint().width() <= 1000, window.pages[index].title


def test_ledger_filters_show_how_to_clear_them(window: MainWindow) -> None:
    from opesvault.ui.pages.ledger_page import LedgerPage

    page = next(p for p in window.pages if isinstance(p, LedgerPage))
    window.show_page(window.pages.index(page))
    assert page.clear_filters.isHidden()
    page.filter_text.setText("nada parecido")
    page._debounce.timeout.emit()
    assert not page.clear_filters.isHidden()
    assert page.views.currentWidget() is page.empty
    page.reset_filters()
    assert page.views.currentWidget() is page.table and page.filter_text.text() == ""
    assert "lançamentos" in page.header.subtitle.text()


def test_form_errors_are_inline(window: MainWindow) -> None:
    from opesvault.ui.dialogs import OperationDialog

    assert window.session is not None
    dialog = OperationDialog(window, window.session.ledger, "expense")
    dialog.amount.setText("12,3,4")
    dialog._try_accept()
    assert dialog.result() == 0 and not dialog.error.isHidden()
    assert "Valor inválido" in dialog.error.text()
    assert dialog.confirm_button.text() == "Registrar"


def test_dark_and_light_tokens(app: QApplication) -> None:
    dark = theme.apply_theme(app, dark=True)
    assert app.palette().window().color().name() == dark.window
    light = theme.apply_theme(app, dark=False)
    assert app.palette().window().color().name() == light.window
    assert dark.text != light.text
