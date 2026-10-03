"""Small shared UI helpers. No financial logic lives here."""

from collections.abc import Callable, Iterable, Sequence
from datetime import date
from decimal import Decimal
from typing import Any

from PySide6.QtCore import QDate, QEvent, QObject, Qt
from PySide6.QtWidgets import (
    QAbstractItemView,
    QComboBox,
    QDateEdit,
    QHeaderView,
    QLineEdit,
    QListWidget,
    QMessageBox,
    QSizePolicy,
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


def file_size(size: int) -> str:
    """Bytes as people read them: '840 bytes', '12 KB', '3,4 MB' (decimal comma)."""
    if size < 1024:
        return f"{size} bytes"
    for unit, scale in (("KB", 1024), ("MB", 1024**2), ("GB", 1024**3)):
        value = size / scale
        if value < 1024 or unit == "GB":
            shown = f"{value:.0f}" if value >= 10 else f"{value:.1f}".replace(".", ",")
            return f"{shown} {unit}"
    return f"{size} bytes"  # unreachable


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


def select_combo(combo: QComboBox, value: Any) -> bool:
    """Selects the option whose data equals `value`; False (selection unchanged) when none does.

    Never `QComboBox.findData`: it compares wrapped Python objects by identity, so an equal
    UUID or tuple read back from the vault is not found.
    """
    for index in range(combo.count()):
        if combo.itemData(index) == value:
            combo.setCurrentIndex(index)
            return True
    return False


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


class CompetenceCombo(QComboBox):
    """Competence month: "mês da data" (None) or a named month, never typed as AAAA-MM."""

    def __init__(self, value: Any = None, around: date | None = None) -> None:
        from opesvault.domain.model import YearMonth

        super().__init__()
        self.setAccessibleName("Competência")
        center = YearMonth.of(around or date.today())
        months = [center.add(offset) for offset in range(-24, 25)]
        if value is not None and value not in months:
            months.append(value)
            months.sort(key=lambda m: (m.year, m.month))
        self.addItem("Mês da data", None)
        for month in months:
            self.addItem(month_label(month).capitalize(), month)
        select_combo(self, value)

    def value(self) -> Any:
        return self.currentData()


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


class _WidthShare(QObject):
    """Keeps a work table's columns at their base widths and gives the rest to the text columns."""

    def __init__(self, view: QTableView, base: Sequence[int], grow: dict[int, int]) -> None:
        super().__init__(view)
        self._view = view
        self._base = list(base)
        self._grow = grow
        self._applying = False
        self.manual = False  # once the user drags a column, the widths are theirs
        view.viewport().installEventFilter(self)
        view.horizontalHeader().sectionResized.connect(self._resized)
        view.horizontalHeader().geometriesChanged.connect(self.apply)  # a column shown or hidden
        self.apply()

    def _resized(self, column: int, old: int, new: int) -> None:
        header = self._view.horizontalHeader()
        last = header.logicalIndex(header.count() - 1)
        hiding = old == 0 or new == 0
        if not (self._applying or hiding) and column != last and self._view.isVisible():
            self.manual = True

    def eventFilter(self, watched: QObject, event: QEvent) -> bool:  # noqa: N802 - Qt override
        if event.type() == QEvent.Type.Resize:
            self.apply()
        return False

    def apply(self) -> None:
        if self.manual or self._applying:
            return
        header = self._view.horizontalHeader()
        shown = [c for c in range(len(self._base)) if not header.isSectionHidden(c)]
        growing = [c for c in self._grow if c in shown]
        extra = self._view.viewport().width() - sum(self._base[c] for c in shown)
        total = sum(self._grow[c] for c in growing)
        self._applying = True
        try:
            for column in shown:
                width = self._base[column]
                if extra > 0 and total and column in growing:
                    width += extra * self._grow[column] // total
                if header.sectionSize(column) != width:
                    header.resizeSection(column, width)
        finally:
            self._applying = False


def share_width(view: QTableView, base: Sequence[int], grow: dict[int, int]) -> None:
    """Work tables (Livro, Importar): base widths for every column; on a wide window the slack
    goes to the text columns in `grow` ({column: share}) instead of leaving a blank band or
    stretching the last column away from the rest. A column dragged by hand stops the sharing."""
    view.horizontalHeader().setStretchLastSection(True)
    _WidthShare(view, base, grow)


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
    # Rows keep the order the page gave them (dates, severity, largest first) until the user
    # clicks a header; Qt's default indicator would sort by the first column, descending.
    table.horizontalHeader().setSortIndicator(-1, Qt.SortOrder.AscendingOrder)
    table.setSortingEnabled(True)
    table.horizontalHeader().sortIndicatorChanged.connect(lambda column, _order: _room_for_arrow(table, column))
    return table


def summary_table(headers: list[str], *, max_rows: int = 8) -> QTableWidget:
    """A short read-only table that sits in the page: no frame, no zebra, as tall as its rows.

    Call `fit_to_rows` after filling it; past `max_rows` it scrolls.
    """
    table = frameless(make_table(headers))
    table.setProperty("maxRows", max_rows)
    table.setSortingEnabled(False)
    table.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
    table.setSizeAdjustPolicy(QAbstractItemView.SizeAdjustPolicy.AdjustIgnored)
    table.setSizePolicy(table.sizePolicy().horizontalPolicy(), QSizePolicy.Policy.Fixed)
    fit_to_rows(table)
    return table


def frameless(table: QTableWidget) -> QTableWidget:
    """No outer frame and no zebra: the header rule and row dividers organize the lines.

    For tables that sit directly on the page or inside a tab; the frame is kept only for
    the large scrolling work areas (Livro, Importar), where it bounds the scrolled region.
    """
    table.setProperty("variant", "plain")
    table.setAlternatingRowColors(False)
    table.setFrameShape(QTableWidget.Shape.NoFrame)
    return table


def fit_to_rows(table: QTableWidget) -> None:
    """Height follows the content (at least one row) up to the table's `maxRows`."""
    limit = table.property("maxRows") or 8
    rows = min(max(table.rowCount(), 1), int(limit))
    header = table.horizontalHeader().sizeHint().height()
    # A table that may scroll sideways (many columns, narrow window) keeps room for its scroll bar.
    sideways = 0
    if table.horizontalScrollBarPolicy() != Qt.ScrollBarPolicy.ScrollBarAlwaysOff:
        sideways = table.horizontalScrollBar().sizeHint().height()
    table.setFixedHeight(
        header + rows * table.verticalHeader().defaultSectionSize() + 2 * table.frameWidth() + sideways
    )


def set_rows(table: QTableWidget, rows: list[tuple[list[Any], Any]]) -> None:
    """Rows are (cells, id); the id is stored in column 0 for selection lookups."""
    sortable = table.isSortingEnabled()
    table.setSortingEnabled(False)
    table.setRowCount(len(rows))
    money_columns = {
        c
        for cells, _ in rows
        for c, value in enumerate(cells)
        if isinstance(value, str) and value.startswith(("R$", "-R$", "+R$"))
    }
    right = Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter
    for column in money_columns:
        header = table.horizontalHeaderItem(column)
        if header is not None:
            header.setTextAlignment(right)
    for r, (cells, row_id) in enumerate(rows):
        for c, value in enumerate(cells):
            item = QTableWidgetItem(str(value))
            if c in money_columns:  # the whole column, so "—" lines up with the figures
                item.setTextAlignment(right)
            if c == 0:
                item.setData(Qt.ItemDataRole.UserRole, row_id)
            table.setItem(r, c, item)
    table.setSortingEnabled(sortable)
    header = table.horizontalHeader()
    stretched = [c for c in range(table.columnCount()) if header.sectionResizeMode(c) == QHeaderView.ResizeMode.Stretch]
    fit_columns(table)
    for column in stretched:  # resizing to contents leaves a Stretch column at its content width
        header.setSectionResizeMode(column, QHeaderView.ResizeMode.Stretch)
    if header.stretchLastSection():  # same for the last section, until the flag is set again
        header.setStretchLastSection(False)
        header.setStretchLastSection(True)


def select_id(view: QTableWidget | QListWidget, value: object) -> bool:
    """Selects and shows the row whose id is `value`: a table row (id stored by `set_rows` in
    column 0) or a list item (id in its UserRole). Compared by value, never by identity.

    False when there is no such row, so a caller can fall back to the first one.
    """
    if value is None:
        return False
    if isinstance(view, QListWidget):
        for row in range(view.count()):
            entry = view.item(row)
            if entry is not None and entry.data(Qt.ItemDataRole.UserRole) == value:
                view.setCurrentRow(row)
                view.scrollToItem(entry)
                return True
        return False
    for row in range(view.rowCount()):
        item = view.item(row, 0)
        if item is not None and item.data(Qt.ItemDataRole.UserRole) == value:
            view.selectRow(row)
            view.scrollToItem(item)
            return True
    return False


def fit_columns(table: QTableView) -> None:
    """Columns as wide as their contents, like `resizeColumnsToContents`.

    A sortable header asks for the sort arrow's room on every column, about 22 px each, which
    pushed a ten-column table past the window; here only the sorted column keeps that room.
    """
    table.resizeColumnsToContents()
    header = table.horizontalHeader()
    if not header.isSortIndicatorShown():
        return
    with_arrow = [header.sectionSizeHint(c) for c in range(header.count())]
    header.setSortIndicatorShown(False)
    without_arrow = [header.sectionSizeHint(c) for c in range(header.count())]
    header.setSortIndicatorShown(True)
    sorted_column = header.sortIndicatorSection()
    for column in range(header.count()):
        if header.isSectionHidden(column) or column == sorted_column:
            continue
        if with_arrow[column] > without_arrow[column] and header.sectionSize(column) == with_arrow[column]:
            table.setColumnWidth(column, max(without_arrow[column], table.sizeHintForColumn(column)))


def _room_for_arrow(table: QTableView, column: int) -> None:
    """The column the user just sorted gets the arrow's room back."""
    header = table.horizontalHeader()
    if 0 <= column < header.count() and header.sectionResizeMode(column) == QHeaderView.ResizeMode.Interactive:
        table.setColumnWidth(column, max(header.sectionSize(column), header.sectionSizeHint(column)))


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
    from PySide6.QtWidgets import QMenu

    from opesvault.ui import preferences

    header = view.horizontalHeader()
    model = view.model()
    required = required or {0}
    settings = preferences.app_settings()
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
