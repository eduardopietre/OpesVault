"""Livro financeiro: operations table with manual entry, correction and history (RF-10, RF-22)."""

from datetime import date

from PySide6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QVBoxLayout,
)

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountType, Operation, OperationKind, OriginKind
from opesvault.domain.money import ZERO
from opesvault.ui.common import fill_combo, fmt, fmt_date, make_table, run_guarded, selected_id, set_rows
from opesvault.ui.dialogs import OperationDialog, ask_reason
from opesvault.ui.pages.base import Page

KIND_LABELS = {
    OperationKind.OPENING_BALANCE: "Saldo de abertura",
    OperationKind.INCOME: "Receita",
    OperationKind.EXPENSE: "Despesa",
    OperationKind.TRANSFER: "Transferência",
    OperationKind.CARD_PURCHASE: "Compra no cartão",
    OperationKind.CARD_PAYMENT: "Pagamento de fatura",
    OperationKind.CARD_CHARGE: "Encargo do cartão",
    OperationKind.REFUND: "Estorno do lojista",
    OperationKind.INVESTMENT_CONTRIBUTION: "Aporte",
    OperationKind.INVESTMENT_WITHDRAWAL: "Resgate",
    OperationKind.INVESTMENT_INCOME: "Provento",
    OperationKind.TAX_PAYMENT: "Pagamento de imposto",
    OperationKind.REVERSAL: "Estorno",
    OperationKind.OTHER: "Outra",
}
ORIGIN_LABELS = {
    OriginKind.MANUAL: "Manual",
    OriginKind.IMPORT: "Importado",
    OriginKind.RECURRENCE: "Recorrência",
    OriginKind.SYSTEM: "Sistema",
}


def operation_amount(op: Operation) -> str:
    return fmt(sum((p.amount for p in op.postings if p.amount > 0), ZERO))


def operation_accounts(ledger: Ledger, op: Operation) -> str:
    debit = [ledger.accounts[p.account_id].name for p in op.postings if p.amount > 0]
    credit = [ledger.accounts[p.account_id].name for p in op.postings if p.amount < 0]
    return f"{', '.join(credit)} → {', '.join(debit)}"


class LedgerPage(Page):
    title = "Livro financeiro"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.filter_text = QLineEdit()
        self.filter_text.setPlaceholderText("Filtrar por descrição…")
        self.filter_text.textChanged.connect(self.refresh)
        self.filter_account = QComboBox()
        self.filter_account.currentIndexChanged.connect(self.refresh)
        self.table = make_table(
            ["Data", "Competência", "Descrição", "Tipo", "Contas (crédito → débito)", "Valor", "Origem", "Situação"]
        )
        top = QHBoxLayout()
        for label, kind in OperationDialog.KINDS.items():
            button = QPushButton(kind)
            button.clicked.connect(lambda _=False, k=label: self.new_operation(k))
            top.addWidget(button)
        top.addStretch()
        actions = QHBoxLayout()
        for label, slot in (
            ("Corrigir descrição", self.correct),
            ("Estornar", self.reverse),
            ("Cancelar lançamento", self.cancel),
            ("Histórico", self.show_history),
        ):
            button = QPushButton(label)
            button.clicked.connect(slot)
            actions.addWidget(button)
        actions.addStretch()
        actions.addWidget(self.filter_account)
        actions.addWidget(self.filter_text)
        layout = QVBoxLayout(self)
        layout.addLayout(top)
        layout.addLayout(actions)
        layout.addWidget(self.table)

    def refresh(self) -> None:
        if self.session is None:
            self.table.setRowCount(0)
            return
        ledger = self.session.ledger
        current = self.filter_account.currentData()
        self.filter_account.blockSignals(True)
        fill_combo(
            self.filter_account,
            [
                (a.name, a.id)
                for a in sorted(ledger.accounts.values(), key=lambda a: a.name)
                if a.type in (AccountType.ASSET, AccountType.LIABILITY)
            ],
            empty="Todas as contas",
        )
        index = self.filter_account.findData(current)
        self.filter_account.setCurrentIndex(max(index, 0))
        self.filter_account.blockSignals(False)
        account_filter = self.filter_account.currentData()
        text = self.filter_text.text().strip().casefold()
        rows = []
        ops = sorted(ledger.operations.values(), key=lambda o: o.cash_date or o.occurred_on or date.min, reverse=True)
        for op in ops:
            if text and text not in op.description.casefold():
                continue
            if account_filter is not None and all(p.account_id != account_filter for p in op.postings):
                continue
            rows.append(
                (
                    [
                        fmt_date(op.occurred_on or op.cash_date),
                        str(op.competence) if op.competence else "—",
                        op.description,
                        KIND_LABELS.get(op.kind, op.kind.value),
                        operation_accounts(ledger, op),
                        operation_amount(op),
                        ORIGIN_LABELS[op.origin.kind],
                        "Ativo" if op.active else "Cancelado",
                    ],
                    op.id,
                )
            )
        set_rows(self.table, rows)

    def new_operation(self, kind: str) -> None:
        if self.session is None:
            return
        dialog = OperationDialog(self, self.session.ledger, kind)
        if dialog.exec() and run_guarded(self, lambda: dialog.apply() or True):
            self.changed()

    def _selected(self) -> Operation | None:
        op_id = selected_id(self.table)
        if self.session is None or op_id is None:
            return None
        return self.session.ledger.operations.get(op_id)

    def correct(self) -> None:
        op = self._selected()
        if op is None or self.session is None:
            return
        from PySide6.QtWidgets import QInputDialog

        text, ok = QInputDialog.getText(self, "Corrigir descrição", "Nova descrição:", text=op.description)
        if not ok:
            return
        reason = ask_reason(self, "Corrigir descrição")
        ledger = self.session.ledger
        if reason and run_guarded(
            self, lambda: ledger.update_operation(op.model_copy(update={"description": text}), reason)
        ):
            self.changed()

    def reverse(self) -> None:
        op = self._selected()
        if op is None or self.session is None:
            return
        reason = ask_reason(self, "Estornar lançamento")
        ledger = self.session.ledger
        if reason and run_guarded(self, lambda: ledger.reverse_operation(op.id, date.today(), reason)):
            self.changed()

    def cancel(self) -> None:
        op = self._selected()
        if op is None or self.session is None:
            return
        reason = ask_reason(self, "Cancelar lançamento")
        ledger = self.session.ledger
        if reason and run_guarded(self, lambda: ledger.cancel_operation(op.id, reason)):
            self.changed()

    def show_history(self) -> None:
        op = self._selected()
        if op is None or self.session is None:
            return
        lines = [
            f"{h.at:%d/%m/%Y %H:%M} · v{h.version} · {h.action.value} · {h.operator or 'operador não informado'}"
            + (f" · motivo: {h.reason}" if h.reason else "")
            for h in self.session.ledger.history_of(op.id)
        ]
        QMessageBox.information(self, "Histórico", "\n".join(lines) or "Sem histórico.")
