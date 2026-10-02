"""Visão geral: cash, competence result and net worth for a month (docs/07 §2)."""

from datetime import date

from PySide6.QtWidgets import QComboBox, QFormLayout, QGroupBox, QHBoxLayout, QLabel, QVBoxLayout

from opesvault.domain import queries
from opesvault.domain.model import YearMonth
from opesvault.ui.common import fmt
from opesvault.ui.pages.base import Page


class OverviewPage(Page):
    title = "Visão geral"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.month = QComboBox()
        today = YearMonth.of(date.today())
        for offset in range(0, 36):
            ym = today.add(-offset)
            self.month.addItem(str(ym), ym)
        self.month.currentIndexChanged.connect(self.refresh)
        self.labels: dict[str, QLabel] = {}
        layout = QVBoxLayout(self)
        top = QHBoxLayout()
        top.addWidget(QLabel("Mês:"))
        top.addWidget(self.month)
        top.addStretch()
        layout.addLayout(top)
        row = QHBoxLayout()
        for title, keys in (
            (
                "Caixa (regime de caixa)",
                [("cash_in", "Entradas"), ("cash_out", "Saídas"), ("cash_net", "Saldo do mês")],
            ),
            ("Resultado (competência)", [("income", "Receitas"), ("expense", "Despesas"), ("result", "Resultado")]),
            (
                "Patrimônio no fim do mês",
                [("assets", "Ativos"), ("liabilities", "Passivos"), ("net", "Patrimônio líquido")],
            ),
        ):
            box = QGroupBox(title)
            form = QFormLayout(box)
            for key, label in keys:
                self.labels[key] = QLabel("—")
                form.addRow(f"{label}:", self.labels[key])
            row.addWidget(box)
        layout.addLayout(row)
        self.note = QLabel(
            "Transferências entre contas próprias não aparecem como entrada ou saída no consolidado. "
            "Pagamento de fatura é saída de caixa; a despesa foi reconhecida na compra."
        )
        self.note.setWordWrap(True)
        layout.addWidget(self.note)
        layout.addStretch()

    def refresh(self) -> None:
        if self.session is None:
            for label in self.labels.values():
                label.setText("—")
            return
        ledger = self.session.ledger
        month: YearMonth = self.month.currentData()
        flow = queries.cash_flow(ledger, month, month)[month]
        statement = queries.income_statement(ledger, month)
        worth = queries.net_worth(ledger, month.last_day())
        values = {
            "cash_in": flow.inflow,
            "cash_out": flow.outflow,
            "cash_net": flow.net,
            "income": statement.total_income,
            "expense": statement.total_expense,
            "result": statement.result,
            "assets": worth.assets,
            "liabilities": worth.liabilities,
            "net": worth.net,
        }
        for key, value in values.items():
            self.labels[key].setText(fmt(value))
