"""Positions tracked by quantity: buy, sell, opening lot, split and bonus (docs/06 §4)."""

from PySide6.QtWidgets import QLineEdit

from opesvault.ui.common import date_edit, money_edit
from opesvault.ui.pages.investments.base import CommandBase
from opesvault.ui.pages.investments.forms import Field, Form, cash_accounts, combo


class TradeCommands(CommandBase):
    def buy(self) -> None:
        pos_id = self._need_position()
        if self.session is None or pos_id is None:
            return
        from opesvault.investments.trades import buy

        ledger = self.session.ledger
        fields: list[Field] = [
            ("on", "Data:", date_edit()),
            ("qty", "Quantidade:", QLineEdit()),
            ("price", "Preço unitário:", money_edit()),
            ("fees", "Custos:", money_edit("0,00")),
            ("from", "Pago pela conta:", combo(cash_accounts(ledger))),
        ]
        self._run_form(
            Form(self, "Compra", fields),
            lambda form: buy(
                ledger,
                pos_id,
                form.date("on"),
                form.quantity("qty"),
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
        fields: list[Field] = [
            ("on", "Data:", date_edit()),
            ("qty", "Quantidade:", QLineEdit()),
            ("price", "Preço unitário:", money_edit()),
            ("fees", "Custos:", money_edit("0,00")),
            ("tax", "Imposto retido:", money_edit("0,00")),
            (
                "method",
                "Custo:",
                combo(
                    [
                        ("Padrão da classe", None),
                        ("Custo médio", CostMethod.AVERAGE),
                        ("Por lote (mais antigo)", CostMethod.FIFO),
                    ]
                ),
            ),
            ("to", "Creditado na conta:", combo(cash_accounts(ledger))),
        ]
        self._run_form(
            Form(self, "Venda", fields),
            lambda form: sell(
                ledger,
                pos_id,
                form.date("on"),
                form.quantity("qty"),
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
        fields: list[Field] = [
            ("on", "Data:", date_edit()),
            ("qty", "Quantidade:", QLineEdit()),
            ("cost", "Custo total conhecido:", money_edit()),
        ]
        self._run_form(
            Form(self, "Posição inicial", fields),
            lambda form: opening_lot(ledger, pos_id, form.date("on"), form.quantity("qty"), form.money("cost")),
        )

    def split(self) -> None:
        pos_id = self._need_position()
        if self.session is None or pos_id is None:
            return
        from opesvault.investments.trades import split

        ledger = self.session.ledger
        fields: list[Field] = [
            ("on", "Data:", date_edit()),
            ("factor", "Fator (2 = cada ação vira 2):", QLineEdit()),
        ]
        self._run_form(
            Form(self, "Desdobramento/grupamento", fields),
            lambda form: split(ledger, pos_id, form.date("on"), form.quantity("factor")),
        )

    def bonus(self) -> None:
        pos_id = self._need_position()
        if self.session is None or pos_id is None:
            return
        from opesvault.investments.trades import bonus

        ledger = self.session.ledger
        fields: list[Field] = [
            ("on", "Data:", date_edit()),
            ("qty", "Quantidade recebida:", QLineEdit()),
            ("cost", "Custo informado pela empresa:", money_edit("0,00")),
        ]
        self._run_form(
            Form(self, "Bonificação", fields),
            lambda form: bonus(
                ledger, pos_id, form.date("on"), form.quantity("qty"), form.money("cost", optional=True) or 0
            ),
        )
