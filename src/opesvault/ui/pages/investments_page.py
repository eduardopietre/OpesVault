"""Investimentos: positions, valuations, flows, redemptions and the simulator (docs/07 §2-3, §6)."""

from datetime import date
from decimal import Decimal
from typing import Any
from uuid import UUID

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QSplitter,
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
from opesvault.ui.dialogs import FormDialog, asset_accounts
from opesvault.ui.pages.base import Page

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
        actions = QHBoxLayout()
        for label, slot in (
            ("Novo investimento", self.new_position),
            ("Nova avaliação", self.new_valuation),
            ("Aporte", self.contribution),
            ("Provento", self.distribution),
            ("Resgate", self.redemption),
            ("Resgate só com líquido", self.net_only),
            ("Completar resgate", self.complete),
            ("Simular resgate", self.simulate),
            ("Pagar imposto", self.pay_tax),
            ("Regra de imposto", self.new_rule),
        ):
            button = QPushButton(label)
            button.clicked.connect(slot)
            actions.addWidget(button)
        actions.addStretch()

        self.valuations = make_table(["Data", "Valor", "Natureza", "Fonte", "Usada", "Quantidade", "Observação"])
        self.events = make_table(
            ["Data", "Evento", "Bruto", "Custo atribuído", "Imposto", "Taxas", "Líquido", "Qualidade"]
        )
        self.evolution = ChartWidget()
        self.result_chart = ChartWidget()
        valuation_actions = QHBoxLayout()
        use = QPushButton("Usar esta observação")
        use.clicked.connect(self.use_valuation)
        fix = QPushButton("Corrigir observação")
        fix.clicked.connect(self.fix_valuation)
        valuation_actions.addWidget(use)
        valuation_actions.addWidget(fix)
        valuation_actions.addStretch()
        valuation_box = QWidget()
        vb = QVBoxLayout(valuation_box)
        vb.addLayout(valuation_actions)
        vb.addWidget(self.valuations)
        tabs = QTabWidget()
        tabs.addTab(self.evolution, "Evolução")
        tabs.addTab(self.result_chart, "Resultado")
        tabs.addTab(valuation_box, "Avaliações")
        tabs.addTab(self.events, "Movimentos")
        self.summary = QLabel()
        self.summary.setWordWrap(True)
        detail = QWidget()
        dl = QVBoxLayout(detail)
        dl.addWidget(self.summary)
        dl.addWidget(tabs)
        splitter = QSplitter(Qt.Orientation.Vertical)
        splitter.addWidget(self.positions)
        splitter.addWidget(detail)
        layout = QVBoxLayout(self)
        layout.addLayout(actions)
        layout.addWidget(splitter)

    # ── data ────────────────────────────────────────

    def refresh(self) -> None:
        if self.session is None:
            self.positions.setRowCount(0)
            return
        ledger = self.session.ledger
        today = date.today()
        rows = []
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
        self._show_detail()

    def _position_id(self) -> UUID | None:
        return selected_id(self.positions)

    def _show_detail(self) -> None:
        pos_id = self._position_id()
        if self.session is None or pos_id is None:
            self.valuations.setRowCount(0)
            self.events.setRowCount(0)
            self.summary.setText("Selecione um investimento.")
            return
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
