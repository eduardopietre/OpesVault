"""Relatórios: the required charts (docs/07 §4), each with the table of its values on the same
page, plus the readings added on 03/10/2026 (projected balance, comparison with the average,
tags and deductible expenses)."""

from datetime import date
from typing import Any

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
from opesvault.ui.common import month_label, select_id
from opesvault.ui.components import button, confirm, scroll_body, text
from opesvault.ui.pages.base import Page
from opesvault.ui.theme import SPACE_L, SPACE_S

CHARTS = (
    ("Entradas e saídas mensais", "in_out"),
    ("Resultado mensal (competência)", "result"),
    ("Fluxo de caixa", "cash"),
    ("Saldo projetado", "projected_balance"),
    ("Despesas por categoria", "categories"),
    ("Comparação com a média", "comparison"),
    ("Patrimônio", "net_worth"),
    ("Composição da carteira", "composition"),
    ("Projeção de compromissos", "projection"),
    ("Despesas por estabelecimento", "merchants"),
    ("Marcadores", "tags"),
    ("Despesas dedutíveis", "deductibles"),
    ("Fechamento do ano", "annual"),
)


HINT = "Clique em um ponto do gráfico ou numa linha da tabela para ver de onde vem o valor."
# Which filter each chart accepts; the others have no defined per-account or per-member reading.
SCOPES = {
    "in_out": "account",
    "cash": "account",
    "result": "member",
    "categories": "category",
    "comparison": "window",
    "tags": "tag",
    "deductibles": "year",
    "annual": "year",
    "projected_balance": "horizon",
}
# Charts that read a range of months (the period combo); the others have their own reference.
MONTHLY = {"in_out", "result", "cash", "categories", "net_worth", "merchants"}


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
        from opesvault.ui.chart_panel import ChartPanel

        # Report list on the left (master), the chart and its values on the right (detail).
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
        self.export_image = button("Exportar imagem…", self.export)
        self.year_pdf = button("Relatório anual (PDF)…", self.export_year, tip="Material de apoio à declaração")
        self.header.add(self.scope, self.months, self.year_pdf, self.export_image)
        self.panel = ChartPanel("relatorios", self.inspect, chart_height=320)
        self.chart = self.panel.chart  # kept for scripts and tests
        self.point = text(HINT, "caption", wrap=True)
        self.point.setAccessibleName("Dados do ponto selecionado")
        self.open_ledger = button(
            "Ver lançamentos", self._open_ledger, tip="Os lançamentos por trás do ponto, no Livro financeiro"
        )
        self.open_ledger.setEnabled(False)
        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.setSpacing(SPACE_S)
        point_row = QHBoxLayout()
        point_row.addWidget(self.point, 1)
        point_row.addWidget(self.open_ledger, 0, Qt.AlignmentFlag.AlignTop)
        rl.addLayout(point_row)
        rl.addWidget(self.panel, 1)
        scroll, content = scroll_body()
        content.setContentsMargins(0, 0, 0, SPACE_L)
        content.addWidget(right, 1)
        body = QHBoxLayout()
        body.setContentsMargins(0, SPACE_S, 0, 0)
        body.setSpacing(SPACE_L)
        body.addWidget(self.kind)
        rule = QFrame()
        rule.setObjectName("VSeparator")
        body.addWidget(rule)
        body.addWidget(scroll, 1)
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
        """The filter offered depends on the chart: account, member, category, tag, year or none."""
        kind = SCOPES.get(self._key())
        self.scope.blockSignals(True)
        self.scope.clear()
        if kind is not None and self.session is not None:
            from opesvault.domain.model import AccountType
            from opesvault.domain.tags import all_tags
            from opesvault.ui.dialogs import balance_accounts, category_items

            ledger = self.session.ledger
            if kind == "window":
                for months in (3, 6, 12):
                    self.scope.addItem(f"Média de {months} meses", months)
            elif kind == "horizon":
                for days in (30, 60, 90):
                    self.scope.addItem(f"Próximos {days} dias", days)
                self.scope.setCurrentIndex(1)
            elif kind == "year":
                for year in range(self._end.year, self._end.year - 6, -1):
                    self.scope.addItem(f"Ano de {year}", year)
            else:
                label, items = {
                    "account": ("Todas as contas", balance_accounts(ledger)),
                    "member": ("Projeto inteiro", [(m.name, m.id) for m in ledger.members.values() if m.active]),
                    "category": ("Todas as categorias", category_items(ledger, AccountType.EXPENSE)),
                    "tag": ("Todos os marcadores", [(t, t) for t in all_tags(ledger)]),
                }[kind]
                self.scope.addItem(label, None)
                for name, value in items:
                    self.scope.addItem(name, value)
        self.scope.setVisible(self.scope.count() > 1)
        self.months.setVisible(self._key() in MONTHLY)
        self.year_pdf.setVisible(self._key() == "annual")
        self.scope.blockSignals(False)

    def follow_month(self, month: object) -> None:
        if isinstance(month, YearMonth) and month != self._end:
            self._end = month
            if SCOPES.get(self._key()) == "year":
                self._fill_scope()
            self.refresh()

    def reveal(self, ref: object, *, act: bool = False) -> None:
        """Opens a chart by key ("composition", "projection", "projected_balance"…)."""
        select_id(self.kind, ref)

    def _chosen(self) -> Any:
        return self.scope.currentData() if self.scope.isVisibleTo(self) else None

    def build(self) -> charts.Chart | None:
        if self.session is None:
            return None
        ledger = self.session.ledger
        start, end = self._range()
        key = self._key()
        chosen = self._chosen()
        if key == "in_out":
            return charts.monthly_in_out(ledger, start, end, [chosen] if chosen else None)
        if key == "result":
            return charts.monthly_result(ledger, start, end, chosen)
        if key == "cash":
            return charts.cash_flow_balance(ledger, start, end, [chosen] if chosen else None)
        if key == "projected_balance":
            return charts.projected_balance(ledger, date.today(), int(chosen or 60))
        if key == "categories":
            if chosen is not None:
                return charts.category_monthly(ledger, chosen, start, end)
            return charts.expenses_by_category(ledger, start, end)
        if key == "comparison":
            return charts.category_comparison_chart(ledger, self._end, int(chosen or 3))
        if key == "net_worth":
            return charts.net_worth_series(ledger, start, end)
        if key == "composition":
            return charts.portfolio_composition(ledger, date.today())
        if key == "tags":
            return charts.tag_chart(ledger, chosen) if chosen else charts.tags_overview(ledger)
        if key == "deductibles":
            return deductibles_chart(ledger, int(chosen or self._end.year))
        if key == "annual":
            return charts.annual_chart(ledger, int(chosen or self._end.year))
        if key == "merchants":
            return charts.merchants_chart(ledger, start.first_day(), end.last_day())
        return charts.commitments_projection(ledger, end, 12)

    def set_session(self, session) -> None:  # type: ignore[no-untyped-def]
        self.session = session
        self._fill_scope()
        self.refresh()

    def refresh(self) -> None:
        chart = self.build()
        if chart is None:
            self.panel.clear()
            self.point.setText(HINT)
            self._inspected = None
            self.open_ledger.setEnabled(False)
            return
        if chart is not None:
            self.panel.show_chart(chart)
            self.header.set_subtitle(self._subtitle())
            self.point.setText(HINT)
            self._inspected = None
            self.open_ledger.setEnabled(False)

    def _subtitle(self) -> str:
        key = self._key()
        if key in MONTHLY:
            start, end = self._range()
            return f"De {month_label(start)} a {month_label(end)}"
        if key == "comparison":
            return f"{month_label(self._end).capitalize()} comparado aos meses anteriores"
        if key == "projected_balance":
            return "A partir de hoje, com o que já está registrado"
        if key == "projection":
            return f"Doze meses a partir de {month_label(self._end)}"
        if key == "deductibles":
            from opesvault.domain.deductibles import NOTICE

            return NOTICE
        if key == "annual":
            from opesvault.domain.annual import NOTICE as ANNUAL_NOTICE

            return ANNUAL_NOTICE
        return ""

    def inspect(self, series: str, point: Point) -> None:
        # Shown beside the chart instead of a dialog, so the user can keep exploring.
        self.point.setText(self.panel.tooltip_text(series, point))
        self._inspected = (series, point)
        self.open_ledger.setEnabled(self._ledger_ref() is not None)

    def _ledger_ref(self) -> tuple[object, ...] | None:
        """The Ledger filter behind the inspected point, when the chart is made of operations."""
        if self._inspected is None or self.session is None:
            return None
        _, point = self._inspected
        key = self._key()
        chosen = self._chosen()
        if key == "tags":
            tag = chosen or str(point.x)
            return ("tag", tag)
        if key == "deductibles":
            category = point.info.get("_categoria")
            year = int(chosen or self._end.year)
            return ("filter", _uuid(category), (date(year, 1, 1), date(year, 12, 31)), None) if category else None
        if key == "comparison":
            from opesvault.domain.model import AccountType

            names = {a.name: a.id for a in self.session.ledger.categories(AccountType.EXPENSE)}
            account = names.get(str(point.x))
            return ("filter", account, self._end) if account else None
        if key not in ("in_out", "result", "cash", "categories"):
            return None
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

    def export_year(self) -> None:
        if self.session is None:
            return
        from opesvault.exports import annual_report_html
        from opesvault.ui.pdf_export import save_pdf

        ledger = self.session.ledger
        year = int(self._chosen() or self._end.year)
        if save_pdf(self, f"fechamento-{year}.pdf", lambda: annual_report_html(ledger, year)):
            self.notify(f"Fechamento de {year} gerado.")

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


