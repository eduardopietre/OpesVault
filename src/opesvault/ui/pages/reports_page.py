"""Relatórios: the required charts (docs/07 §4) with period, regime and inspection."""

from datetime import date

from PySide6.QtWidgets import QComboBox, QFileDialog, QHBoxLayout, QLabel, QMessageBox, QPushButton, QVBoxLayout

from opesvault.charts import data as charts
from opesvault.charts.data import Point
from opesvault.domain.model import YearMonth
from opesvault.ui.pages.base import Page

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

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        from opesvault.charts.render import ChartWidget

        self.kind = QComboBox()
        for label, key in CHARTS:
            self.kind.addItem(label, key)
        self.months = QComboBox()
        for label, count in (("Últimos 6 meses", 6), ("Últimos 12 meses", 12), ("Últimos 24 meses", 24)):
            self.months.addItem(label, count)
        self.months.setCurrentIndex(1)
        draw = QPushButton("Atualizar")
        export = QPushButton("Exportar imagem…")
        export.clicked.connect(self.export)
        self.kind.currentIndexChanged.connect(self.refresh)
        self.months.currentIndexChanged.connect(self.refresh)
        draw.clicked.connect(self.refresh)
        self.chart = ChartWidget(self.inspect)
        bar = QHBoxLayout()
        for widget in (QLabel("Gráfico:"), self.kind, QLabel("Período:"), self.months, draw, export):
            bar.addWidget(widget)
        bar.addStretch()
        layout = QVBoxLayout(self)
        layout.addLayout(bar)
        layout.addWidget(self.chart)

    def build(self) -> charts.Chart | None:
        if self.session is None:
            return None
        ledger = self.session.ledger
        end = YearMonth.of(date.today())
        start = end.add(-(self.months.currentData() - 1))
        key = self.kind.currentData()
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

    def inspect(self, series: str, point: Point) -> None:
        QMessageBox.information(self, "Dados do ponto", self.chart.tooltip_text(series, point))

    def export(self) -> None:
        if self.chart.chart is None:
            return
        path, _ = QFileDialog.getSaveFileName(self, "Exportar imagem", "grafico.png", "PNG (*.png)")
        if not path:
            return
        confirm = QMessageBox.question(
            self,
            "Exportar",
            "A imagem será gravada fora do cofre, sem criptografia. Continuar?",
        )
        if confirm == QMessageBox.StandardButton.Yes:
            self.chart.export_png(path)
