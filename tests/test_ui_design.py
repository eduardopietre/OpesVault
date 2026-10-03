"""Interface behavior that the redesign promises: states, responsiveness, feedback."""

from datetime import date
from pathlib import Path
from typing import Any

import pytest
from PySide6.QtWidgets import QApplication

from opesvault.session import Session
from opesvault.ui import theme
from opesvault.ui.main_window import BADGE_ROLE, MainWindow

from .domain_fixtures import family


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    app = instance if isinstance(instance, QApplication) else QApplication([])
    theme.apply_theme(app, dark=False)  # metrics as the app runs them, whatever ran before
    return app


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
        assert window.minimumSizeHint().width() <= 900, window.pages[index].title


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


def test_every_control_has_an_accessible_name(window: MainWindow) -> None:
    """What scripts/auditar_acessibilidade.py checks, on every page: a screen reader can name each control."""
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
    import importlib

    unnamed = importlib.import_module("auditar_acessibilidade").unnamed

    problems = [f"{page.title} › {p}" for page in window.pages for p in unnamed(page)]
    problems += unnamed(window.toolbar)
    assert problems == []


def test_window_without_a_vault_fits_a_small_desktop(app: QApplication) -> None:
    window = MainWindow()
    window.resize(900, 640)
    window.show()
    QApplication.processEvents()
    assert window.minimumSizeHint().width() <= 900


def test_adaptive_sits_side_by_side_only_when_there_is_room(app: QApplication) -> None:
    from PySide6.QtWidgets import QWidget

    from opesvault.ui.components import Adaptive

    host = Adaptive(1000)
    left, right = QWidget(), QWidget()
    for child in (left, right):
        child.setMinimumWidth(300)
        child.setMinimumHeight(50)
        host.add(child)
    # the minimum is the stacked one: a wide arrangement never keeps the window wide
    assert host.minimumSizeHint().width() == 300
    host.resize(1200, 400)
    host.show()
    QApplication.processEvents()
    assert host.wide and right.x() > left.x()
    host.resize(990, 400)  # inside the hysteresis band: no flip back and forth
    QApplication.processEvents()
    assert host.wide
    host.resize(700, 400)
    QApplication.processEvents()
    assert not host.wide and right.y() > left.y() and right.x() == left.x()


def _at(window: MainWindow, page_type: type, width: int, height: int) -> Any:
    window.resize(width, height)
    window.show()
    page = next(p for p in window.pages if isinstance(p, page_type))
    window.show_page(window.pages.index(page))
    for _ in range(4):
        QApplication.processEvents()
    return page


def test_wide_window_puts_chart_beside_its_values(window: MainWindow) -> None:
    from opesvault.ui.pages.reports_page import ReportsPage

    page = _at(window, ReportsPage, 1920, 1080)
    panel = page.panel
    assert panel.arrangement.wide
    assert panel.table_section.x() > panel.chart_section.x()
    assert panel.chart.height() > 320  # beside the values the chart takes the height it has
    page = _at(window, ReportsPage, 900, 640)
    assert not page.panel.arrangement.wide
    assert page.panel.table_section.y() > page.panel.chart_section.y()
    assert page.panel.chart.height() == 320


def test_overview_attention_is_a_rail_on_wide_windows(window: MainWindow) -> None:
    from opesvault.ui.pages.overview_page import OverviewPage

    page = _at(window, OverviewPage, 1920, 1080)
    page.pending.setText("• algo a resolver")
    page.pending_section.show()
    page._fit_rail()
    QApplication.processEvents()
    assert not page.rail.isHidden()
    assert page.columns.wide and page.rail.x() > page.cash.mapTo(page.columns, page.cash.rect().topLeft()).x()
    window.resize(900, 640)
    for _ in range(4):
        QApplication.processEvents()
    assert not page.columns.wide and page.rail.y() == 0  # stacked: what to act on comes first


def test_ledger_gives_wide_windows_to_the_text_columns(window: MainWindow) -> None:
    from opesvault.ui.pages.ledger_page import LedgerPage, OperationsModel

    page = _at(window, LedgerPage, 1920, 1080)
    header = page.table.horizontalHeader()
    assert header.sectionSize(OperationsModel.DESCRIPTION) > 240
    assert header.sectionSize(OperationsModel.DATE) == 104
    page = _at(window, LedgerPage, 900, 640)
    assert header.sectionSize(OperationsModel.DESCRIPTION) == 240
    header.resizeSection(OperationsModel.DESCRIPTION, 180)  # a column dragged by hand stays as dragged
    window.resize(1920, 1080)
    QApplication.processEvents()
    assert header.sectionSize(OperationsModel.DESCRIPTION) == 180


def test_page_header_actions_move_below_the_title_when_narrow(window: MainWindow) -> None:
    from opesvault.ui.pages.overview_page import OverviewPage

    page = _at(window, OverviewPage, 1920, 1080)
    header = page.header
    assert page.month.y() < header.title.y() + header.title.height()
    page = _at(window, OverviewPage, 900, 640)
    assert page.month.mapTo(header, page.month.rect().topLeft()).y() >= header.title.height()


def test_pdf_viewer_fits_the_page_to_its_width(app: QApplication) -> None:
    from opesvault.ui.pages.documents_page import FIT_MAX, FIT_MIN, PdfView

    from . import synthetic_docs as docs

    view = PdfView()
    view.resize(400, 600)
    view.show()
    view.show_pdf(docs.nubank_card_pdf())
    QApplication.processEvents()
    narrow = view._fit_scale()
    view.resize(900, 600)
    QApplication.processEvents()
    wide = view._fit_scale()
    assert FIT_MIN <= narrow < wide <= FIT_MAX
