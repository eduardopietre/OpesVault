"""Small shared UI helpers. No financial logic lives here."""

from collections.abc import Callable, Iterable
from datetime import date
from decimal import Decimal
from typing import Any

from PySide6.QtCore import QDate, Qt
from PySide6.QtWidgets import (
    QAbstractItemView,
    QComboBox,
    QDateEdit,
    QHeaderView,
    QLineEdit,
    QMessageBox,
    QTableView,
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
    # Compare values: findData compares wrapped Python objects by identity.
    for index in range(combo.count()):
        if combo.itemData(index) == value:
            combo.setCurrentIndex(index)
            return


MONTHS = (
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
)


def month_label(month: Any) -> str:
    """YearMonth -> 'março de 2026' (how people say it, not '2026-03')."""
    return f"{MONTHS[month.month - 1]} de {month.year}"


def style_table(table: QAbstractItemView) -> None:
    """Shared table look and behavior: rows, no grid, zebra, keyboard-friendly."""
    table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
    table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
    table.setAlternatingRowColors(True)
    table.setHorizontalScrollMode(QAbstractItemView.ScrollMode.ScrollPerPixel)
    table.setVerticalScrollMode(QAbstractItemView.ScrollMode.ScrollPerPixel)
    if isinstance(table, QTableView):
        table.setShowGrid(False)
        table.setWordWrap(False)
        table.setCornerButtonEnabled(False)
        table.verticalHeader().setVisible(False)
        table.verticalHeader().setDefaultSectionSize(26)
        header = table.horizontalHeader()
        header.setDefaultAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
        header.setSectionResizeMode(QHeaderView.ResizeMode.Interactive)
        header.setStretchLastSection(True)
        header.setHighlightSections(False)


def stretch_column(table: QTableView, column: int = 0) -> None:
    """For short summary tables: the name column takes the slack, figures stay next to it."""
    header = table.horizontalHeader()
    header.setStretchLastSection(False)
    header.setSectionResizeMode(column, QHeaderView.ResizeMode.Stretch)


def make_table(headers: list[str]) -> QTableWidget:
    table = QTableWidget(0, len(headers))
    table.setHorizontalHeaderLabels(headers)
    style_table(table)
    table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
    table.setSortingEnabled(True)
    return table


def set_rows(table: QTableWidget, rows: list[tuple[list[Any], Any]]) -> None:
    """Rows are (cells, id); the id is stored in column 0 for selection lookups."""
    sortable = table.isSortingEnabled()
    table.setSortingEnabled(False)
    table.setRowCount(len(rows))
    for r, (cells, row_id) in enumerate(rows):
        for c, value in enumerate(cells):
            item = QTableWidgetItem(str(value))
            if isinstance(value, str) and value.startswith(("R$", "-R$", "+R$")):
                item.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
                header = table.horizontalHeaderItem(c)
                if header is not None:
                    header.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            if c == 0:
                item.setData(Qt.ItemDataRole.UserRole, row_id)
            table.setItem(r, c, item)
    table.setSortingEnabled(sortable)
    table.resizeColumnsToContents()


def selected_id(table: QTableWidget) -> Any:
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


def install_column_chooser(view: QTableView, settings_key: str, required: set[int] | None = None) -> None:
    """Right-click on the header shows/hides columns; the choice is remembered per computer."""
    from PySide6.QtCore import QSettings
    from PySide6.QtWidgets import QMenu

    header = view.horizontalHeader()
    model = view.model()
    required = required or {0}
    settings = QSettings("OpesVault", "OpesVault")
    stored = settings.value(f"{settings_key}/colunas_ocultas", [], type=list)
    hidden = [str(c) for c in stored] if isinstance(stored, list) else []
    for column in range(model.columnCount()):
        view.setColumnHidden(column, str(column) in hidden and column not in required)

    def show_menu(position: Any) -> None:
        menu = QMenu(view)
        for column in range(model.columnCount()):
            title = model.headerData(column, Qt.Orientation.Horizontal, Qt.ItemDataRole.DisplayRole)
            action = menu.addAction(str(title))
            action.setCheckable(True)
            action.setChecked(not view.isColumnHidden(column))
            action.setEnabled(column not in required)
            action.toggled.connect(lambda visible, c=column: toggle(c, visible))
        menu.exec(header.mapToGlobal(position))

    def toggle(column: int, visible: bool) -> None:
        view.setColumnHidden(column, not visible)
        columns = [str(c) for c in range(model.columnCount()) if view.isColumnHidden(c)]
        settings.setValue(f"{settings_key}/colunas_ocultas", columns)

    header.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
    header.customContextMenuRequested.connect(show_menu)
    header.setToolTip("Clique com o botão direito para escolher as colunas")
