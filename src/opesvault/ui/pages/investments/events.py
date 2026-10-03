"""Events of the selected investment: valuations, contributions, income, redemptions and taxes."""

from decimal import Decimal
from typing import Any

from PySide6.QtWidgets import QCheckBox, QLineEdit, QMessageBox

from opesvault.domain.ledger import DomainError
from opesvault.investments import service as inv
from opesvault.investments.model import NATURE_LABELS, TaxRule, TaxRuleKind, TrackingMode
from opesvault.investments.performance import value_at
from opesvault.ui.common import date_edit, fmt, money_edit, run_guarded, selected_id
from opesvault.ui.pages.investments.base import CommandBase
from opesvault.ui.pages.investments.forms import Field, Form, cash_accounts, combo, percent


class EventCommands(CommandBase):
    def new_valuation(self) -> None:
        pos_id = self._need_position()
        if self.session is None or pos_id is None:
            return
        ledger = self.session.ledger
        fields: list[Field] = [
            ("on", "Data:", date_edit()),
            ("value", "Valor:", money_edit()),
            ("nature", "Natureza:", combo([(label, n) for n, label in NATURE_LABELS.items()])),
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
        valuation_id = selected_id(self.detail.valuations)
        if self.session is None or valuation_id is None:
            return
        ledger = self.session.ledger
        if run_guarded(self, lambda: inv.select_valuation(ledger, valuation_id) or True):
            self.changed()

    def fix_valuation(self) -> None:
        valuation_id = selected_id(self.detail.valuations)
        if self.session is None or valuation_id is None:
            return
        ledger = self.session.ledger
        fields: list[Field] = [
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
        fields: list[Field] = [
            ("on", "Data:", date_edit()),
            ("value", "Valor:", money_edit()),
            ("from", "Saiu da conta:", combo(cash_accounts(ledger))),
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
        fields: list[Field] = [
            ("on", "Data:", date_edit()),
            ("value", "Valor bruto:", money_edit()),
            ("tax", "Imposto retido:", money_edit("0,00")),
            ("to", "Creditado na conta:", combo(cash_accounts(ledger))),
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
        fields: list[Field] = [
            ("on", "Data:", date_edit()),
            ("gross", "Valor bruto:", money_edit()),
            ("cost", "Custo atribuído:", money_edit("vazio = proporcional")),
            ("withheld", "Imposto retido no ato:", money_edit("0,00")),
            ("later", "Imposto devido a pagar depois:", money_edit("0,00")),
            ("fees", "Taxas descontadas:", money_edit("0,00")),
            ("net", "Líquido creditado (conferência):", money_edit("opcional")),
            ("to", "Conta de destino:", combo(cash_accounts(ledger))),
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
        fields: list[Field] = [
            ("on", "Data:", date_edit()),
            ("net", "Líquido recebido:", money_edit()),
            ("to", "Conta de destino:", combo(cash_accounts(ledger))),
        ]
        self._run_form(
            Form(self, "Resgate com deduções a discriminar", fields),
            lambda form: inv.redeem_net_only(ledger, pos_id, form.date("on"), form.money("net"), form.value("to")),
        )

    def complete(self) -> None:
        event_id = selected_id(self.detail.events)
        if self.session is None or event_id is None:
            self.notify("Selecione o resgate incompleto em Movimentos.")
            return
        ledger = self.session.ledger
        fields: list[Field] = [
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
            self.notify("Cadastre antes uma regra de imposto (Mais › Regra de imposto…).")
            return
        fields: list[Field] = [
            ("on", "Data:", date_edit()),
            ("gross", "Valor bruto a resgatar:", money_edit()),
            ("rule", "Regra:", combo(rules)),
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
            f"Retorno bruto: {percent(sim.gross_return)} · líquido: {percent(sim.net_return)} (sem anualização)",
            "Campos estimados: " + ", ".join(sim.estimated_fields),
        ]
        QMessageBox.information(self, "Simulador de resgate", "\n".join(lines))

    def pay_tax(self) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        fields: list[Field] = [
            ("on", "Data do pagamento:", date_edit()),
            ("value", "Valor:", money_edit()),
            ("from", "Pago pela conta:", combo(cash_accounts(ledger))),
        ]
        self._run_form(
            Form(self, "Pagamento de imposto devido", fields),
            lambda form: inv.pay_tax(ledger, form.money("value"), form.date("on"), form.value("from")),
        )

    def new_rule(self) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        fields: list[Field] = [
            ("name", "Nome:", QLineEdit()),
            (
                "kind",
                "Tipo:",
                combo(
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
