"""Relatórios: the required charts (docs/07 §4) with period, regime and inspection."""

from datetime import date

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QListWidget,
    QListWidgetItem,
    QVBoxLayout,
    QWidget,
)

from opesvault.charts import data as charts
from opesvault.charts.data import Point
from opesvault.domain.model import YearMonth
from opesvault.ui.common import month_label
from opesvault.ui.components import button, confirm, text
from opesvault.ui.pages.base import Page
from opesvault.ui.theme import SPACE_L, SPACE_S

CHARTS = (
    ("Entradas e saídas mensais", "in_out"),
    ("Resultado mensal (competência)", "result"),
    ("Fluxo de caixa", "cash"),
    ("Despesas por categoria", "categories"),
    ("Patrimônio", "net_worth"),
    ("Composição da carteira", "composition"),
    ("Projeção de compromissos", "projection"),
)


class ReportsPage(Page):
    title = "Relatórios"
    section = "Acompanhamento"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        from opesvault.charts.render import ChartWidget

        # Report list on the left (master), the chart on the right (detail).
        self.kind = QListWidget()
        self.kind.setAccessibleName("Relatórios")
        for label, key in CHARTS:
            item = QListWidgetItem(label)
            item.setData(Qt.ItemDataRole.UserRole, key)
            self.kind.addItem(item)
        self.kind.setCurrentRow(0)
        self.kind.setMaximumWidth(240)
        self.kind.setMinimumWidth(170)
        self.kind.setProperty("variant", "plain")
        self.kind.setFrameShape(QListWidget.Shape.NoFrame)
        self.months = QComboBox()
        self.months.setAccessibleName("Período")
        for label, count in (("Últimos 6 meses", 6), ("Últimos 12 meses", 12), ("Últimos 24 meses", 24)):
            self.months.addItem(label, count)
        self.months.setCurrentIndex(1)
        self.kind.currentRowChanged.connect(lambda _: self.refresh())
        self.months.currentIndexChanged.connect(self.refresh)
        self.header.add(self.months, button("Exportar imagem…", self.export))
        self.chart = ChartWidget(self.inspect)
        self.point = text("Clique em um ponto do gráfico para ver de onde vem o valor.", "caption", wrap=True)
        self.point.setAccessibleName("Dados do ponto selecionado")
        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.addWidget(self.chart, 1)
        rl.addWidget(self.point)
        body = QHBoxLayout()
        body.setContentsMargins(0, SPACE_S, 0, 0)
        body.setSpacing(SPACE_L)
        body.addWidget(self.kind)
        rule = QFrame()
        rule.setObjectName("VSeparator")
        body.addWidget(rule)
        body.addWidget(right, 1)
        layout = self.page_layout()
        layout.addLayout(body, 1)

    def build(self) -> charts.Chart | None:
        if self.session is None:
            return None
        ledger = self.session.ledger
        end = YearMonth.of(date.today())
        start = end.add(-(self.months.currentData() - 1))
        current = self.kind.currentItem()
        key = current.data(Qt.ItemDataRole.UserRole) if current is not None else "in_out"
        if key == "in_out":
            return charts.monthly_in_out(ledger, start, end)
        if key == "result":
            return charts.monthly_result(ledger, start, end)
        if key == "cash":
            return charts.cash_flow_balance(ledger, start, end)
        if key == "categories":
            return charts.expenses_by_category(ledger, start, end)
        if key == "net_worth":
            return charts.net_worth_series(ledger, start, end)
        if key == "composition":
            return charts.portfolio_composition(ledger, date.today())
        return charts.commitments_projection(ledger, end, 12)

    def refresh(self) -> None:
        chart = self.build()
        if chart is not None:
            self.chart.show_chart(chart)
            # The chart names itself; the subtitle says which months it covers.
            end = YearMonth.of(date.today())
            start = end.add(-(self.months.currentData() - 1))
            self.header.set_subtitle(f"De {month_label(start)} a {month_label(end)}")
            self.point.setText("Clique em um ponto do gráfico para ver de onde vem o valor.")

    def inspect(self, series: str, point: Point) -> None:
        # Shown beside the chart instead of a dialog, so the user can keep exploring.
        self.point.setText(self.chart.tooltip_text(series, point))

    def export(self) -> None:
        if self.chart.chart is None:
            return
        path, _ = QFileDialog.getSaveFileName(self, "Exportar imagem", "grafico.png", "PNG (*.png)")
        if not path:
            return
        if confirm(
            self,
            "Exportar imagem sem criptografia?",
            "A imagem será gravada fora do cofre, sem criptografia.",
            "Exportar",
        ):
            self.chart.export_png(path)
