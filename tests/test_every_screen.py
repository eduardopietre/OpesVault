"""Rules every screen must keep, checked on all of them at once with the demo vault.

Each test walks the whole window instead of one page, so a new page, table or button is
covered the day it is added:

- closing the vault leaves no financial data on any screen (TA-31);
- every button and menu entry runs without an error, with and without a selected row, and
  with every dialog cancelled; a click that still changes the ledger closes its own undo step
  (`Page.changed()`, once per action);
- no page widens the window past a small desktop, and no widget hard-codes a color or font.
"""

import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import shiboken6
from PySide6.QtWidgets import (
    QAbstractButton,
    QAbstractItemView,
    QApplication,
    QComboBox,
    QDialog,
    QFileDialog,
    QInputDialog,
    QLabel,
    QLineEdit,
    QListWidget,
    QMenu,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QTableView,
    QTableWidget,
    QTabWidget,
    QTextEdit,
    QToolButton,
    QTreeWidget,
    QWidget,
)

from opesvault.ui import theme
from opesvault.ui.main_window import MainWindow
from opesvault.ui.pages.base import Page
from opesvault.vault.client import VaultClient
from opesvault.vault.errors import ErrorCode, VaultError

from .demo_vault import demo_session

TRACE = False  # print each click while debugging a walk that hangs

# Values that exist only in the demo vault: none may stay on screen after it closes.
CANARIES = ("Pão de Açúcar", "Farmácia São Paulo", "CDB Banco X", "Itaú da Ana", "Reserva de emergência", "7.800,00")


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    app = instance if isinstance(instance, QApplication) else QApplication([])
    theme.apply_theme(app, dark=False)
    return app


