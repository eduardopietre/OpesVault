"""Investimentos: positions, valuations, flows, redemptions and the simulator (docs/07 §2-3, §6)."""

from datetime import date
from decimal import Decimal
from typing import Any
from uuid import UUID

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QLineEdit,
    QMessageBox,
    QSplitter,
    QStackedWidget,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.money import format_decimal_br
from opesvault.investments import service as inv
from opesvault.investments.model import (
    ASSET_CLASS_LABELS,
    NATURE_LABELS,
    EventKind,
    EventQuality,
    TaxRule,
    TaxRuleKind,
    TrackingMode,
)
from opesvault.investments.performance import realized, unrealized, value_at
from opesvault.ui.common import (
    combo_value,
    date_edit,
    fill_combo,
    fmt,
    fmt_date,
    from_qdate,
    make_table,
    money_edit,
    read_money,
    run_guarded,
    selected_id,
    set_rows,
)
from opesvault.ui.components import EmptyState, button, hbox, menu_button, text
from opesvault.ui.dialogs import FormDialog, asset_accounts
from opesvault.ui.pages.base import Page
from opesvault.ui.theme import SPACE_S, SPACE_XS

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


def cash_accounts(ledger: Ledger) -> list[tuple[str, UUID]]:
    from opesvault.domain.model import AccountSubtype

    return [(n, i) for n, i in asset_accounts(ledger) if ledger.accounts[i].subtype is not AccountSubtype.INVESTMENT]


class Form(FormDialog):
    """Small declarative form: fields are (key, label, widget)."""

    def __init__(self, parent: QWidget, title: str, fields: list[tuple[str, str, QWidget]], check: Any = None) -> None:
        super().__init__(parent, title)
        self.fields = {key: widget for key, _, widget in fields}
        for _, label, widget in fields:
            self.form.addRow(label, widget)
        self._check = check

    def money(self, key: str, *, optional: bool = False) -> Decimal | None:
        widget = self.fields[key]
        assert isinstance(widget, QLineEdit)
        return read_money(widget, allow_empty=optional)

    def date(self, key: str) -> date:
        return from_qdate(self.fields[key].date())  # type: ignore[attr-defined]

    def value(self, key: str) -> Any:
        widget = self.fields[key]
        if isinstance(widget, QComboBox):
            return combo_value(widget)
        if isinstance(widget, QCheckBox):
            return widget.isChecked()
        if isinstance(widget, QLineEdit):
            return widget.text().strip()
        return None

    def validate(self) -> None:
        if self._check is not None:
            self._check(self)


def _combo(items: list[tuple[str, Any]], empty: str | None = None) -> QComboBox:
    combo = QComboBox()
    fill_combo(combo, items, empty=empty)
    return combo


