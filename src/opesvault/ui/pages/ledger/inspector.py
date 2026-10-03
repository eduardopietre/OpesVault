"""Details of the selected operation, beside the table instead of in a dialog."""

from typing import Any

from PySide6.QtWidgets import QScrollArea, QVBoxLayout, QWidget

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import Operation
from opesvault.ui.common import fmt, fmt_date, month_label
from opesvault.ui.components import button, hbox, separator, text
from opesvault.ui.pages.ledger.model import KIND_LABELS, ORIGIN_LABELS, operation_amount
from opesvault.ui.theme import SPACE_M, SPACE_S


def _pair(label: str, value: str) -> QWidget:
    widget = QWidget()
    widget.setLayout(hbox(text(label, "secondary"), None, text(value)))
    return widget


class OperationInspector(QScrollArea):
    """Details of the selected operation, kept beside the table instead of in a dialog."""

    def __init__(self) -> None:
        super().__init__()
        self.setWidgetResizable(True)
        self.setFrameShape(QScrollArea.Shape.NoFrame)
        self.setMinimumWidth(240)
        body = QWidget()
        body.setObjectName("Surface")
        self.body = QVBoxLayout(body)
        self.body.setContentsMargins(SPACE_M, 0, 0, 0)
        self.body.setSpacing(SPACE_S)
        self.setWidget(body)
        self.setAccessibleName("Detalhes do lançamento")
        self.open_document: Any = None  # set by the page: opens a receipt in Documentos

    def _clear(self) -> None:
        while self.body.count():
            item = self.body.takeAt(0)
            widget = item.widget() if item is not None else None
            if widget is not None:
                widget.deleteLater()

    def show_operation(self, ledger: Ledger | None, op: Operation | None, selected: int) -> None:
        self._clear()
        add = self.body.addWidget
        if ledger is None or op is None:
            message = "Nenhum lançamento selecionado" if selected == 0 else f"{selected} lançamentos selecionados"
            add(text(message, "secondary", wrap=True))
            if selected > 1:
                add(text("Use Ações › Reclassificar para mudar a categoria de todos.", "caption", wrap=True))
            self.body.addStretch(1)
            return
        add(text(op.description, "headline", wrap=True))
        status = "Ativo" if op.active else "Cancelado"
        kind = KIND_LABELS.get(op.kind, op.kind.value)
        add(text(f"{kind} · {status} · {ORIGIN_LABELS[op.origin.kind]}", "secondary", wrap=True))
        add(text(operation_amount(op), "figure"))
        add(separator())
        member = ledger.members.get(op.member_id) if op.member_id else None
        for label, value in (
            ("Ocorrência", fmt_date(op.occurred_on)),
            ("Lançamento", fmt_date(op.booked_on)),
            ("Liquidação", fmt_date(op.settled_on)),
            ("Vencimento", fmt_date(op.due_on)),
            ("Competência", month_label(op.competence) if op.competence else "—"),
            ("Responsável", member.name if member else "Projeto"),
        ):
            add(_pair(label, value))
        add(separator())
        add(text("Partidas", "headline"))
        for posting in op.postings:
            account = ledger.accounts.get(posting.account_id)
            side = "débito" if posting.amount > 0 else "crédito"
            share = ledger.members.get(posting.member_id) if posting.member_id else None
            detail = f"{side} · {share.name}" if share else side
            add(_pair(account.name if account else "?", f"{fmt(abs(posting.amount))} ({detail})"))
        from opesvault.domain import sharing
        from opesvault.domain.tags import tags_of

        tags = tags_of(ledger, op.id)
        if tags:
            add(_pair("Marcadores", ", ".join(tags)))
        from opesvault.domain.merchants import merchant_of

        add(_pair("Estabelecimento", merchant_of(ledger, op.description)))
        from opesvault.domain.anomalies import of_operation

        for suspicion in of_operation(ledger, op.id):
            warning = text(f"{suspicion.title}: {suspicion.detail}", "caption", wrap=True)
            warning.setProperty("tone", "warning")
            add(warning)
        from opesvault.domain.attachments import of_operation as receipts

        found = receipts(ledger, op.id)
        if found and self.open_document is not None:
            add(text("Comprovantes", "strong"))
            for receipt in found:
                add(button("Abrir comprovante", lambda d=receipt.document_id: self.open_document(d), role="plain"))
        for item in sharing.reimbursements(ledger).values():
            if item.operation_id == op.id:
                state = sharing.STATE_LABELS[sharing.state(ledger, item)]
                add(_pair("Reembolso", f"{item.payer} · {fmt(item.expected)} · {state}"))
        if op.notes:
            add(separator())
            add(text("Observações", "headline"))
            add(text(op.notes, wrap=True))
        history = ledger.history_of(op.id)
        if history:
            add(separator())
            add(text("Histórico", "headline"))
            for entry in history[-5:]:
                who = entry.operator or "operador não informado"
                add(text(f"{entry.at:%d/%m/%Y %H:%M} · v{entry.version} · {who}", "caption", wrap=True))
                if entry.reason:
                    add(text(f"Motivo: {entry.reason}", wrap=True))
        self.body.addStretch(1)
