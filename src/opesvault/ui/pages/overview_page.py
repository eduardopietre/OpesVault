"""Visão geral: cash, competence result and net worth for a month (docs/07 §2)."""

from datetime import date

from PySide6.QtWidgets import QComboBox, QFormLayout, QGroupBox, QHBoxLayout, QLabel, QPushButton, QVBoxLayout

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
        self.period_state = QLabel()
        close_button = QPushButton("Fechar mês")
        close_button.clicked.connect(self.close_month)
        reopen_button = QPushButton("Reabrir mês")
        reopen_button.clicked.connect(self.reopen_month)
        top.addWidget(self.period_state)
        top.addWidget(close_button)
        top.addWidget(reopen_button)
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
        from opesvault.domain.periods import is_closed, pending_items

        pending = pending_items(ledger, month)
        state = "Mês fechado" if is_closed(ledger, month) else "Mês aberto"
        self.period_state.setText(state + (f" · pendências: {'; '.join(pending)}" if pending else ""))

    def close_month(self) -> None:
        if self.session is None:
            return
        from opesvault.domain.periods import close_month, pending_items
        from opesvault.ui.common import run_guarded
        from opesvault.ui.dialogs import ask_reason

        ledger = self.session.ledger
        month: YearMonth = self.month.currentData()
        note = None
        if pending_items(ledger, month):
            note = ask_reason(self, "Fechar com pendências (justificativa)")
            if note is None:
                return
        if run_guarded(self, lambda: close_month(ledger, month, note)):
            self.changed()

    def reopen_month(self) -> None:
        if self.session is None:
            return
        from opesvault.domain.periods import reopen_month
        from opesvault.ui.common import run_guarded
        from opesvault.ui.dialogs import ask_reason

        ledger = self.session.ledger
        month: YearMonth = self.month.currentData()
        reason = ask_reason(self, "Reabrir mês")
        if reason and run_guarded(self, lambda: reopen_month(ledger, month, reason)):
            self.changed()
