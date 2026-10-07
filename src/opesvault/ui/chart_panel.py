"""A chart and the table of its values on the same page (docs/16 §3).

Both come from the same `Chart`, so the numbers never disagree. Each sits in a collapsible
section, folded or unfolded by the user, instead of hiding each other in tabs. Clicking a
row points at the value on the chart; clicking the chart selects its row.
"""

import csv
import io
from collections.abc import Callable
from datetime import date
from decimal import Decimal

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QFileDialog, QHeaderView, QTableWidgetItem, QVBoxLayout, QWidget

from opesvault.charts.data import Chart, Point, TableRow, table_rows
from opesvault.exports import spreadsheet_cell, spreadsheet_text
from opesvault.ui.common import fit_columns, fit_to_rows, fmt, summary_table
from opesvault.ui.components import Adaptive, Collapsible, button, confirm
from opesvault.ui.theme import SPACE_L, SPACE_XL, tokens

WIDE_AT = 1000  # panel width from which the values sit beside the chart
WIDE_CHART_SCALE = 1.4

MONTHS = ("jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez")


def x_label(x: object) -> str:
    """How a chart's x reads in a table: '01/03/2026', 'mar/2026' or the category name."""
    if isinstance(x, date):
        return x.strftime("%d/%m/%Y")
    text = str(x)
    year, dash, month = text.partition("-")
    if dash and len(year) == 4 and year.isdigit() and month.isdigit() and 1 <= int(month) <= 12:
        return f"{MONTHS[int(month) - 1]}/{year}"
    return text


def value_label(value: Decimal | None, unit: str) -> str:
    if value is None:
        return "—"
    if unit == "%":
        return f"{value * 100:.2f}%".replace(".", ",")
    return fmt(value)


def first_column(rows: list[TableRow]) -> str:
    xs = [r.x for r in rows if r.x is not None]
    if xs and all(isinstance(x, date) for x in xs):
        return "Data"
    if xs and all(x_label(x) != str(x) for x in xs):
        return "Mês"
    return "Item"


class ChartPanel(QWidget):
    def __init__(
        self,
        key: str,
        on_inspect: Callable[[str, Point], None] | None = None,
        *,
        chart_title: str = "Gráfico",
        table_title: str = "Valores",
        chart_height: int = 300,
        max_rows: int = 14,
    ) -> None:
        from opesvault.charts.render import ChartWidget

        super().__init__()
        self._on_inspect = on_inspect
        self._rows: list[TableRow] = []
        self._headers: list[str] = []
        self.data: Chart | None = None
        self.chart = ChartWidget(self._chart_clicked)
        self.chart.setFixedHeight(chart_height)  # the values below stay in view
        self.chart.setAccessibleName(chart_title)
        self.table = summary_table(["Item"], max_rows=max_rows)
        self.table.setAccessibleName(table_title)
        self.table.cellClicked.connect(lambda row, _column: self._row_clicked(row))
        self.table.currentCellChanged.connect(lambda row, _c, _pr, _pc: self._row_clicked(row))
        self.chart_section = Collapsible(chart_title, f"{key}/grafico")
        self.chart_section.add(self.chart, 1)
        self.table_section = Collapsible(table_title, f"{key}/valores")
        self.export_button = button(
            "Exportar valores…", self.export_csv, role="plain", tip="Grava a tabela em CSV, fora do cofre"
        )
        self.export_button.setAccessibleName(f"Exportar valores: {table_title}")
        self.table_section.add_actions(self.export_button)
        self.table_section.add(self.table)
        # wide (1920x1080, the target): chart and values side by side; narrow: stacked, and a
        # folded section gives its room back so what follows moves up
        self.arrangement = Adaptive(WIDE_AT, spacing=SPACE_XL, stacked_spacing=SPACE_L)
        self.arrangement.add(self.chart_section, 3)
        self.arrangement.add(self.table_section, 2)
        # beside the values there is height to spare: the chart grows instead of leaving it empty
        self.arrangement.arranged.connect(
            lambda wide: self.chart.setFixedHeight(round(chart_height * WIDE_CHART_SCALE) if wide else chart_height)
        )
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.arrangement)

    def show_chart(self, chart: Chart) -> None:
        self.data = chart
        self.chart.show_chart(chart)
        self._headers, self._rows = table_rows(chart)
        first = first_column(self._rows)
        table = self.table
        table.blockSignals(True)
        table.clear()
        table.setColumnCount(1 + len(self._headers))
        table.setHorizontalHeaderLabels([first, *self._headers])
        table.setRowCount(len(self._rows))
        right = Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter
        for column in range(1, table.columnCount()):
            header = table.horizontalHeaderItem(column)
            if header is not None:
                header.setTextAlignment(right)
        summary_color = tokens().secondary
        for r, row in enumerate(self._rows):
            label = QTableWidgetItem(row.label if row.x is None else x_label(row.x))
            if row.x is None:
                label.setForeground(_color(summary_color))
                font = label.font()
                font.setBold(True)
                label.setFont(font)
            table.setItem(r, 0, label)
            for c, value in enumerate(row.values, start=1):
                item = QTableWidgetItem(value_label(value, chart.unit))
                item.setTextAlignment(right)
                table.setItem(r, c, item)
        fit_columns(table)
        header = table.horizontalHeader()
        header.setStretchLastSection(False)
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        table.blockSignals(False)
        fit_to_rows(table)

    def clear(self) -> None:
        """Nothing shown (a vault was closed): neither the chart nor its values remain."""
        self.data = None
        self._rows = []
        self._headers = []
        self.table.setRowCount(0)
        self.chart.clear()
        fit_to_rows(self.table)

    def _row_clicked(self, row: int) -> None:
        if not 0 <= row < len(self._rows):
            return
        x = self._rows[row].x
        if x is None:
            return
        point = self.chart.highlight(x)
        if point is not None and self._on_inspect is not None and self.data is not None:
            name = next((s.name for s in self.data.series if not s.hidden and point in s.points), "")
            self._on_inspect(name, point)

    def _chart_clicked(self, series: str, point: Point) -> None:
        for row, entry in enumerate(self._rows):
            if entry.x == point.x:
                self.table.blockSignals(True)
                self.table.selectRow(row)
                self.table.blockSignals(False)
                break
        if self._on_inspect is not None:
            self._on_inspect(series, point)

    def tooltip_text(self, series: str, point: Point) -> str:
        return self.chart.tooltip_text(series, point)

    def csv_bytes(self) -> bytes:
        """The table as CSV (';', decimals with '.', months as AAAA-MM), like the ledger export."""
        out = io.StringIO()
        writer = csv.writer(out, delimiter=";", lineterminator="\n")
        writer.writerow(["item", *(spreadsheet_text(h) for h in self._headers)])
        for row in self._rows:
            x = row.label if row.x is None else (row.x.isoformat() if isinstance(row.x, date) else str(row.x))
            writer.writerow([spreadsheet_cell(x), *("" if v is None else format(v, "f") for v in row.values)])
        return ("﻿" + out.getvalue()).encode("utf-8")

    def export_csv(self) -> None:
        if self.data is None:
            return
        path, _ = QFileDialog.getSaveFileName(self, "Exportar valores", "valores.csv", "CSV (*.csv)")
        if not path:
            return
        if confirm(
            self,
            "Exportar valores sem criptografia?",
            "O arquivo será gravado fora do cofre, sem criptografia.",
            "Exportar",
        ):
            with open(path, "wb") as handle:
                handle.write(self.csv_bytes())


def _color(name: str):  # type: ignore[no-untyped-def]
    from PySide6.QtGui import QColor

    return QColor(name)
