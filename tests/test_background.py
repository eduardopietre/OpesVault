"""Answers from background work reach a page only while it exists (ui/background.py)."""

from pathlib import Path

import pytest
from PySide6.QtCore import QCoreApplication, QEvent, QObject, Signal
from PySide6.QtWidgets import QApplication, QPushButton

from opesvault.ui.background import while_alive


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    return instance if isinstance(instance, QApplication) else QApplication([])


class _Source(QObject):
    done = Signal(object)


def test_an_answer_after_the_page_is_gone_is_dropped(app: QApplication) -> None:
    source = _Source()
    page = QPushButton("Verificar")
    received: list[object] = []
    while_alive(source.done, page, lambda value: (received.append(value), page.setEnabled(True)))
    source.done.emit(1)
    assert received == [1]
    page.deleteLater()
    QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
    source.done.emit(2)  # would raise "Internal C++ object already deleted" on a plain lambda
    assert received == [1]


def test_background_answers_are_connected_through_while_alive() -> None:
    """A worker's `done` or `progress` connected straight to a lambda could touch a deleted page."""
    root = Path(__file__).resolve().parents[1] / "src" / "opesvault" / "ui"
    found = [
        f"{path.relative_to(root)}:{number}"
        for path in sorted(root.rglob("*.py"))
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        if "job.signals." in line and ".connect(" in line
    ]
    # the shell's vault jobs answer the main window itself, which outlives every page
    assert all(place.startswith("shell/vault.py:") for place in found), found
