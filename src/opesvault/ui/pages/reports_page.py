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


HINT = "Clique em um ponto do gráfico para ver de onde vem o valor."
# Which filter each chart accepts; the others have no defined per-account or per-member reading.
SCOPES = {"in_out": "account", "cash": "account", "result": "member", "categories": "category"}


def _month_of(x: object) -> YearMonth | None:
    """Monthly charts label points 'AAAA-MM'."""
    try:
        return YearMonth.parse(str(x))
    except (ValueError, TypeError):
        return None


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
        # Only the filter that has a defined meaning for the chart shown (see SCOPES).
        self.scope = QComboBox()
        self.scope.setAccessibleName("Filtro do relatório")
        self.scope.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToContents)
        self._end = YearMonth.of(date.today())  # follows the month chosen in the Overview
        self._inspected: tuple[str, Point] | None = None
        self.kind.currentRowChanged.connect(lambda _: self._kind_changed())
        self.months.currentIndexChanged.connect(self.refresh)
        self.scope.currentIndexChanged.connect(self.refresh)
        self.header.add(self.scope, self.months, button("Exportar imagem…", self.export))
        self.chart = ChartWidget(self.inspect)
        self.point = text(HINT, "caption", wrap=True)
        self.point.setAccessibleName("Dados do ponto selecionado")
        self.open_ledger = button(
            "Ver lançamentos", self._open_ledger, tip="Os lançamentos por trás do ponto, no Livro financeiro"
        )
        self.open_ledger.setEnabled(False)
        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.addWidget(self.chart, 1)
        point_row = QHBoxLayout()
        point_row.addWidget(self.point, 1)
        point_row.addWidget(self.open_ledger, 0, Qt.AlignmentFlag.AlignTop)
        rl.addLayout(point_row)
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

    def _key(self) -> str:
        current = self.kind.currentItem()
        return current.data(Qt.ItemDataRole.UserRole) if current is not None else "in_out"

    def _range(self) -> tuple[YearMonth, YearMonth]:
        return self._end.add(-(self.months.currentData() - 1)), self._end

    def _kind_changed(self) -> None:
        self._fill_scope()
        self.refresh()

    def _fill_scope(self) -> None:
        """The filter offered depends on the chart: account, member or category, or none."""
        kind = SCOPES.get(self._key())
        self.scope.blockSignals(True)
        self.scope.clear()
        if kind is not None and self.session is not None:
            from opesvault.domain.model import AccountType
            from opesvault.ui.dialogs import balance_accounts, category_items

            ledger = self.session.ledger
            label, items = {
                "account": ("Todas as contas", balance_accounts(ledger)),
                "member": ("Família inteira", [(m.name, m.id) for m in ledger.members.values() if m.active]),
                "category": ("Todas as categorias", category_items(ledger, AccountType.EXPENSE)),
            }[kind]
            self.scope.addItem(label, None)
            for name, value in items:
                self.scope.addItem(name, value)
        self.scope.setVisible(self.scope.count() > 1)
        self.scope.blockSignals(False)

    def follow_month(self, month: object) -> None:
        if isinstance(month, YearMonth) and month != self._end:
            self._end = month
            self.refresh()

    def reveal(self, ref: object, *, act: bool = False) -> None:
        """Opens a chart by key ("composition", "projection"…), from Investimentos or Recorrências."""
        for row in range(self.kind.count()):
            item = self.kind.item(row)
            if item is not None and item.data(Qt.ItemDataRole.UserRole) == ref:
                self.kind.setCurrentRow(row)
                return

    def build(self) -> charts.Chart | None:
        if self.session is None:
            return None
        ledger = self.session.ledger
        start, end = self._range()
        key = self._key()
        chosen = self.scope.currentData() if self.scope.isVisibleTo(self) else None
        if key == "in_out":
            return charts.monthly_in_out(ledger, start, end, [chosen] if chosen else None)
        if key == "result":
            return charts.monthly_result(ledger, start, end, chosen)
        if key == "cash":
            return charts.cash_flow_balance(ledger, start, end, [chosen] if chosen else None)
        if key == "categories":
            if chosen is not None:
                return charts.category_monthly(ledger, chosen, start, end)
            return charts.expenses_by_category(ledger, start, end)
        if key == "net_worth":
            return charts.net_worth_series(ledger, start, end)
        if key == "composition":
            return charts.portfolio_composition(ledger, date.today())
        return charts.commitments_projection(ledger, end, 12)

    def set_session(self, session) -> None:  # type: ignore[no-untyped-def]
        self.session = session
        self._fill_scope()
        self.refresh()

    def refresh(self) -> None:
        chart = self.build()
        if chart is not None:
            self.chart.show_chart(chart)
            # The chart names itself; the subtitle says which months it covers.
            start, end = self._range()
            self.header.set_subtitle(f"De {month_label(start)} a {month_label(end)}")
            self.point.setText(HINT)
            self._inspected = None
            self.open_ledger.setEnabled(False)

    def inspect(self, series: str, point: Point) -> None:
        # Shown beside the chart instead of a dialog, so the user can keep exploring.
        self.point.setText(self.chart.tooltip_text(series, point))
        self._inspected = (series, point)
        self.open_ledger.setEnabled(self._ledger_ref() is not None)

    def _ledger_ref(self) -> tuple[object, ...] | None:
        """The Ledger filter behind the inspected point, when the chart is made of operations."""
        if self._inspected is None or self.session is None:
            return None
        _, point = self._inspected
        key = self._key()
        if key not in ("in_out", "result", "cash", "categories"):
            return None
        chosen = self.scope.currentData() if self.scope.isVisibleTo(self) else None
        account = chosen if key in ("in_out", "cash", "categories") else None
        member = chosen if key == "result" else None
        month = _month_of(point.x)
        if key == "categories" and chosen is None:
            # One bar per category over the whole range: that category, the whole period.
            from opesvault.domain.model import AccountType

            names = {a.name: a.id for a in self.session.ledger.categories(AccountType.EXPENSE)}
            account = names.get(str(point.x))
            start, end = self._range()
            return ("filter", account, (start.first_day(), end.last_day()), None) if account else None
        return ("filter", account, month, member) if month is not None else None

    def _open_ledger(self) -> None:
        ref = self._ledger_ref()
        if ref is not None:
            self.navigate("ledger", ref)

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