class Modals:
    """Answers every modal with "cancel" and remembers what opened, so clicks never block."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.opened: list[str] = []
        modals = self

        def reject(self: QDialog, *_args: Any) -> int:
            modals.opened.append(type(self).__name__)
            return QDialog.DialogCode.Rejected.value

        def message(kind: str, result: Any = None) -> Any:
            def show(*_args: Any, **_kwargs: Any) -> Any:
                modals.opened.append(f"QMessageBox.{kind}")
                return result

            return staticmethod(show)

        monkeypatch.setattr(QDialog, "exec", reject)
        monkeypatch.setattr(QMessageBox, "exec", reject)
        for kind in ("information", "warning", "critical", "about"):
            monkeypatch.setattr(QMessageBox, kind, message(kind, QMessageBox.StandardButton.Ok))
        monkeypatch.setattr(QFileDialog, "getOpenFileName", message("open", ("", "")))
        monkeypatch.setattr(QFileDialog, "getOpenFileNames", message("open", ([], "")))
        monkeypatch.setattr(QFileDialog, "getSaveFileName", message("save", ("", "")))
        monkeypatch.setattr(QFileDialog, "getExistingDirectory", message("folder", ""))
        monkeypatch.setattr(QInputDialog, "getText", message("text", ("", False)))
        monkeypatch.setattr(QInputDialog, "getInt", message("int", (0, False)))
        monkeypatch.setattr(QInputDialog, "getItem", message("item", ("", False)))
        monkeypatch.setattr(QMenu, "exec", lambda *_a, **_k: None)
        monkeypatch.setattr(QMenu, "popup", lambda *_a, **_k: None)


@pytest.fixture
def modals(monkeypatch: pytest.MonkeyPatch) -> Modals:
    return Modals(monkeypatch)


@pytest.fixture
def errors(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[str]]:
    """Exceptions raised inside Qt slots only reach sys.excepthook; collect them."""
    found: list[str] = []
    monkeypatch.setattr(sys, "excepthook", lambda kind, value, _tb: found.append(f"{kind.__name__}: {value}"))
    yield found


@pytest.fixture
def window(app: QApplication, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> MainWindow:
    def refused(*_args: Any, **_kwargs: Any) -> Any:
        raise VaultError(ErrorCode.CANCELLED)  # never start a real vault worker from a click

    for name in ("open_raw", "save_frozen", "unlock", "change_password"):
        monkeypatch.setattr(VaultClient, name, refused)
    win = MainWindow()
    win.resize(1280, 800)
    win.session = demo_session(tmp_path / "demo.opesvault")
    win._refresh()
    win.session.undo_stack().seal()  # the demo data is the starting point, not an action
    return win


def _settle() -> None:
    from PySide6.QtCore import QCoreApplication, QEvent

    for _ in range(3):
        QApplication.processEvents()
    # deleteLater() runs when control returns to the event loop, which a test never does.
    QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)


def _visible_texts(widget: QWidget) -> list[str]:
    """Everything a person could read on a widget tree: labels, fields, cells, list rows, tooltips."""
    texts: list[str] = []
    for child in [widget, *widget.findChildren(QWidget)]:
        texts.append(child.toolTip())
        if isinstance(child, QLabel):
            texts.append(child.text())
            full = getattr(child, "_full", None)  # ElidedLabel keeps the whole text
            if isinstance(full, str):
                texts.append(full)
        elif isinstance(child, QLineEdit):
            texts.append(child.text())
        elif isinstance(child, (QPlainTextEdit, QTextEdit)):
            texts.append(child.toPlainText())
        elif isinstance(child, QComboBox):
            texts.extend(child.itemText(i) for i in range(child.count()))
        elif isinstance(child, QListWidget):
            texts.extend(child.item(i).text() for i in range(child.count()))
        elif isinstance(child, QTreeWidget):
            root = child.invisibleRootItem()
            texts.extend(item.text(0) for i in range(root.childCount()) if (item := root.child(i)) is not None)
        elif isinstance(child, QTableView):
            model = child.model()
            if model is not None:
                for row in range(model.rowCount()):
                    texts.extend(str(model.index(row, col).data() or "") for col in range(model.columnCount()))
    return texts


def _buttons(page: Page) -> list[QAbstractButton]:
    """Enabled buttons on the page that a person can reach (not explicitly hidden)."""
    return [b for b in page.findChildren(QAbstractButton) if b.isEnabled() and not b.isHidden()]


def _menu_of(button: QAbstractButton) -> QMenu | None:
    menu = button.menu() if isinstance(button, (QToolButton, QPushButton)) else None
    return menu if isinstance(menu, QMenu) else None


def _menu_actions(menu: QMenu) -> list[Any]:
    """Enabled entries of a menu and its submenus, filled the way opening them would."""
    found = []
    stack = [menu]
    while stack:
        current = stack.pop()
        current.aboutToShow.emit()  # menus filled on demand (saved filters, recents)
        for action in current.actions():
            submenu = action.menu()
            if isinstance(submenu, QMenu):
                stack.append(submenu)
            elif action.isEnabled() and not action.isSeparator():
                found.append(action)
    return found


def _select_first_rows(page: Page) -> None:
    for view in page.findChildren(QAbstractItemView):
        model = view.model()
        if model is not None and model.rowCount() and not isinstance(view, QComboBox):
            view.setCurrentIndex(model.index(0, 0))
            if view.selectionModel() is not None and isinstance(view, (QTableView, QTableWidget)):
                view.selectRow(0)


def _press_everything(window: MainWindow, errors: list[str], *, select: bool) -> list[str]:
    """Clicks every button and menu entry on every page; returns the problems found."""
    assert window.session is not None
    problems: list[str] = []
    stack = window.session.undo_stack()
    for index, page in enumerate(window.pages):
        window.show_page(index)
        tabs = page.findChildren(QTabWidget)
        tab_states = [(t, i) for t in tabs for i in range(t.count())] or [(None, 0)]
        for tab_widget, tab in tab_states:
            if tab_widget is not None:
                tab_widget.setCurrentIndex(tab)
            if select:
                _select_first_rows(page)
            for button in _buttons(page):
                if not shiboken6.isValid(button) or not button.isEnabled():
                    continue  # rebuilt or disabled by an earlier click
                label = button.text() or button.accessibleName() or button.objectName()
                menu = _menu_of(button)
                # A button with a menu only opens it (a blocking popup here): press its entries instead.
                triggers = (
                    [(f"{label} › {a.text()}", a.trigger) for a in _menu_actions(menu)]
                    if menu is not None
                    else [(label, button.click)]
                )
                for name, trigger in triggers:
                    if not shiboken6.isValid(button):
                        break
                    if window.stack.currentWidget() is not page:
                        window.show_page(index)
                    errors.clear()
                    if TRACE:
                        print(page.title, tab, name, flush=True, file=sys.__stderr__)
                    trigger()
                    _settle()
                    where = f"{page.title} › {name}"
                    problems += [f"{where}: {e}" for e in errors]
                    if stack.journal:
                        problems.append(f"{where}: alterou o livro sem fechar o passo de desfazer")
                        stack.seal()
    return problems


def test_closing_the_vault_leaves_no_data_on_any_screen(window: MainWindow) -> None:
    """TA-31 on every page and tab, not only the ones a test remembered to check."""
    for index, page in enumerate(window.pages):
        window.show_page(index)
        for tabs in page.findChildren(QTabWidget):
            for tab in range(tabs.count()):
                tabs.setCurrentIndex(tab)
                _settle()
    shown = " ".join(" ".join(_visible_texts(page)) for page in window.pages)
    assert all(canary in shown for canary in CANARIES[:2]), "the demo data must be on screen first"
    window._drop_session()
    window._refresh()
    _settle()  # widgets removed with their rows are deleted by the event loop
    left = []
    for page in window.pages:
        texts = " ".join(_visible_texts(page))
        left += [f"{page.title}: {c}" for c in CANARIES if c in texts]
        for view in page.findChildren(QTableView):
            model = view.model()
            if model is not None and model.rowCount():
                left.append(f"{page.title}: tabela {view.objectName() or view.accessibleName()} com linhas")
    assert left == []


def test_every_button_runs_without_a_selection(window: MainWindow, modals: Modals, errors: list[str]) -> None:
    assert _press_everything(window, errors, select=False) == []
    assert modals.opened, "the walk must reach the dialogs"


def test_every_button_runs_with_the_first_row_selected(window: MainWindow, modals: Modals, errors: list[str]) -> None:
    """Dialogs are all cancelled; a click that still changes data does it as one named undo step."""
    assert window.session is not None
    stack = window.session.undo_stack()
    assert _press_everything(window, errors, select=True) == []
    assert all(step.label for step in stack.undo_steps)


def test_every_page_fits_a_small_desktop_with_the_demo_data(window: MainWindow) -> None:
    window.show()
    for index, page in enumerate(window.pages):
        window.show_page(index)
        for tabs in page.findChildren(QTabWidget):
            for tab in range(tabs.count()):
                tabs.setCurrentIndex(tab)
                _settle()
                assert window.minimumSizeHint().width() <= 900, f"{page.title} › {tabs.tabText(tab)}"
        assert window.minimumSizeHint().width() <= 900, page.title


def test_no_widget_hard_codes_a_color_or_font() -> None:
    """Colors and type come from theme tokens (docs/16): a literal in a widget breaks dark mode."""
    import re

    root = Path(__file__).resolve().parents[1] / "src" / "opesvault" / "ui"
    literal = re.compile(
        r"setStyleSheet\(.*(#[0-9a-fA-F]{3}|rgb|font-size|font-family|color:)"
        r"|QColor\(\s*[\"'#0-9]|setPointSize|setPixelSize|QFont\(\s*[\"']"
    )
    allowed = {"theme.py", "icons.py"}  # where the tokens and drawn icons live
    found = [
        f"{path.relative_to(root)}:{number}"
        for path in sorted(root.rglob("*.py"))
        if path.name not in allowed
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        if literal.search(line) and "# token-ok" not in line
    ]
    assert found == []


def test_every_button_runs_on_a_new_empty_vault(
    window: MainWindow, modals: Modals, errors: list[str], tmp_path: Path
) -> None:
    """A vault just created has no accounts, members or months: every empty state must hold."""
    from opesvault.session import Session

    window.session = Session.new(tmp_path / "novo.opesvault", "Projeto novo")
    window._refresh()
    window.session.undo_stack().seal()
    assert _press_everything(window, errors, select=False) == []


def test_preferences_of_this_computer_have_one_entry_point() -> None:
    """Only `ui/preferences.py` builds a QSettings, so tests redirect every preference at once."""
    root = Path(__file__).resolve().parents[1] / "src" / "opesvault"
    found = [
        f"{path.relative_to(root)}:{number}"
        for path in sorted(root.rglob("*.py"))
        if path.name != "preferences.py"
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        if "QSettings(" in line
    ]
    assert found == []