def _uuid(value: object) -> Any:
    from uuid import UUID

    try:
        return UUID(str(value))
    except ValueError:
        return None


def deductibles_chart(ledger: Any, year: int) -> charts.Chart:
    """Deductible expenses of the year by category, one series per person (Relatórios)."""
    from collections import defaultdict
    from decimal import Decimal

    from opesvault.domain.deductibles import KIND_LABELS, annual
    from opesvault.domain.money import ZERO

    groups = annual(ledger, year)
    people: dict[Any, str] = {}
    totals: dict[tuple[Any, Any], Decimal] = defaultdict(lambda: ZERO)
    categories: dict[Any, str] = {}
    for group in groups:
        person = ledger.members[group.member_id].name if group.member_id in ledger.members else "Sem integrante"
        people[group.member_id] = person
        for line in group.lines:
            name, kind = ledger.account(line.category_id).name, KIND_LABELS[group.kind]
            categories[line.category_id] = name if name == kind else f"{name} ({kind})"
            totals[(line.category_id, group.member_id)] += line.amount
    series = [
        charts.Series(
            name,
            [
                charts.Point(label, totals.get((category_id, member_id), ZERO), {"_categoria": str(category_id)})
                for category_id, label in categories.items()
            ],
        )
        for member_id, name in people.items()
    ]
    return charts.Chart(f"Despesas dedutíveis de {year}", "BRL", series, ["Por pessoa; pagamentos do ano."])
