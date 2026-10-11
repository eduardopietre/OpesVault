"""The selected investment: what it is, its key figures, and each chart beside the table it draws."""

from collections.abc import Callable
from datetime import date
from typing import Any
from uuid import UUID

from PySide6.QtWidgets import QComboBox, QVBoxLayout, QWidget

from opesvault.domain.ledger import Ledger
from opesvault.domain.money import format_decimal_br
from opesvault.investments import service as inv
from opesvault.investments.model import NATURE_LABELS, EventKind, EventQuality, TrackingMode
from opesvault.investments.performance import unrealized, value_at
from opesvault.ui.common import fill_combo, fit_to_rows, fmt, fmt_date, set_rows, stretch_column, summary_table
from opesvault.ui.components import Collapsible, ElidedLabel, Figures, adaptive, button, flow_row, text
from opesvault.ui.pages.investments.forms import percent
from opesvault.ui.theme import SPACE_L, SPACE_S, SPACE_XS

EVENT_LABELS = {
    EventKind.CONTRIBUTION: "Aporte",
    EventKind.WITHDRAWAL: "Resgate",
    EventKind.DISTRIBUTION: "Provento",
    EventKind.BUY: "Compra",
    EventKind.SELL: "Venda",
    EventKind.SPLIT: "Desdobramento",
    EventKind.BONUS: "Bonificação",
    EventKind.TAX_PAYMENT: "Imposto pago",
}
FIGURE_LABELS = ("Último valor", "Custo remanescente", "Não realizado", "Vencimento")
CHART_HEIGHT = 280
SIDE_BY_SIDE = 1200  # width from which each chart sits beside its table
MATURITY_WARNING_DAYS = 30


