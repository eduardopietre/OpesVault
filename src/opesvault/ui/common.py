"""Small shared UI helpers. No financial logic lives here."""

from collections.abc import Callable, Iterable
from datetime import date
from decimal import Decimal
from typing import Any
from uuid import UUID

from PySide6.QtCore import QDate, Qt
from PySide6.QtWidgets import (
    QAbstractItemView,
    QComboBox,
    QDateEdit,
    QHeaderView,
    QLineEdit,
    QMessageBox,
    QTableWidget,
    QTableWidgetItem,
    QWidget,
)

from opesvault.domain.ledger import DomainError
from opesvault.domain.money import MoneyError, format_brl, parse_brl


def to_qdate(value: date) -> QDate:
    return QDate(value.year, value.month, value.day)


def from_qdate(value: QDate) -> date:
    return date(value.year(), value.month(), value.day())


def date_edit(value: date | None = None) -> QDateEdit:
    edit = QDateEdit()
    edit.setCalendarPopup(True)
    edit.setDisplayFormat("dd/MM/yyyy")
    edit.setDate(to_qdate(value or date.today()))
    return edit


def money_edit(placeholder: str = "0,00") -> QLineEdit:
    edit = QLineEdit()
    edit.setPlaceholderText(placeholder)
    edit.setAlignment(Qt.AlignmentFlag.AlignRight)
    return edit


def read_money(edit: QLineEdit, *, allow_empty: bool = False) -> Decimal | None:
    text = edit.text().strip()
    if not text:
        if allow_empty:
            return None
        raise DomainError("Informe o valor.")
    try:
        return parse_brl(text)
    except MoneyError:
        raise DomainError("Valor inválido. Use o formato 1.234,56.") from None


def fmt(value: Decimal | None) -> str:
    return "—" if value is None else format_brl(value)


def fmt_date(value: date | None) -> str:
    return "—" if value is None else value.strftime("%d/%m/%Y")


def fill_combo(combo: QComboBox, items: Iterable[tuple[str, Any]], *, empty: str | None = None) -> None:
    combo.clear()
    if empty is not None:
        combo.addItem(empty, None)
    for label, value in items:
        combo.addItem(label, value)


def combo_value(combo: QComboBox) -> Any:
    return combo.currentData()


def select_combo(combo: QComboBox, value: Any) -> None:
    index = combo.findData(value)
    if index >= 0:
        combo.setCurrentIndex(index)


def make_table(headers: list[str]) -> QTableWidget:
    table = QTableWidget(0, len(headers))
    table.setHorizontalHeaderLabels(headers)
    table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
    table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
    table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
    table.setSortingEnabled(True)
    table.verticalHeader().setVisible(False)
    table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Interactive)
    table.horizontalHeader().setStretchLastSection(True)
    return table


def set_rows(table: QTableWidget, rows: list[tuple[list[Any], UUID | None]]) -> None:
    """Rows are (cells, id); the id is stored in column 0 for selection lookups."""
    table.setSortingEnabled(False)
    table.setRowCount(len(rows))
    for r, (cells, row_id) in enumerate(rows):
        for c, value in enumerate(cells):
            item = QTableWidgetItem(str(value))
            if isinstance(value, str) and value.startswith(("R$", "-R$", "+R$")):
                item.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            if c == 0:
                item.setData(Qt.ItemDataRole.UserRole, row_id)
            table.setItem(r, c, item)
    table.setSortingEnabled(True)
    table.resizeColumnsToContents()


def selected_id(table: QTableWidget) -> UUID | None:
    row = table.currentRow()
    if row < 0:
        return None
    item = table.item(row, 0)
    return item.data(Qt.ItemDataRole.UserRole) if item else None


def run_guarded(parent: QWidget, action: Callable[[], Any]) -> Any:
    """Runs a domain action and shows DomainError as a message instead of crashing."""
    try:
        return action()
    except DomainError as exc:
        QMessageBox.warning(parent, "OpesVault", str(exc))
    except ValueError:
        QMessageBox.warning(parent, "OpesVault", "Dados inválidos. Revise os campos.")
    return None