class InvestmentsPage(Page):
    title = "Investimentos"
    section = "Patrimônio"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        from opesvault.charts.render import ChartWidget

        self.positions = make_table(
            [
                "Investimento",
                "Classe",
                "Modo",
                "Custo remanescente",
                "Último valor",
                "Data-base",
                "Não realizado",
                "Realizado",
            ]
        )
        self.positions.itemSelectionChanged.connect(self._show_detail)
        self.positions.setAccessibleName("Investimentos")
        new = button("Novo investimento…", self.new_position, role="primary")
        record = menu_button(
            "Registrar",
            [
                ("Avaliação…", self.new_valuation),
                None,
                ("Aporte…", self.contribution),
                ("Provento…", self.distribution),
                ("Resgate…", self.redemption),
                ("Resgate só com o líquido…", self.net_only),
                ("Completar resgate…", self.complete),
                None,
                ("Pagamento de imposto…", self.pay_tax),
            ],
            tip="Eventos do investimento selecionado",
        )
        trade = menu_button(
            "Negociação",
            [
                ("Compra…", self.buy),
                ("Venda…", self.sell),
                ("Posição inicial…", self.opening),
                None,
                ("Desdobramento ou grupamento…", self.split),
                ("Bonificação…", self.bonus),
            ],
            tip="Ativos acompanhados por quantidade",
        )
        more = menu_button(
            "Mais",
            [
                ("Simular resgate…", self.simulate),
                ("Regra de imposto…", self.new_rule),
                None,
                ("Importar índice de referência…", self.import_benchmark),
            ],
        )
        self.header.add(record, trade, more, new)
        self.position_actions = (record, trade)

        self.valuations = make_table(["Data", "Valor", "Natureza", "Fonte", "Usada", "Quantidade", "Observação"])
        self.events = make_table(
            ["Data", "Evento", "Bruto", "Custo atribuído", "Imposto", "Taxas", "Líquido", "Qualidade"]
        )
        self.evolution = ChartWidget()
        self.result_chart = ChartWidget()
        valuation_actions = hbox(
            button("Usar esta observação", self.use_valuation),
            button("Corrigir observação…", self.fix_valuation),
            None,
        )
        valuation_box = QWidget()
        vb = QVBoxLayout(valuation_box)
        vb.setContentsMargins(0, SPACE_S, 0, 0)
        vb.addLayout(valuation_actions)
        vb.addWidget(self.valuations)
        tabs = QTabWidget()
        tabs.addTab(self.evolution, "Evolução")
        tabs.addTab(self.result_chart, "Resultado")
        tabs.addTab(valuation_box, "Avaliações")
        tabs.addTab(self.events, "Movimentos")
        self.lots = make_table(["Aquisição", "Origem", "Quantidade", "Custo", "Qtd. restante", "Custo restante"])
        tabs.addTab(self.lots, "Lotes")
        self.returns_chart = ChartWidget()
        self.returns_table = make_table(["Método", "Resultado", "Qualidade", "Observações"])
        self.period_start = QComboBox()
        self.period_end = QComboBox()
        self.benchmark = QComboBox()
        compute = button("Calcular", self._show_returns)
        returns_box = QWidget()
        rb = QVBoxLayout(returns_box)
        rb.setContentsMargins(0, SPACE_S, 0, 0)
        period = hbox(
            text("De", "secondary"),
            self.period_start,
            text("até", "secondary"),
            self.period_end,
            SPACE_S,
            text("Índice", "secondary"),
            self.benchmark,
            compute,
            None,
        )
        rb.addLayout(period)
        rb.addWidget(self.returns_table)
        rb.addWidget(self.returns_chart)
        tabs.addTab(returns_box, "Rentabilidade")
        self.summary = text("", "secondary", wrap=True)
        self.detail_title = text("", "headline")
        detail = QWidget()
        dl = QVBoxLayout(detail)
        dl.setContentsMargins(0, SPACE_S, 0, 0)
        dl.setSpacing(SPACE_XS)
        dl.addWidget(self.detail_title)
        dl.addWidget(self.summary)
        dl.addWidget(tabs, 1)
        self.empty = EmptyState(
            "Nenhum investimento",
            "Cadastre um investimento para acompanhar avaliações, aportes, resgates e rentabilidade.",
            [button("Novo investimento…", self.new_position)],
        )
        splitter = QSplitter(Qt.Orientation.Vertical)
        splitter.setChildrenCollapsible(False)
        splitter.addWidget(self.positions)
        splitter.addWidget(detail)
        splitter.setSizes([180, 520])
        self.views = QStackedWidget()
        self.views.addWidget(splitter)
        self.views.addWidget(self.empty)
        layout = self.page_layout()
        layout.addWidget(self.views, 1)

    # ── data ────────────────────────────────────────

    def refresh(self) -> None:
        if self.session is None:
            self.positions.setRowCount(0)
            return
        ledger = self.session.ledger
        today = date.today()
        rows: list[tuple[list[Any], Any]] = []
        for pos in inv.positions(ledger).values():
            asset = inv.assets(ledger)[pos.asset_id]
            observed = value_at(ledger, pos.id, today)
            gain = unrealized(ledger, pos.id, today)
            done = realized(ledger, pos.id)
            rows.append(
                (
                    [
                        asset.name + (" (encerrado)" if pos.closed else ""),
                        ASSET_CLASS_LABELS[asset.asset_class],
                        "Quantidade" if pos.mode is TrackingMode.QUANTITY else "Valor",
                        fmt(inv.remaining_cost(ledger, pos.id)) if pos.cost_known else "desconhecido",
                        fmt(observed.valuation.value) if observed else "sem avaliação",
                        f"{fmt_date(observed.valuation.on)} ({NATURE_LABELS[observed.valuation.nature]})"
                        if observed
                        else "—",
                        fmt(gain.value) if gain.available else "indisponível",
                        fmt(done.value) + (" (incompleto)" if done.quality.value == "incomplete" else ""),
                    ],
                    pos.id,
                )
            )
        set_rows(self.positions, rows)
        self.views.setCurrentIndex(0 if rows else 1)
        open_count = sum(1 for p in inv.positions(ledger).values() if not p.closed)
        total = f" · {len(rows)} no total" if len(rows) != open_count else ""
        self.header.set_subtitle(f"{open_count} em carteira{total}")
        if rows and selected_id(self.positions) is None:
            self.positions.selectRow(0)  # the detail area is never blank when there is something to show
        self._show_detail()

    def _position_id(self) -> UUID | None:
        return selected_id(self.positions)

    def _show_detail(self) -> None:
        pos_id = self._position_id()
        for action in self.position_actions:
            action.setEnabled(pos_id is not None)
        if self.session is None or pos_id is None:
            self.valuations.setRowCount(0)
            self.events.setRowCount(0)
            self.detail_title.setText("")
            self.summary.setText("Selecione um investimento.")
            return
        position = inv.positions(self.session.ledger)[pos_id]
        self.detail_title.setText(inv.assets(self.session.ledger)[position.asset_id].name)
        from opesvault.charts.data import investment_evolution, investment_result

        ledger = self.session.ledger
        today = date.today()
        gain = unrealized(ledger, pos_id, today)
        self.summary.setText(
            f"Resultado não realizado: {fmt(gain.value) if gain.available else 'indisponível'} — {gain.method}"
            + (f" ({'; '.join(gain.notes)})" if gain.notes else "")
        )
        set_rows(
            self.valuations,
            [
                (
                    [
                        fmt_date(v.on),
                        fmt(v.value),
                        NATURE_LABELS[v.nature],
                        v.source,
                        "sim" if v.selected else "não",
                        format_decimal_br(v.quantity) if v.quantity is not None else "—",
                        v.note or "",
                    ],
                    v.id,
                )
                for v in inv.valuations_of(ledger, pos_id)
            ],
        )
        set_rows(
            self.events,
            [
                (
                    [
                        fmt_date(e.on),
                        EVENT_LABELS[e.kind],
                        fmt(e.gross),
                        fmt(e.cost_attributed),
                        fmt(e.tax_withheld + e.tax_due_later) if e.gross is not None else "a discriminar",
                        fmt(e.fees),
                        fmt(e.net),
                        "incompleto" if e.quality is EventQuality.INCOMPLETE else "completo",
                    ],
                    e.id,
                )
                for e in inv.events_of(ledger, pos_id)
            ],
        )
        self.evolution.show_chart(investment_evolution(ledger, pos_id))
        self.result_chart.show_chart(investment_result(ledger, pos_id))
        from opesvault.investments.trades import lots_of

        set_rows(
            self.lots,
            [
                (
                    [
                        fmt_date(lot.acquired_on),
                        lot.source,
                        format_decimal_br(lot.quantity),
                        fmt(lot.cost),
                        format_decimal_br(lot.remaining_quantity),
                        fmt(lot.remaining_cost),
                    ],
                    lot.id,
                )
                for lot in lots_of(ledger, pos_id)
            ],
        )
        dates = sorted({v.on for v in inv.valuations_of(ledger, pos_id) if v.selected})
        for combo, default in ((self.period_start, 0), (self.period_end, len(dates) - 1)):
            combo.clear()
            for d in dates:
                combo.addItem(fmt_date(d), d)
            combo.setCurrentIndex(max(default, 0))
        from opesvault.investments.benchmarks import benchmarks

        fill_combo(self.benchmark, [(b.name, b.id) for b in benchmarks(ledger).values()], empty="(nenhum)")
        self._show_returns()

    def _show_returns(self) -> None:
        pos_id = self._position_id()
        start, end = self.period_start.currentData(), self.period_end.currentData()
        if self.session is None or pos_id is None or start is None or end is None or start >= end:
            self.returns_table.setRowCount(0)
            return
        from opesvault.charts.data import returns_chart
        from opesvault.investments.benchmarks import benchmark_return, benchmarks
        from opesvault.investments.returns import all_methods

        ledger = self.session.ledger
        results = all_methods(ledger, pos_id, start, end)
        bench_id = self.benchmark.currentData()
        if bench_id is not None:
            results.append(benchmark_return(benchmarks(ledger)[bench_id], start, end))

        def pct(value: Decimal | None) -> str:
            return "indisponível" if value is None else f"{format_decimal_br(value * 100, 2)}%"

        set_rows(
            self.returns_table,
            [([r.method, pct(r.value), r.quality.value, "; ".join(r.notes)], None) for r in results],
        )
        self.returns_chart.show_chart(returns_chart(ledger, pos_id, start, end))

    # ── commands ────────────────────────────────────

    def _run_form(self, form: Form, apply: Any) -> None:
        if form.exec() and run_guarded(self, lambda: apply(form) or True):
            self.changed()

    def _need_position(self) -> UUID | None:
        pos_id = self._position_id()
        if pos_id is None:
            QMessageBox.information(self, "Investimentos", "Selecione um investimento.")
        return pos_id

    def new_position(self) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        fields: list[tuple[str, str, QWidget]] = [
            ("name", "Nome:", QLineEdit()),
            ("class", "Classe:", _combo([(label, c) for c, label in ASSET_CLASS_LABELS.items()])),
            (
                "mode",
                "Acompanhamento:",
                _combo(
                    [("Por valor observado", TrackingMode.VALUE), ("Por quantidade e preço", TrackingMode.QUANTITY)]
                ),
            ),
            ("ticker", "Código (opcional):", QLineEdit()),
            ("holder", "Titular:", _combo([(m.name, m.id) for m in ledger.members.values()], empty="(família)")),
            ("on", "Data inicial:", date_edit()),
            ("cost", "Capital/custo inicial:", money_edit("vazio se desconhecido")),
            ("from", "Dinheiro saiu de:", _combo(cash_accounts(ledger), empty="(investimento já existente)")),
            ("reference", "Valor de referência:", money_edit("se o custo é desconhecido")),
        ]

        def check(form: Form) -> None:
            if not form.value("name"):
                raise DomainError("Informe o nome.")
            if form.money("cost", optional=True) is None and form.money("reference", optional=True) is None:
                raise DomainError("Informe o custo inicial ou um valor de referência.")

        def apply(form: Form) -> None:
            inv.create_position(
                ledger,
                form.value("name"),
                form.value("class"),
                form.date("on"),
                holder_id=form.value("holder"),
                mode=form.value("mode"),
                ticker=form.value("ticker") or None,
                initial_cost=form.money("cost", optional=True),
                from_account=form.value("from"),
                reference_value=form.money("reference", optional=True),
            )

        self._run_form(Form(self, "Novo investimento", fields, check), apply)

    def new_valuation(self) -> None:
        pos_id = self._need_position()
        if self.session is None or pos_id is None:
            return
        ledger = self.session.ledger
        fields: list[tuple[str, str, QWidget]] = [
            ("on", "Data:", date_edit()),
            ("value", "Valor:", money_edit()),
            ("nature", "Natureza:", _combo([(label, n) for n, label in NATURE_LABELS.items()])),
            ("source", "Fonte:", QLineEdit("manual")),
            ("note", "Observação:", QLineEdit()),
        ]
        if inv.position(ledger, pos_id).mode is TrackingMode.QUANTITY:
            fields += [("quantity", "Quantidade:", QLineEdit()), ("price", "Preço unitário:", money_edit())]

        def apply(form: Form) -> None:
            quantity = form.value("quantity") if "quantity" in form.fields else None
            inv.add_valuation(
                ledger,
                pos_id,
                form.date("on"),
                form.money("value"),
                form.value("nature"),
                source=form.value("source") or "manual",
                quantity=quantity.replace(".", "").replace(",", ".") if quantity else None,
                unit_price=form.money("price", optional=True) if "price" in form.fields else None,
                note=form.value("note") or None,
            )

        self._run_form(Form(self, "Nova avaliação", fields), apply)

    def use_valuation(self) -> None:
        valuation_id = selected_id(self.valuations)
        if self.session is None or valuation_id is None:
            return
        ledger = self.session.ledger
        if run_guarded(self, lambda: inv.select_valuation(ledger, valuation_id) or True):
            self.changed()

    def fix_valuation(self) -> None:
        valuation_id = selected_id(self.valuations)
        if self.session is None or valuation_id is None:
            return
        ledger = self.session.ledger
        fields: list[tuple[str, str, QWidget]] = [
            ("value", "Valor corrigido:", money_edit()),
            ("reason", "Motivo:", QLineEdit()),
        ]
        self._run_form(
            Form(self, "Corrigir observação", fields),
            lambda form: inv.correct_valuation(ledger, valuation_id, form.money("value"), form.value("reason")),
        )

    def contribution(self) -> None:
        pos_id = self._need_position()
        if self.session is None or pos_id is None:
            return
        ledger = self.session.ledger
        fields: list[tuple[str, str, QWidget]] = [
            ("on", "Data:", date_edit()),
            ("value", "Valor:", money_edit()),
            ("from", "Saiu da conta:", _combo(cash_accounts(ledger))),
        ]
        self._run_form(
            Form(self, "Aporte", fields),
            lambda form: inv.contribute(ledger, pos_id, form.money("value"), form.date("on"), form.value("from")),
        )

    def distribution(self) -> None:
        pos_id = self._need_position()
        if self.session is None or pos_id is None:
            return
        ledger = self.session.ledger
        fields: list[tuple[str, str, QWidget]] = [
            ("on", "Data:", date_edit()),
            ("value", "Valor bruto:", money_edit()),
            ("tax", "Imposto retido:", money_edit("0,00")),
            ("to", "Creditado na conta:", _combo(cash_accounts(ledger))),
        ]
        self._run_form(
            Form(self, "Provento pago fora do investimento", fields),
            lambda form: inv.distribute(
                ledger,
                pos_id,
                form.money("value"),
                form.date("on"),
                form.value("to"),
                form.money("tax", optional=True) or 0,
            ),
        )

    def redemption(self) -> None:
        pos_id = self._need_position()
        if self.session is None or pos_id is None:
            return
        ledger = self.session.ledger
        fields: list[tuple[str, str, QWidget]] = [
            ("on", "Data:", date_edit()),
            ("gross", "Valor bruto:", money_edit()),
            ("cost", "Custo atribuído:", money_edit("vazio = proporcional")),
            ("withheld", "Imposto retido no ato:", money_edit("0,00")),
            ("later", "Imposto devido a pagar depois:", money_edit("0,00")),
            ("fees", "Taxas descontadas:", money_edit("0,00")),
            ("net", "Líquido creditado (conferência):", money_edit("opcional")),
            ("to", "Conta de destino:", _combo(cash_accounts(ledger))),
            ("final", "", QCheckBox("Resgate total (encerra a posição)")),
        ]
        self._run_form(
            Form(self, "Resgate", fields),
            lambda form: inv.redeem(
                ledger,
                pos_id,
                form.date("on"),
                form.money("gross"),
                form.value("to"),
                cost_attributed=form.money("cost", optional=True),
                tax_withheld=form.money("withheld", optional=True) or 0,
                tax_due_later=form.money("later", optional=True) or 0,
                fees=form.money("fees", optional=True) or 0,
                net_informed=form.money("net", optional=True),
                final=form.value("final"),
            ),
        )

    def net_only(self) -> None:
        pos_id = self._need_position()
        if self.session is None or pos_id is None:
            return
        ledger = self.session.ledger
        fields: list[tuple[str, str, QWidget]] = [
            ("on", "Data:", date_edit()),
            ("net", "Líquido recebido:", money_edit()),
            ("to", "Conta de destino:", _combo(cash_accounts(ledger))),
        ]
        self._run_form(
            Form(self, "Resgate com deduções a discriminar", fields),
            lambda form: inv.redeem_net_only(ledger, pos_id, form.date("on"), form.money("net"), form.value("to")),
        )

    def complete(self) -> None:
        event_id = selected_id(self.events)
        if self.session is None or event_id is None:
            QMessageBox.information(self, "Investimentos", "Selecione o resgate incompleto na aba Movimentos.")
            return
        ledger = self.session.ledger
        fields: list[tuple[str, str, QWidget]] = [
            ("gross", "Valor bruto:", money_edit()),
            ("cost", "Custo atribuído:", money_edit("vazio = proporcional")),
            ("withheld", "Imposto retido:", money_edit("0,00")),
            ("fees", "Taxas:", money_edit("0,00")),
        ]
        self._run_form(
            Form(self, "Completar resgate", fields),
            lambda form: inv.complete_redemption(
                ledger,
                event_id,
                form.money("gross"),
                cost_attributed=form.money("cost", optional=True),
                tax_withheld=form.money("withheld", optional=True) or 0,
                fees=form.money("fees", optional=True) or 0,
            ),
        )

    def simulate(self) -> None:
        pos_id = self._need_position()
        if self.session is None or pos_id is None:
            return
        from opesvault.investments.simulation import simulate

        ledger = self.session.ledger
        rules = [(r.name, r) for r in ledger.entities("tax_rule").values()]
        if not rules:
            QMessageBox.information(self, "Simulador", "Cadastre uma regra de imposto (botão 'Regra de imposto').")
            return
        fields: list[tuple[str, str, QWidget]] = [
            ("on", "Data:", date_edit()),
            ("gross", "Valor bruto a resgatar:", money_edit()),
            ("rule", "Regra:", _combo(rules)),
            ("fees", "Taxas:", money_edit("0,00")),
            ("cost", "Custo atribuído:", money_edit("vazio = proporcional")),
        ]
        form = Form(self, "Simular resgate (não altera nada)", fields)
        if not form.exec():
            return

        def run() -> Any:
            observed = value_at(ledger, pos_id, form.date("on"))
            return simulate(
                ledger,
                pos_id,
                form.date("on"),
                form.money("gross"),
                form.value("rule"),
                fees=form.money("fees", optional=True) or 0,
                cost_attributed=form.money("cost", optional=True),
                current_value=observed.valuation.value if observed else None,
            )

        sim = run_guarded(self, run)
        if sim is None:
            return

        def pct(value: Decimal | None) -> str:
            return "indisponível" if value is None else f"{format_decimal_br(value * 100, 2)}%"

        lines = [
            "SIMULAÇÃO — não registra operação",
            f"Valor bruto: {fmt(sim.gross)}",
            f"Custo atribuído: {fmt(sim.cost_attributed)} ({sim.cost_method})",
            f"Ganho: {fmt(sim.gain)}",
            f"Base do imposto: {fmt(sim.tax_base)}",
            f"Regra: {sim.rule}",
            f"Imposto (estimado): {fmt(sim.tax)}",
            f"Taxas: {fmt(sim.fees)}",
            f"Líquido estimado: {fmt(sim.net)}",
            f"Retorno bruto: {pct(sim.gross_return)} · líquido: {pct(sim.net_return)} (sem anualização)",
            "Campos estimados: " + ", ".join(sim.estimated_fields),
        ]
        QMessageBox.information(self, "Simulador de resgate", "\n".join(lines))

    def pay_tax(self) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        fields: list[tuple[str, str, QWidget]] = [
            ("on", "Data do pagamento:", date_edit()),
            ("value", "Valor:", money_edit()),
            ("from", "Pago pela conta:", _combo(cash_accounts(ledger))),
        ]
        self._run_form(
            Form(self, "Pagamento de imposto devido", fields),
            lambda form: inv.pay_tax(ledger, form.money("value"), form.date("on"), form.value("from")),
        )

    def new_rule(self) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        fields: list[tuple[str, str, QWidget]] = [
            ("name", "Nome:", QLineEdit()),
            (
                "kind",
                "Tipo:",
                _combo(
                    [
                        ("Percentual sobre ganho positivo", TaxRuleKind.RATE_ON_POSITIVE_GAIN),
                        ("Percentual sobre base informada", TaxRuleKind.RATE_ON_INFORMED_BASE),
                        ("Valor fixo", TaxRuleKind.FIXED),
                    ]
                ),
            ),
            ("rate", "Alíquota (%):", QLineEdit()),
            ("fixed", "Valor fixo:", money_edit("opcional")),
            ("source", "Fonte:", QLineEdit("informado pelo usuário")),
        ]

        def apply(form: Form) -> None:
            rate_text = form.value("rate")
            rate = Decimal(rate_text.replace(",", ".")) / 100 if rate_text else None
            if not form.value("name"):
                raise DomainError("Informe o nome.")
            ledger.put(
                "tax_rule",
                TaxRule(
                    name=form.value("name"),
                    kind=form.value("kind"),
                    rate=rate,
                    fixed_amount=form.money("fixed", optional=True),
                    source=form.value("source") or "informado pelo usuário",
                ),
            )

        self._run_form(Form(self, "Regra de imposto (simulação)", fields), apply)

    # ── phase 5: quantities ─────────────────────────

    def _quantity(self, form: Form, key: str) -> Decimal:
        text = form.value(key)
        try:
            return Decimal(text.replace(".", "").replace(",", "."))
        except Exception:
            raise DomainError("Quantidade inválida.") from None

    def buy(self) -> None:
        pos_id = self._need_position()
        if self.session is None or pos_id is None:
            return
        from opesvault.investments.trades import buy

        ledger = self.session.ledger
        fields: list[tuple[str, str, QWidget]] = [
            ("on", "Data:", date_edit()),
            ("qty", "Quantidade:", QLineEdit()),
            ("price", "Preço unitário:", money_edit()),
            ("fees", "Custos:", money_edit("0,00")),
            ("from", "Pago pela conta:", _combo(cash_accounts(ledger))),
        ]
        self._run_form(
            Form(self, "Compra", fields),
            lambda form: buy(
                ledger,
                pos_id,
                form.date("on"),
                self._quantity(form, "qty"),
                form.money("price"),
                form.value("from"),
                fees=form.money("fees", optional=True) or 0,
            ),
        )

    def sell(self) -> None:
        pos_id = self._need_position()
        if self.session is None or pos_id is None:
            return
        from opesvault.investments.trades import CostMethod, sell

        ledger = self.session.ledger
        fields: list[tuple[str, str, QWidget]] = [
            ("on", "Data:", date_edit()),
            ("qty", "Quantidade:", QLineEdit()),
            ("price", "Preço unitário:", money_edit()),
            ("fees", "Custos:", money_edit("0,00")),
            ("tax", "Imposto retido:", money_edit("0,00")),
            (
                "method",
                "Custo:",
                _combo(
                    [
                        ("Padrão da classe", None),
                        ("Custo médio", CostMethod.AVERAGE),
                        ("Por lote (mais antigo)", CostMethod.FIFO),
                    ]
                ),
            ),
            ("to", "Creditado na conta:", _combo(cash_accounts(ledger))),
        ]
        self._run_form(
            Form(self, "Venda", fields),
            lambda form: sell(
                ledger,
                pos_id,
                form.date("on"),
                self._quantity(form, "qty"),
                form.money("price"),
                form.value("to"),
                fees=form.money("fees", optional=True) or 0,
                tax_withheld=form.money("tax", optional=True) or 0,
                method=form.value("method"),
            ),
        )

    def opening(self) -> None:
        pos_id = self._need_position()
        if self.session is None or pos_id is None:
            return
        from opesvault.investments.trades import opening_lot

        ledger = self.session.ledger
        fields: list[tuple[str, str, QWidget]] = [
            ("on", "Data:", date_edit()),
            ("qty", "Quantidade:", QLineEdit()),
            ("cost", "Custo total conhecido:", money_edit()),
        ]
        self._run_form(
            Form(self, "Posição inicial", fields),
            lambda form: opening_lot(ledger, pos_id, form.date("on"), self._quantity(form, "qty"), form.money("cost")),
        )

    def split(self) -> None:
        pos_id = self._need_position()
        if self.session is None or pos_id is None:
            return
        from opesvault.investments.trades import split

        ledger = self.session.ledger
        fields: list[tuple[str, str, QWidget]] = [
            ("on", "Data:", date_edit()),
            ("factor", "Fator (2 = cada ação vira 2):", QLineEdit()),
        ]
        self._run_form(
            Form(self, "Desdobramento/grupamento", fields),
            lambda form: split(ledger, pos_id, form.date("on"), self._quantity(form, "factor")),
        )

    def bonus(self) -> None:
        pos_id = self._need_position()
        if self.session is None or pos_id is None:
            return
        from opesvault.investments.trades import bonus

        ledger = self.session.ledger
        fields: list[tuple[str, str, QWidget]] = [
            ("on", "Data:", date_edit()),
            ("qty", "Quantidade recebida:", QLineEdit()),
            ("cost", "Custo informado pela empresa:", money_edit("0,00")),
        ]
        self._run_form(
            Form(self, "Bonificação", fields),
            lambda form: bonus(
                ledger, pos_id, form.date("on"), self._quantity(form, "qty"), form.money("cost", optional=True) or 0
            ),
        )

    def import_benchmark(self) -> None:
        if self.session is None:
            return
        from PySide6.QtWidgets import QFileDialog, QInputDialog

        from opesvault.investments.benchmarks import import_benchmark_csv

        path, _ = QFileDialog.getOpenFileName(self, "Série do índice (data;valor)", "", "CSV (*.csv *.txt)")
        if not path:
            return
        name, ok = QInputDialog.getText(self, "Índice", "Nome do índice:")
        if not ok or not name.strip():
            return
        from pathlib import Path

        ledger = self.session.ledger
        data = Path(path).read_bytes()
        if run_guarded(self, lambda: import_benchmark_csv(ledger, name.strip(), data, f"arquivo {Path(path).name}")):
            self.changed()