class InvestmentDetail(QWidget):
    """Shows one position; the page owns the commands, passed in for the observation buttons."""

    def __init__(self, use_valuation: Callable[[], None], fix_valuation: Callable[[], None]) -> None:
        super().__init__()
        from opesvault.charts.render import ChartWidget

        # The charts and the tables they come from sit together, in collapsible sections:
        # the evolution next to the valuations it draws, the result next to the movements.
        self.valuations = summary_table(
            ["Data", "Valor", "Natureza", "Fonte", "Usada", "Quantidade", "Observação"], max_rows=10
        )
        self.events = summary_table(
            ["Data", "Evento", "Bruto", "Custo atribuído", "Imposto", "Taxas", "Líquido", "Qualidade"], max_rows=10
        )
        self.lots = summary_table(
            ["Aquisição", "Origem", "Quantidade", "Custo", "Qtd. restante", "Custo restante"], max_rows=8
        )
        self.returns_table = summary_table(["Método", "Resultado", "Qualidade", "Observações"], max_rows=6)
        for table in (self.valuations, self.events, self.lots, self.returns_table):
            table.setSortingEnabled(False)
        stretch_column(self.valuations, 6)
        stretch_column(self.returns_table, 3)
        self.evolution = ChartWidget()
        self.result_chart = ChartWidget()
        self.returns_chart = ChartWidget()
        for chart, name in (
            (self.evolution, "Gráfico da evolução"),
            (self.result_chart, "Gráfico do resultado acumulado"),
            (self.returns_chart, "Gráfico da rentabilidade"),
        ):
            chart.setFixedHeight(CHART_HEIGHT)
            chart.setAccessibleName(name)
        self.period_start = QComboBox()
        self.period_end = QComboBox()
        self.benchmark = QComboBox()
        for widget, name in (
            (self.period_start, "Início do período"),
            (self.period_end, "Fim do período"),
            (self.benchmark, "Índice de referência"),
            (self.valuations, "Avaliações"),
            (self.events, "Movimentos"),
            (self.lots, "Lotes"),
            (self.returns_table, "Rentabilidade por método"),
        ):
            widget.setAccessibleName(name)

        evolution = Collapsible(
            "Evolução", "investimentos/evolucao", caption="Valores observados, com aportes, resgates e proventos."
        )
        evolution.add(self.evolution)
        valuations = Collapsible("Avaliações", "investimentos/avaliacoes", caption="Os pontos do gráfico de evolução.")
        valuations.add_actions(
            button("Usar esta observação", use_valuation),
            button("Corrigir observação…", fix_valuation),
        )
        valuations.add(self.valuations)
        result = Collapsible("Resultado acumulado", "investimentos/resultado")
        result.add(self.result_chart)
        events = Collapsible(
            "Movimentos", "investimentos/movimentos", caption="Aportes, resgates, proventos e impostos."
        )
        events.add(self.events)
        self.lots_section = Collapsible(
            "Lotes", "investimentos/lotes", caption="Custo por aquisição (modo por quantidade)."
        )
        self.lots_section.add(self.lots)
        returns = Collapsible("Rentabilidade", "investimentos/rentabilidade")
        returns.add_actions(button("Calcular", self.show_returns))
        returns.add(
            flow_row(
                text("De", "secondary"),
                self.period_start,
                text("até", "secondary"),
                self.period_end,
                text("Índice", "secondary"),
                self.benchmark,
            )
        )
        returns.add(self.returns_table)
        returns.add(self.returns_chart)

        # what it is (characteristics), the figures that matter, then how the result was obtained
        self.title = ElidedLabel("", "headline")
        self.summary = text("", "secondary", wrap=True)
        self.summary.setMinimumWidth(160)
        self.figures = Figures(FIGURE_LABELS)
        self.method_note = text("", "caption", wrap=True)
        self.method_note.setMinimumWidth(160)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(SPACE_L)
        heading = QVBoxLayout()
        heading.setSpacing(SPACE_XS)
        heading.addWidget(self.title)
        heading.addWidget(self.summary)
        heading.addSpacing(SPACE_S)
        heading.addWidget(self.figures)
        heading.addWidget(self.method_note)
        layout.addLayout(heading)
        # wide: each chart beside the table it comes from; narrow: one below the other
        layout.addWidget(adaptive(SIDE_BY_SIDE, (evolution, 3), (valuations, 2)))
        layout.addWidget(adaptive(SIDE_BY_SIDE, (result, 3), (events, 2)))
        layout.addWidget(adaptive(SIDE_BY_SIDE, (returns, 3), (self.lots_section, 2)))
        self._ledger: Ledger | None = None
        self._position: UUID | None = None

    def show_position(self, ledger: Ledger | None, position_id: UUID | None) -> None:
        """Fills every section for `position_id`; without one, nothing of the last one stays (TA-31)."""
        self._ledger, self._position = ledger, position_id
        if ledger is None or position_id is None:
            self._clear()
            return
        from opesvault.charts.data import investment_evolution, investment_result
        from opesvault.investments.benchmarks import benchmarks
        from opesvault.investments.trades import lots_of

        position = inv.positions(ledger)[position_id]
        self.title.setText(inv.assets(ledger)[position.asset_id].name)
        today = date.today()
        gain = unrealized(ledger, position_id, today)
        self.summary.setText(" · ".join(profile_summary(ledger, position_id)))
        for label, value, tone in figures(ledger, position_id, today, gain):
            self.figures.set(label, value, tone)
        self.method_note.setText(" · ".join([gain.method, *gain.notes]))
        set_rows(self.valuations, [(_valuation_row(v), v.id) for v in inv.valuations_of(ledger, position_id)])
        set_rows(self.events, [(_event_row(e), e.id) for e in inv.events_of(ledger, position_id)])
        set_rows(self.lots, [(_lot_row(lot), lot.id) for lot in lots_of(ledger, position_id)])
        for table in (self.valuations, self.events, self.lots):
            fit_to_rows(table)
        self.evolution.show_chart(investment_evolution(ledger, position_id))
        self.result_chart.show_chart(investment_result(ledger, position_id))
        self.lots_section.setVisible(self.lots.rowCount() > 0 or position.mode is TrackingMode.QUANTITY)
        dates = sorted({v.on for v in inv.valuations_of(ledger, position_id) if v.selected})
        for period, default in ((self.period_start, 0), (self.period_end, len(dates) - 1)):
            period.clear()
            for day in dates:
                period.addItem(fmt_date(day), day)
            period.setCurrentIndex(max(default, 0))
        fill_combo(self.benchmark, [(b.name, b.id) for b in benchmarks(ledger).values()], empty="(nenhum)")
        self.show_returns()

    def _clear(self) -> None:
        for table in (self.valuations, self.events, self.lots, self.returns_table):
            table.setRowCount(0)
        for chart in (self.evolution, self.result_chart, self.returns_chart):
            chart.clear()
        for combo in (self.period_start, self.period_end, self.benchmark):
            combo.clear()
        self.title.setText("")
        self.summary.setText("Selecione um investimento.")
        for label in FIGURE_LABELS:
            self.figures.set(label, "—")
        self.method_note.setText("")

    def show_returns(self) -> None:
        """Every return method for the chosen period, beside the reference index when one is picked."""
        ledger, position_id = self._ledger, self._position
        start, end = self.period_start.currentData(), self.period_end.currentData()
        if ledger is None or position_id is None or start is None or end is None or start >= end:
            self.returns_table.setRowCount(0)
            self.returns_chart.clear()
            return
        from opesvault.charts.data import returns_chart
        from opesvault.investments.benchmarks import benchmark_return, benchmarks
        from opesvault.investments.returns import all_methods

        results = all_methods(ledger, position_id, start, end)
        bench_id = self.benchmark.currentData()
        if bench_id is not None:
            results.append(benchmark_return(benchmarks(ledger)[bench_id], start, end))
        set_rows(
            self.returns_table,
            [([r.method, percent(r.value), r.quality.value, "; ".join(r.notes)], None) for r in results],
        )
        fit_to_rows(self.returns_table)
        self.returns_chart.show_chart(returns_chart(ledger, position_id, start, end))


