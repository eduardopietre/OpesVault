"""Reembolsos e acertos: money others will pay back, and who owes whom inside the family
(docs/09 §1.3 E)."""

from typing import Any
from uuid import UUID

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QStackedWidget

from opesvault.domain import sharing
from opesvault.domain.money import ZERO
from opesvault.ui.common import (
    fit_to_rows,
    fmt,
    fmt_date,
    run_guarded,
    selected_id,
    set_rows,
    stretch_column,
    summary_table,
)
from opesvault.ui.components import Collapsible, EmptyState, Figures, button, scroll_body, text
from opesvault.ui.dialogs import ask_reason
from opesvault.ui.pages.base import Page
from opesvault.ui.theme import SPACE_L


class SharingPage(Page):
    title = "Reembolsos e acertos"
    section = "Acompanhamento"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.figures = Figures(["A receber de reembolsos", "Acertos pendentes na família"])
        self.reimbursements = summary_table(
            ["Data", "Lançamento", "Quem reembolsa", "Esperado", "Recebido", "Situação"], max_rows=10
        )
        self.reimbursements.setAccessibleName("Reembolsos")
        stretch_column(self.reimbursements, 1)
        self.reimbursements.doubleClicked.connect(lambda _: self.receive())
        self.reimbursements_section = Collapsible(
            "Reembolsos",
            "acertos/reembolsos",
            caption="Despesas que outra pessoa ou empresa vai devolver (plano de saúde, empresa). "
            "Marque no Livro financeiro: Ações › Reembolso a receber. O valor recebido entra como estorno "
            "das mesmas categorias, no mês do recebimento.",
        )
        self.reimbursements_section.add_actions(
            button("Registrar recebimento…", self.receive),
            button("Negado…", self.deny, role="plain"),
            button("Ver lançamento", self.open_reimbursed, role="plain"),
        )
        self.reimbursements_section.add(self.reimbursements)

        self.balances = summary_table(["Quem deve", "Para quem", "Valor", "Já acertado"], max_rows=8)
        self.balances.setAccessibleName("Saldos entre integrantes")
        stretch_column(self.balances, 0)
        self.balances.itemSelectionChanged.connect(self._show_shares)
        self.shares = summary_table(["Data", "Lançamento", "Parte devida"], max_rows=10)
        self.shares.setAccessibleName("Despesas que formam o saldo")
        stretch_column(self.shares, 1)
        self.balances_section = Collapsible(
            "Acertos entre integrantes",
            "acertos/integrantes",
            caption="Numa despesa com rateio, quem pagou adiantou a parte dos outros. Paga quem é o único titular "
            "da conta de onde saiu o dinheiro, ou o titular do cartão; conta conjunta não gera dívida entre "
            "integrantes. Registrar o acerto não movimenta dinheiro.",
        )
        self.balances_section.add_actions(button("Registrar acerto…", self.settle))
        self.balances_section.add(self.balances)
        self.balances_section.add(text("Despesas que formam o saldo selecionado", "strong"))
        self.balances_section.add(self.shares)
        self.history = summary_table(["Data", "Quem pagou", "Para quem", "Valor", "Observação"], max_rows=8)
        self.history.setAccessibleName("Acertos registrados")
        stretch_column(self.history, 4)
        self.history_section = Collapsible("Acertos registrados", "acertos/historico")
        self.history_section.add(self.history)
        self.empty = EmptyState(
            "Nada a receber nem a acertar",
            "Marque uma despesa como reembolsável no Livro financeiro (Ações › Reembolso a receber) ou ratear "
            "despesas entre integrantes para ver aqui quem deve a quem.",
        )
        self._balances: list[sharing.Balance] = []
        scroll, content = scroll_body()
        content.setSpacing(SPACE_L)
        content.addWidget(self.figures)
        content.addWidget(self.reimbursements_section)
        content.addWidget(self.balances_section)
        content.addWidget(self.history_section)
        content.addStretch(1)
        self.views = QStackedWidget()
        self.views.addWidget(scroll)
        self.views.addWidget(self.empty)
        layout = self.page_layout()
        layout.addWidget(self.views, 1)

    def _name(self, member_id: UUID | None) -> str:
        assert self.session is not None
        member = self.session.ledger.members.get(member_id) if member_id else None
        return member.name if member else "?"

    def refresh(self) -> None:
        if self.session is None:
            for table in (self.reimbursements, self.balances, self.shares, self.history):
                table.setRowCount(0)
            return
        ledger = self.session.ledger
        items = sorted(
            sharing.reimbursements(ledger).values(),
            key=lambda r: (
                sharing.state(ledger, r)
                not in (sharing.ReimbursementState.PENDING, sharing.ReimbursementState.PARTIAL),
                str(r.requested_on or ""),
            ),
        )
        rows: list[tuple[list[Any], Any]] = []
        waiting = ZERO
        for item in items:
            op = ledger.operations.get(item.operation_id)
            got = sharing.received(ledger, item)
            state = sharing.state(ledger, item)
            if state in (sharing.ReimbursementState.PENDING, sharing.ReimbursementState.PARTIAL):
                waiting += item.expected - got
            rows.append(
                (
                    [
                        fmt_date(op.occurred_on if op else None),
                        op.description if op else "?",
                        item.payer,
                        fmt(item.expected),
                        fmt(got),
                        sharing.STATE_LABELS[state],
                    ],
                    item.id,
                )
            )
        set_rows(self.reimbursements, rows)
        fit_to_rows(self.reimbursements)
        self.reimbursements_section.setVisible(bool(rows))
        selected = self._selected_pair()
        self._balances = sharing.balances(ledger)
        set_rows(
            self.balances,
            [
                (
                    [self._name(b.debtor_id), self._name(b.creditor_id), fmt(b.amount), fmt(b.settled)],
                    (b.debtor_id, b.creditor_id),
                )
                for b in self._balances
            ],
        )
        fit_to_rows(self.balances)
        if selected is not None:
            for row in range(self.balances.rowCount()):
                cell = self.balances.item(row, 0)
                if cell is not None and cell.data(Qt.ItemDataRole.UserRole) == selected:
                    self.balances.selectRow(row)
        elif self._balances:
            self.balances.selectRow(0)
        self._show_shares()
        records = sorted(sharing.settlements(ledger).values(), key=lambda s: s.on, reverse=True)
        set_rows(
            self.history,
            [
                (
                    [fmt_date(s.on), self._name(s.debtor_id), self._name(s.creditor_id), fmt(s.amount), s.note or ""],
                    s.id,
                )
                for s in records
            ],
        )
        fit_to_rows(self.history)
        self.history_section.setVisible(bool(records))
        owed = sum((b.amount for b in self._balances), ZERO)
        self.figures.set("A receber de reembolsos", fmt(waiting))
        self.figures.set("Acertos pendentes na família", fmt(owed))
        has_shares = bool(self._balances) or bool(sharing.shares(ledger))
        self.balances_section.setVisible(has_shares or bool(records))
        self.views.setCurrentIndex(0 if rows or has_shares or records else 1)
        summary = []
        open_items = sharing.open_items(ledger)
        if open_items:
            summary.append(f"{len(open_items)} reembolso(s) a receber")
        if self._balances:
            summary.append(f"{len(self._balances)} acerto(s) pendente(s)")
        self.header.set_subtitle(" · ".join(summary))

    def _selected_pair(self) -> tuple[UUID, UUID] | None:
        value = selected_id(self.balances)
        return value if isinstance(value, tuple) else None

    def _show_shares(self) -> None:
        pair = self._selected_pair()
        found = next((b for b in self._balances if (b.debtor_id, b.creditor_id) == pair), None)
        rows = [
            ([fmt_date(s.on), s.description, fmt(s.amount)], s.operation_id) for s in (found.shares if found else [])
        ]
        set_rows(self.shares, rows)
        fit_to_rows(self.shares)

    def _selected_reimbursement(self) -> Any:
        item_id = selected_id(self.reimbursements)
        if self.session is None or item_id is None:
            return None
        return sharing.reimbursements(self.session.ledger).get(item_id)

    def receive(self) -> None:
        item = self._selected_reimbursement()
        if item is None or self.session is None:
            return
        from opesvault.ui.planning_dialogs import ReceiveDialog

        dialog = ReceiveDialog(self, self.session.ledger, item)
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.notify("Reembolso recebido: a despesa líquida foi reduzida.")
            self.changed()

    def deny(self) -> None:
        item = self._selected_reimbursement()
        if item is None or self.session is None:
            return
        reason = ask_reason(self, "Reembolso negado")
        ledger = self.session.ledger
        if reason and run_guarded(self, lambda: sharing.deny(ledger, item.id, reason)):
            self.changed()

    def open_reimbursed(self) -> None:
        item = self._selected_reimbursement()
        if item is None or self.session is None:
            return
        op = self.session.ledger.operations.get(item.operation_id)
        if op is not None:
            when = op.occurred_on or op.cash_date
            self.navigate("ledger", ("filter", None, (when, when) if when else None))

    def settle(self) -> None:
        if self.session is None:
            return
        from opesvault.ui.planning_dialogs import SettlementDialog

        pair = self._selected_pair()
        found = next((b for b in self._balances if (b.debtor_id, b.creditor_id) == pair), None)
        dialog = SettlementDialog(
            self,
            self.session.ledger,
            found.debtor_id if found else None,
            found.creditor_id if found else None,
            found.amount if found else None,
        )
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.notify("Acerto registrado.")
            self.changed()
