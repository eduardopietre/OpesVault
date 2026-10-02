"""Members, accounts, cards and categories (RF-03, RF-04)."""

from PySide6.QtWidgets import QComboBox, QHBoxLayout, QInputDialog, QPushButton, QTabWidget, QVBoxLayout, QWidget

from opesvault.domain import queries
from opesvault.domain.model import AccountType
from opesvault.ui.common import fmt, make_table, run_guarded, selected_id, set_rows
from opesvault.ui.dialogs import SUBTYPE_LABELS, AccountDialog, CardDialog, CategoryDialog
from opesvault.ui.pages.base import Page


class AccountsPage(Page):
    title = "Contas e cartões"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        tabs = QTabWidget()
        self.members = make_table(["Integrante", "Situação"])
        self.accounts = make_table(["Conta", "Tipo", "Instituição", "Titulares", "Saldo"])
        self.cards = make_table(["Cartão", "Portador", "Final", "Fechamento", "Vencimento", "Fatura em aberto"])
        self.categories = make_table(["Categoria", "Tipo", "Dentro de"])
        tabs.addTab(self._with_buttons(self.members, [("Novo integrante", self.add_member)]), "Integrantes")
        tabs.addTab(
            self._with_buttons(self.accounts, [("Nova conta", self.add_account), ("Editar", self.edit_account)]),
            "Contas",
        )
        tabs.addTab(
            self._with_buttons(self.cards, [("Novo cartão", self.add_card), ("Editar", self.edit_card)]), "Cartões"
        )
        tabs.addTab(self._with_buttons(self.categories, [("Nova categoria", self.add_category)]), "Categorias")
        self.bill_card = QComboBox()
        self.bill_card.currentIndexChanged.connect(self._refresh_bills)
        self.bills = make_table(
            [
                "Vencimento",
                "Fechamento",
                "Lançamentos",
                "Parcelas",
                "Créditos",
                "Total",
                "Pago",
                "Saldo",
                "Documento",
                "Situação",
            ]
        )
        bills_box = QWidget()
        bills_layout = QVBoxLayout(bills_box)
        bills_layout.addWidget(self.bill_card)
        bills_layout.addWidget(self.bills)
        tabs.addTab(bills_box, "Faturas")
        layout = QVBoxLayout(self)
        layout.addWidget(tabs)

    def _with_buttons(self, table, buttons) -> QWidget:  # type: ignore[no-untyped-def]
        box = QWidget()
        layout = QVBoxLayout(box)
        row = QHBoxLayout()
        for label, slot in buttons:
            button = QPushButton(label)
            button.clicked.connect(slot)
            row.addWidget(button)
        row.addStretch()
        layout.addLayout(row)
        layout.addWidget(table)
        return box

    def refresh(self) -> None:
        if self.session is None:
            for table in (self.members, self.accounts, self.cards, self.categories):
                table.setRowCount(0)
            return
        ledger = self.session.ledger
        names = {m.id: m.name for m in ledger.members.values()}
        set_rows(self.members, [([m.name, "Ativo" if m.active else "Inativo"], m.id) for m in ledger.members.values()])
        balances = queries.balances(ledger)
        set_rows(
            self.accounts,
            [
                (
                    [
                        a.name,
                        SUBTYPE_LABELS.get(a.subtype, a.subtype.value),
                        a.institution or "",
                        ", ".join(names.get(h, "?") for h in a.holders),
                        fmt(balances.get(a.id)),
                    ],
                    a.id,
                )
                for a in sorted(ledger.accounts.values(), key=lambda a: a.name)
                if a.type in (AccountType.ASSET, AccountType.LIABILITY)
            ],
        )
        set_rows(
            self.cards,
            [
                (
                    [
                        c.name,
                        names.get(c.holder_id, "?"),
                        c.last4,
                        str(c.closing_day),
                        str(c.due_day),
                        fmt(balances.get(c.liability_account_id)),
                    ],
                    c.id,
                )
                for c in ledger.cards.values()
            ],
        )
        set_rows(
            self.categories,
            [
                (
                    [
                        a.name,
                        "Receita" if a.type is AccountType.INCOME else "Despesa",
                        ledger.accounts[a.parent_id].name
                        if a.parent_id is not None and a.parent_id in ledger.accounts
                        else "",
                    ],
                    a.id,
                )
                for kind in (AccountType.EXPENSE, AccountType.INCOME)
                for a in ledger.categories(kind)
            ],
        )
        current = self.bill_card.currentData()
        self.bill_card.blockSignals(True)
        self.bill_card.clear()
        for card in ledger.cards.values():
            self.bill_card.addItem(card.name, card.id)
        index = self.bill_card.findData(current)
        self.bill_card.setCurrentIndex(max(index, 0))
        self.bill_card.blockSignals(False)
        self._refresh_bills()

    def _refresh_bills(self) -> None:
        card_id = self.bill_card.currentData()
        if self.session is None or card_id is None:
            self.bills.setRowCount(0)
            return
        from datetime import date

        from opesvault.domain.cards import BillStatus, bills
        from opesvault.domain.model import YearMonth
        from opesvault.importing.pipeline import batches

        ledger = self.session.ledger
        today = date.today()
        months = [YearMonth.of(today).add(offset) for offset in range(-6, 7)]
        imported = {
            YearMonth.of(b.header.due_on): b.header.total
            for b in batches(ledger).values()
            if b.card_id == card_id and b.header.due_on is not None and b.header.total is not None
        }
        labels = {
            BillStatus.OPEN: "Aberta",
            BillStatus.CLOSED: "Fechada",
            BillStatus.PAID: "Paga",
            BillStatus.PARTIAL: "Paga parcialmente",
            BillStatus.OVERDUE: "Vencida",
        }
        rows = []
        for bill in bills(ledger, card_id, months):
            document_total = imported.get(bill.cycle.month)
            doc_label = "—" if document_total is None else fmt(document_total)
            if document_total is not None and document_total != bill.total:
                doc_label += " (diverge)"
            if bill.total == 0 and bill.payments == 0 and document_total is None:
                continue
            rows.append(
                (
                    [
                        bill.cycle.due.strftime("%d/%m/%Y"),
                        bill.cycle.closing.strftime("%d/%m/%Y"),
                        fmt(bill.charges),
                        fmt(bill.installments),
                        fmt(bill.credits),
                        fmt(bill.total),
                        fmt(bill.payments),
                        fmt(bill.remaining),
                        doc_label,
                        labels[bill.status(today)],
                    ],
                    None,
                )
            )
        set_rows(self.bills, rows)

    def add_member(self) -> None:
        if self.session is None:
            return
        name, ok = QInputDialog.getText(self, "Novo integrante", "Nome:")
        if ok and run_guarded(self, lambda: self.session.ledger.add_member(name)):  # type: ignore[union-attr]
            self.changed()

    def add_account(self) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        dialog = AccountDialog(self, ledger)
        if dialog.exec():

            def apply() -> object:
                account = ledger.add_account(dialog.build())
                opening = dialog.opening_balance()
                if opening is not None:
                    ledger.record_opening_balance(account.id, opening[0], opening[1])
                return account

            if run_guarded(self, apply):
                self.changed()

    def edit_account(self) -> None:
        account_id = selected_id(self.accounts)
        if self.session is None or account_id is None:
            return
        ledger = self.session.ledger
        dialog = AccountDialog(self, ledger, ledger.accounts[account_id])
        if dialog.exec() and run_guarded(self, lambda: ledger.update_account(dialog.build(), "Edição do cadastro")):
            self.changed()

    def add_card(self) -> None:
        if self.session is None:
            return
        dialog = CardDialog(self, self.session.ledger)
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.changed()

    def edit_card(self) -> None:
        card_id = selected_id(self.cards)
        if self.session is None or card_id is None:
            return
        dialog = CardDialog(self, self.session.ledger, self.session.ledger.cards[card_id])
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.changed()

    def add_category(self) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        dialog = CategoryDialog(self, ledger)
        if dialog.exec() and run_guarded(self, lambda: ledger.add_account(dialog.build())):
            self.changed()