def _valuation_row(v: Any) -> list[str]:
    return [
        fmt_date(v.on),
        fmt(v.value),
        NATURE_LABELS[v.nature],
        v.source,
        "sim" if v.selected else "não",
        format_decimal_br(v.quantity) if v.quantity is not None else "—",
        v.note or "",
    ]


def _event_row(e: Any) -> list[str]:
    return [
        fmt_date(e.on),
        EVENT_LABELS[e.kind],
        fmt(e.gross),
        fmt(e.cost_attributed),
        fmt(e.tax_withheld + e.tax_due_later) if e.gross is not None else "a discriminar",
        fmt(e.fees),
        fmt(e.net),
        "incompleto" if e.quality is EventQuality.INCOMPLETE else "completo",
    ]


def _lot_row(lot: Any) -> list[str]:
    return [
        fmt_date(lot.acquired_on),
        lot.source,
        format_decimal_br(lot.quantity),
        fmt(lot.cost),
        format_decimal_br(lot.remaining_quantity),
        fmt(lot.remaining_cost),
    ]


def figures(ledger: Ledger, position_id: UUID, today: date, gain: Any) -> list[tuple[str, str, str | None]]:
    """The investment's key figures; a missing one says so instead of showing zero."""
    from opesvault.investments import profile as prof

    position = inv.position(ledger, position_id)
    observed = value_at(ledger, position_id, today)
    found = prof.profile_of(ledger, position_id)
    maturity = found.maturity if found is not None else None
    if maturity is None:
        due, due_tone = "—", None
    else:
        days = (maturity - today).days
        due = fmt_date(maturity) + ("" if position.closed else f" ({days_text(days)})")
        due_tone = "warning" if not position.closed and days <= MATURITY_WARNING_DAYS else None
    gain_tone = None
    if gain.available:
        gain_tone = "positive" if gain.value > 0 else "negative" if gain.value < 0 else None
    return [
        ("Último valor", fmt(observed.valuation.value) if observed else "sem avaliação", None),
        (
            "Custo remanescente",
            fmt(inv.remaining_cost(ledger, position_id)) if position.cost_known else "desconhecido",
            None,
        ),
        ("Não realizado", fmt(gain.value) if gain.available else "indisponível", gain_tone),
        ("Vencimento", due, due_tone),
    ]


def days_text(days: int) -> str:
    if days == 0:
        return "hoje"
    if days > 0:
        return f"em {days} dia{'s' if days != 1 else ''}"
    return f"há {-days} dia{'s' if days != -1 else ''}"


def profile_summary(ledger: Ledger, position_id: UUID) -> list[str]:
    """Type, where it is held, yield and tax treatment, from the investment's characteristics."""
    from opesvault.catalogs.irpf import asset_label
    from opesvault.domain.banking import bank_accounts
    from opesvault.investments import profile as prof

    found = prof.profile_of(ledger, position_id)
    if found is None:
        return ["Sem características (Mais › Características…)"]
    out = [asset_label(found.irpf_group, found.irpf_code)]
    bank = bank_accounts(ledger).get(found.bank_account_id) if found.bank_account_id else None
    if bank is not None:
        out.append(bank.where)
    if found.indexer is not None:
        out.append(prof.yield_text(found))
    if found.tax is not None:
        out.append(prof.TAX_LABELS[found.tax])
    return out
