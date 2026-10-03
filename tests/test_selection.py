"""Choosing a row or an option by its id compares values, as ids read back from the vault are new objects."""

from pathlib import Path
from uuid import UUID, uuid4

import pytest
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication, QComboBox, QListWidget, QListWidgetItem

from opesvault.ui.common import select_combo, select_id

from .demo_vault import demo_session


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    return instance if isinstance(instance, QApplication) else QApplication([])


def _copy(value: UUID) -> UUID:
    """The same id as a different object, the way it comes back from the vault file."""
    copy = UUID(str(value))
    assert copy == value and copy is not value
    return copy


def test_select_combo_finds_an_equal_id_and_tuple(app: QApplication) -> None:
    combo = QComboBox()
    first, second = uuid4(), uuid4()
    combo.addItem("(escolha)", None)
    combo.addItem("Cartão", ("card", first))
    combo.addItem("Conta", second)
    assert select_combo(combo, ("card", _copy(first))) and combo.currentIndex() == 1
    assert select_combo(combo, _copy(second)) and combo.currentIndex() == 2
    assert not select_combo(combo, uuid4()) and combo.currentIndex() == 2  # unknown: unchanged


def test_select_id_on_a_list(app: QApplication) -> None:
    widget = QListWidget()
    ids = [uuid4() for _ in range(3)]
    for index, value in enumerate(ids):
        item = QListWidgetItem(f"linha {index}")
        item.setData(Qt.ItemDataRole.UserRole, value)
        widget.addItem(item)
    assert select_id(widget, _copy(ids[2])) and widget.currentRow() == 2
    assert not select_id(widget, uuid4()) and widget.currentRow() == 2
    assert not select_id(widget, None)


def test_review_shows_the_batch_card_and_each_items_category_after_reopening(app: QApplication, tmp_path: Path) -> None:
    """Ids parsed from the vault are equal to, not the same object as, the accounts' ids."""
    from opesvault.importing import pipeline
    from opesvault.ui.main_window import MainWindow
    from opesvault.ui.pages.imports import ImportPage

    window = MainWindow()
    session = demo_session(tmp_path / "demo.opesvault")
    ledger = session.ledger
    store = pipeline.items(ledger)
    for item in list(store.values()):
        if item.target_account_id is not None:
            store[item.id] = item.model_copy(update={"target_account_id": _copy(item.target_account_id)})
    batches = pipeline.batches(ledger)
    batch = next(iter(batches.values()))
    assert batch.card_id is not None
    batches[batch.id] = batch.model_copy(update={"card_id": _copy(batch.card_id)})
    window.session = session
    window._refresh()
    page = next(p for p in window.pages if isinstance(p, ImportPage))
    window.show_page(window.pages.index(page))
    assert page.target.currentData() == ("card", batch.card_id)
    assert page.target.currentText() == ledger.cards[batch.card_id].name
    shown = 0
    for row in range(page.items.rowCount()):
        combo = page.items.cellWidget(row, 5)
        cell = page.items.item(row, 0)
        if not isinstance(combo, QComboBox) or cell is None:
            continue
        item = store[cell.data(Qt.ItemDataRole.UserRole)]
        if item.target_account_id is not None:
            assert combo.currentData() == item.target_account_id, item.description
            shown += 1
    assert shown >= 2
