"""Members, accounts, cards and categories (RF-03, RF-04)."""

from typing import Any

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QComboBox, QTabWidget, QVBoxLayout, QWidget

from opesvault.domain import queries
from opesvault.domain.model import AccountType
from opesvault.ui.common import fmt, frameless, make_table, run_guarded, selected_id, set_rows, stretch_column
from opesvault.ui.components import button, hbox, text
from opesvault.ui.dialogs import ROLE_LABELS, SUBTYPE_LABELS, AccountDialog, CardDialog, CategoryDialog
from opesvault.ui.pages.base import Page
from opesvault.ui.theme import SPACE_L, SPACE_M


class AccountsPage(Page):
    title = "Contas e cartões"
    section = "Cadastros"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        tabs = QTabWidget()
        self.tabs = tabs
        self._bills: dict[Any, Any] = {}  # bill month -> Bill
        self.members = make_table(["Integrante", "Papel", "Situação"])
        self.members.doubleClicked.connect(lambda _: self.edit_member())
        self.accounts = make_table(["Conta", "Tipo", "Instituição", "Titulares", "Saldo"])
        self.cards = make_table(["Cartão", "Portador", "Final", "Fechamento", "Vencimento", "Fatura em aberto"])
        self.categories = make_table(["Categoria", "Tipo", "Dentro de"])
        self.accounts.doubleClicked.connect(lambda _: self.edit_account())
        self.cards.doubleClicked.connect(lambda _: self.edit_card())
        self.bill_card = QComboBox()
        self.bill_card.setAccessibleName("Cartão")
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
        # Names take the slack so amounts sit next to what they belong to.
        for table in (self.accounts, self.cards, self.categories, self.members):
            stretch_column(table)
        # Most used first: where the money is, then cards and their bills, then the setup lists.
        tabs.addTab(
            self._with_buttons(self.accounts, [("Nova conta…", self.add_account), ("Editar…", self.edit_account)]),
            "Contas",
        )
        tabs.addTab(
            self._with_buttons(self.cards, [("Novo cartão…", self.add_card), ("Editar…", self.edit_card)]), "Cartões"
        )
        self.pay_button = button(
            "Pagar…", self.pay_bill, role="primary", tip="Registra o pagamento da fatura selecionada"
        )
        self.bills.itemSelectionChanged.connect(self._bill_selected)
        self.bills.doubleClicked.connect(lambda _: self.pay_bill())
        bills_box = self._with_buttons(self.bills, [], lead=[text("Cartão", "secondary"), self.bill_card])
        bills_box.layout().itemAt(0).layout().insertWidget(2, self.pay_button)  # type: ignore[union-attr]
        self.bills_tab = tabs.addTab(bills_box, "Faturas")
        tabs.addTab(self._with_buttons(self.categories, [("Nova categoria…", self.add_category)]), "Categorias")
        self.rules = make_table(["A descrição contém", "Categoria", "Vale para", "Usos", "Situação"])
        self.rules.setAccessibleName("Regras de categoria")
        stretch_column(self.rules)
        self.rules.doubleClicked.connect(lambda _: self.edit_rule())
        rules_box = self._with_buttons(
            self.rules,
            [("Nova regra…", self.add_rule), ("Editar…", self.edit_rule), ("Ativar ou desativar…", self.toggle_rule)],
        )
        rules_box.layout().insertWidget(  # type: ignore[union-attr]
            0,
            text(
                "Regras sugerem a categoria de itens importados; nada é aprovado sozinho. "
                "Uma regra sua vale mais que o histórico e que as regras padrão; "
                "a escolha feita à mão vale mais que tudo.",
                "caption",
                wrap=True,
            ),
        )
        tabs.addTab(rules_box, "Regras")
        tabs.addTab(
            self._with_buttons(self.members, [("Novo integrante…", self.add_member), ("Editar…", self.edit_member)]),
            "Integrantes",
        )
        layout = self.page_layout()
        layout.addWidget(tabs, 1)

    def _with_buttons(self, table, buttons, lead=()) -> QWidget:  # type: ignore[no-untyped-def]
        box = QWidget()
        layout = QVBoxLayout(box)
        layout.setContentsMargins(0, SPACE_L, 0, 0)
        layout.setSpacing(SPACE_M)
        layout.addLayout(hbox(*lead, *(button(label, slot) for label, slot in buttons), None))
        layout.addWidget(frameless(table), 1)
        return box

    def refresh(self) -> None:
        if self.session is None:
            for table in (self.members, self.accounts, self.cards, self.categories):
                table.setRowCount(0)
            return
        ledger = self.session.ledger
        names = {m.id: m.name for m in ledger.members.values()}
        set_rows(
            self.members,
            [
                ([m.name, ROLE_LABELS[m.role], "Ativo" if m.active else "Inativo"], m.id)
                for m in ledger.members.values()
            ],
        )
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
        self._refresh_rules()
        n_accounts = sum(1 for a in ledger.accounts.values() if a.type in (AccountType.ASSET, AccountType.LIABILITY))
        self.header.set_subtitle(
            f"{n_accounts} contas · {len(ledger.cards)} cartões · {len(ledger.members)} integrantes"
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
            self._bills = {}
            self._bill_selected()
            return
        from datetime import date

        from opesvault.domain.cards import BillStatus, bills
        from opesvault.domain.model import YearMonth
        from opesvault.importing.pipeline import batches

        ledger = self.session.ledger
        today = date.today()
        months = [YearMonth.of(today).add(offset) for offset in range(-6, 7)]
        self._bills = {}
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
            self._bills[bill.cycle.month] = bill
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
                    bill.cycle.month,
                )
            )
        set_rows(self.bills, rows)
        self._bill_selected()

    def _selected_bill(self):  # type: ignore[no-untyped-def]
        month = selected_id(self.bills)
        return self._bills.get(month) if month is not None else None

    def _bill_selected(self) -> None:
        bill = self._selected_bill()
        self.pay_button.setEnabled(bill is not None and bill.remaining > 0)

    def pay_bill(self) -> None:
        """Pays the selected bill: the card, the remaining amount and today come filled in."""
        bill = self._selected_bill()
        card_id = self.bill_card.currentData()
        if self.session is None or bill is None or card_id is None or bill.remaining <= 0:
            return
        from opesvault.ui.dialogs import BillPaymentDialog

        ledger = self.session.ledger
        dialog = BillPaymentDialog(self, ledger, ledger.cards[card_id], bill)
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.notify(f"Pagamento da fatura de {ledger.cards[card_id].name} registrado.")
            self.changed()

    def reveal(self, ref: object, *, act: bool = False) -> None:
        """A bill alert: open Faturas on that card, select the bill and, if asked, pay it."""
        if not (isinstance(ref, tuple) and len(ref) == 2):
            return
        card_id, month = ref
        self.tabs.setCurrentIndex(self.bills_tab)
        for index in range(self.bill_card.count()):
            if self.bill_card.itemData(index) == card_id:
                self.bill_card.setCurrentIndex(index)
                break
        self._refresh_bills()
        for row in range(self.bills.rowCount()):
            item = self.bills.item(row, 0)
            if item is not None and item.data(Qt.ItemDataRole.UserRole) == month:
                self.bills.selectRow(row)
                break
        if act:
            self.pay_bill()

    def add_member(self) -> None:
        if self.session is None:
            return
        from opesvault.ui.dialogs import MemberDialog

        dialog = MemberDialog(self, self.session.ledger)
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.changed()

    def edit_member(self) -> None:
        member_id = selected_id(self.members)
        if self.session is None or member_id is None:
            return
        from opesvault.ui.dialogs import MemberDialog

        dialog = MemberDialog(self, self.session.ledger, self.session.ledger.members[member_id])
        if dialog.exec() and run_guarded(self, dialog.apply):
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

    # ── categorization rules ────────────────────────

    def _refresh_rules(self) -> None:
        from opesvault.importing import rules

        if self.session is None:
            self.rules.setRowCount(0)
            return
        ledger = self.session.ledger
        rows = []
        for rule in sorted(rules.rules(ledger).values(), key=lambda r: (not r.active, r.pattern)):
            target = ledger.accounts.get(rule.target_account_id)
            scope = ledger.accounts.get(rule.account_id) if rule.account_id else None
            rows.append(
                (
                    [
                        rule.pattern,
                        target.name if target else "?",
                        scope.name if scope else "Qualquer conta",
                        str(rules.usage(ledger, rule.id)),
                        "Ativa" if rule.active else "Desativada",
                    ],
                    rule.id,
                )
            )
        set_rows(self.rules, rows)

    def _selected_rule(self):  # type: ignore[no-untyped-def]
        from opesvault.importing import rules

        rule_id = selected_id(self.rules)
        if self.session is None or rule_id is None:
            return None
        return rules.rules(self.session.ledger).get(rule_id)

    def add_rule(self) -> None:
        if self.session is None:
            return
        from opesvault.ui.rule_dialog import RuleDialog

        dialog = RuleDialog(self, self.session.ledger)
        if dialog.exec():
            result = run_guarded(self, dialog.apply)
            if result:
                self.notify(f"Regra criada. {result[1]} item(ns) pendente(s) recategorizado(s).")
                self.changed()

    def edit_rule(self) -> None:
        rule = self._selected_rule()
        if rule is None or self.session is None:
            return
        from opesvault.ui.rule_dialog import RuleDialog

        dialog = RuleDialog(self, self.session.ledger, rule=rule)
        if dialog.exec():
            result = run_guarded(self, dialog.apply)
            if result:
                self.notify("Regra alterada.")
                self.changed()

    def toggle_rule(self) -> None:
        rule = self._selected_rule()
        if rule is None or self.session is None:
            return
        from opesvault.importing import pipeline, rules
        from opesvault.ui.dialogs import ask_reason

        verb = "Desativar" if rule.active else "Ativar"
        reason = ask_reason(self, f"{verb} regra")
        ledger = self.session.ledger
        if reason and run_guarded(self, lambda: rules.set_active(ledger, rule.id, not rule.active, reason)):
            changed = pipeline.apply_rules(ledger)
            self.notify(
                f"Regra {'desativada' if rule.active else 'ativada'}. {changed} item(ns) pendente(s) revisto(s)."
            )
            self.changed()
