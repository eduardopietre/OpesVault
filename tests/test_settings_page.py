"""Configurações: vault settings apply as typed, and only what was typed is ever written."""

from pathlib import Path

import pytest
from PySide6.QtWidgets import QApplication

from opesvault.domain.settings import get_settings
from opesvault.session import Session
from opesvault.ui.main_window import MainWindow
from opesvault.ui.pages.ledger import LedgerPage
from opesvault.ui.pages.settings_page import SettingsPage

from .domain_fixtures import family


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    return instance if isinstance(instance, QApplication) else QApplication([])


@pytest.fixture
def window(app: QApplication, tmp_path: Path) -> MainWindow:
    win = MainWindow()
    session = Session.new(tmp_path / "x.opesvault", "Teste")
    session.ledger = family().ledger
    win.session = session
    win._refresh()
    session.undo_stack().seal()
    return win


def _page[P](window: MainWindow, kind: type[P]) -> P:
    page = next(p for p in window.pages if isinstance(p, kind))
    window.show_page(window.pages.index(page))  # type: ignore[arg-type]
    return page


def test_a_typed_setting_is_applied_once_as_one_undo_step(window: MainWindow, tmp_path: Path) -> None:
    assert window.session is not None
    page = _page(window, SettingsPage)
    page.backup_dir.setText(str(tmp_path / "copias"))
    page.backup_dir.textEdited.emit(page.backup_dir.text())  # what typing emits
    page.flush()
    assert get_settings(window.session.ledger).backup_dir == str(tmp_path / "copias")
    assert window.session.undo_stack().undo_label()
    page.flush()  # nothing new typed: nothing written again
    assert len(window.session.undo_stack().undo_steps) == 1


def test_an_undone_setting_is_not_written_back_by_a_stale_form(window: MainWindow, tmp_path: Path) -> None:
    """Change the backup folder, leave the page, undo it, then save: the undo must stand."""
    assert window.session is not None
    page = _page(window, SettingsPage)
    page.backup_dir.setText(str(tmp_path / "copias"))
    page.backup_dir.textEdited.emit(page.backup_dir.text())
    page.flush()
    _page(window, LedgerPage)  # the settings form is no longer on screen
    window.undo()
    assert get_settings(window.session.ledger).backup_dir is None
    window._flush_pages()  # what Salvar does first
    assert get_settings(window.session.ledger).backup_dir is None


def test_closing_the_vault_drops_what_was_being_typed(window: MainWindow, tmp_path: Path) -> None:
    page = _page(window, SettingsPage)
    page.backup_keep.setValue(page.backup_keep.value() + 3)  # typed, not yet applied
    window._drop_session()
    window._refresh()
    session = Session.new(tmp_path / "outro.opesvault", "Outro")
    window.session = session
    window._refresh()
    window._flush_pages()
    assert get_settings(session.ledger).backup_keep == get_settings(family().ledger).backup_keep
