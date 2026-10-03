"""Members, accounts, cards, loans and categories (RF-03, RF-04).

Tabs separate different objects (accounts, cards, bills, loans, categories…); within a
tab, a chart and the table of its values sit together in collapsible sections.
"""

from datetime import date
from typing import Any

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QComboBox, QTabWidget, QVBoxLayout, QWidget

from opesvault.domain import queries
from opesvault.domain.model import AccountType, YearMonth
from opesvault.ui.common import (
    fit_to_rows,
    fmt,
    fmt_date,
    frameless,
    make_table,
    run_guarded,
    selected_id,
    set_rows,
    stretch_column,
    summary_table,
)
from opesvault.ui.components import Collapsible, Figures, button, hbox, menu_button, scroll_body, text
from opesvault.ui.dialogs import ROLE_LABELS, SUBTYPE_LABELS, AccountDialog, CardDialog, CategoryDialog
from opesvault.ui.pages.base import Page
from opesvault.ui.theme import SPACE_L, SPACE_M

HISTORY_MONTHS = 12


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
        self.accounts = make_table(["Conta", "Tipo", "Instituição", "Titulares", "Saldo", "Conferido com o banco"])
        self.cards = make_table(["Cartão", "Portador", "Final", "Fechamento", "Vencimento", "Fatura em aberto"])
        self.categories = make_table(["Categoria", "Tipo", "Dentro de", "Dedutível"])
        for table, name in (
            (self.members, "Integrantes"),
            (self.accounts, "Contas"),
            (self.cards, "Cartões"),
            (self.categories, "Categorias"),
        ):
            table.setAccessibleName(name)
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
        tabs.addTab(self._accounts_tab(), "Contas")
        tabs.addTab(
            self._with_buttons(self.cards, [("Novo cartão…", self.add_card), ("Editar…", self.edit_card)]), "Cartões"
        )
        self.bills.setAccessibleName("Faturas do cartão")
        self.pay_button = button(
            "Pagar…", self.pay_bill, role="primary", tip="Registra o pagamento da fatura selecionada"
        )
        self.bills.itemSelectionChanged.connect(self._bill_selected)
        self.bills.doubleClicked.connect(lambda _: self.pay_bill())
        bills_box = self._with_buttons(self.bills, [], lead=[text("Cartão", "secondary"), self.bill_card])
        bills_box.layout().itemAt(0).layout().insertWidget(2, self.pay_button)  # type: ignore[union-attr]
        # The bills over time above the table of bills: the same numbers, read as a trend.
        from opesvault.charts.render import ChartWidget

        self.bills_chart = ChartWidget()
        self.bills_chart.setFixedHeight(240)
        self.bills_chart.setAccessibleName("Gráfico das faturas")
        self.bills_chart_section = Collapsible("Faturas mês a mês", "contas/faturas_grafico")
        self.bills_chart_section.add(self.bills_chart)
        bills_box.layout().insertWidget(1, self.bills_chart_section)  # type: ignore[union-attr]
        self.bills_tab = tabs.addTab(bills_box, "Faturas")
        self.loans_tab = tabs.addTab(self._loans_tab(), "Financiamentos")
        tabs.addTab(
            self._with_buttons(
                self.categories,
                [("Nova categoria…", self.add_category), ("Dedutível no IR…", self.mark_deductible)],
            ),
            "Categorias",
        )
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

    def _accounts_tab(self) -> QWidget:
        """Accounts, then the selected account's balance over time and its checks with the bank."""
        from opesvault.ui.chart_panel import ChartPanel

        self.accounts.setSortingEnabled(False)
        self.accounts.setProperty("maxRows", 10)
        self.accounts.itemSelectionChanged.connect(self._account_selected)
        self.history = ChartPanel(
            "contas/saldo", chart_title="Saldo no fim de cada mês", table_title="Saldos mês a mês", chart_height=240
        )
        self.checks = summary_table(["Data", "Banco", "Aplicativo", "Diferença", "Observação"], max_rows=6)
        self.checks.setAccessibleName("Conferências com o banco")
        stretch_column(self.checks, 4)
        self.checks_section = Collapsible(
            "Conferências com o banco",
            "contas/conferencias",
            caption="Saldo informado a partir do extrato, comparado ao saldo do aplicativo na mesma data. "
            "Uma diferença indica lançamento faltando ou errado; nada é ajustado sozinho.",
        )
        self.checks_section.add_actions(
            button("Conferir saldo…", self.check_balance),
            button("Ver lançamentos", self._open_account_ledger, role="plain"),
        )
        self.checks_section.add(self.checks)
        self.history_title = text("", "headline")
        box = QWidget()
        layout = QVBoxLayout(box)
        layout.setContentsMargins(0, SPACE_L, 0, 0)
        layout.setSpacing(SPACE_M)
        layout.addLayout(
            hbox(
                button("Nova conta…", self.add_account),
                button("Editar…", self.edit_account),
                button("Conferir saldo…", self.check_balance),
                None,
            )
        )
        scroll, content = scroll_body()
        content.setSpacing(SPACE_L)
        content.addWidget(frameless(self.accounts))
        content.addWidget(self.history_title)
        content.addWidget(self.history)
        content.addWidget(self.checks_section)
        content.addStretch(1)
        layout.addWidget(scroll, 1)
        return box

    def _loans_tab(self) -> QWidget:
        """Loans and financing: the contract, its schedule and what is left to pay."""
        from opesvault.charts.render import ChartWidget

        self.loans = summary_table(
            ["Financiamento", "Sistema", "Taxa", "Parcelas pagas", "Próxima", "Saldo devedor", "No livro"], max_rows=6
        )
        self.loans.setAccessibleName("Financiamentos")
        stretch_column(self.loans)
        self.loans.itemSelectionChanged.connect(self._refresh_loan_detail)
        self.loan_figures = Figures(["Saldo devedor", "Juros a pagar", "Parcelas vencidas", "Termina em"])
        self.loan_chart = ChartWidget()
        self.loan_chart.setFixedHeight(260)
        self.loan_chart.setAccessibleName("Gráfico do financiamento")
        chart_section = Collapsible("Saldo devedor, juros e amortização", "contas/financiamento_grafico")
        chart_section.add(self.loan_chart)
        self.schedule = summary_table(
            ["Nº", "Vencimento", "Parcela", "Amortização", "Juros", "Seguros e tarifas", "Saldo após", "Situação"],
            max_rows=14,
        )
        self.schedule.setAccessibleName("Cronograma de parcelas")
        self.schedule.doubleClicked.connect(lambda _: self.pay_installment())
        schedule_section = Collapsible("Cronograma", "contas/financiamento_cronograma")
        schedule_section.add_actions(button("Pagar parcela…", self.pay_installment))
        schedule_section.add(self.schedule)
        self.loan_empty = text(
            "Nenhum financiamento. Cadastre o contrato para acompanhar parcelas, juros e o saldo devedor, "
            "e simular amortizações antecipadas.",
            "secondary",
            wrap=True,
        )
        box = QWidget()
        layout = QVBoxLayout(box)
        layout.setContentsMargins(0, SPACE_L, 0, 0)
        layout.setSpacing(SPACE_M)
        layout.addLayout(
            hbox(
                button("Novo financiamento…", self.add_loan),
                button("Pagar parcela…", self.pay_installment),
                menu_button(
                    "Mais",
                    [
                        ("Simular ou registrar amortização antecipada…", self.prepay_loan),
                        ("Ver lançamentos do financiamento", self._open_loan_ledger),
                    ],
                ),
                None,
            )
        )
        scroll, content = scroll_body()
        content.setSpacing(SPACE_L)
        content.addWidget(self.loan_empty)
        content.addWidget(self.loans)
        content.addWidget(self.loan_figures)
        content.addWidget(chart_section)
        content.addWidget(schedule_section)
        content.addStretch(1)
        layout.addWidget(scroll, 1)
        self._loan_detail = (self.loan_figures, chart_section, schedule_section)
        return box

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
            tables = (self.members, self.accounts, self.cards, self.categories, self.rules, self.bills, self.checks)
            for table in (*tables, self.loans, self.schedule):
                table.setRowCount(0)
            self.history.clear()
            self.bills_chart.clear()
            self.loan_chart.clear()
            self.bill_card.clear()
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
        from opesvault.domain.balance_checks import latest

        checked = latest(ledger)

        def check_label(account_id: Any) -> str:
            result = checked.get(account_id)
            if result is None:
                return "nunca"
            when = fmt_date(result.check.on)
            return f"{when}: confere" if result.matches else f"{when}: diferença de {fmt(result.difference)}"

        selected_account = selected_id(self.accounts)
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
                        check_label(a.id),
                    ],
                    a.id,
                )
                for a in sorted(ledger.accounts.values(), key=lambda a: a.name)
                if a.type in (AccountType.ASSET, AccountType.LIABILITY)
            ],
        )
        fit_to_rows(self.accounts)
        self._select_row(self.accounts, selected_account)
        if selected_id(self.accounts) is None and self.accounts.rowCount():
            self.accounts.selectRow(0)
        self._account_selected()
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
                        deductible_label(ledger, a),
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
        self._refresh_loans()

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
        from opesvault.charts.data import card_bills_history

        shown = [m for m in months if m in self._bills]
        if shown:
            self.bills_chart.show_chart(card_bills_history(ledger, card_id, shown))
        self.bills_chart_section.setVisible(bool(shown))

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
        """A bill alert: open Faturas on that card, select the bill and, if asked, pay it.

        Also ("loan", plan, installment) for a loan installment and ("check", account) for a
        balance that differs from the bank.
        """
        if isinstance(ref, tuple) and len(ref) == 3 and ref[0] == "loan":
            self.tabs.setCurrentIndex(self.loans_tab)
            self._select_row(self.loans, ref[1])
            self._refresh_loan_detail()
            self._select_row(self.schedule, ref[2])
            if act:
                self.pay_installment()
            return
        if isinstance(ref, tuple) and len(ref) == 2 and ref[0] == "check":
            self.tabs.setCurrentIndex(0)
            self._select_row(self.accounts, ref[1])
            self.checks_section.set_expanded(True)
            return
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

    # ── account history and bank checks ─────────────

    @staticmethod
    def _select_row(table: Any, value: object) -> None:
        if value is None:
            return
        for row in range(table.rowCount()):
            item = table.item(row, 0)
            if item is not None and item.data(Qt.ItemDataRole.UserRole) == value:
                table.selectRow(row)
                return

    def _account_selected(self) -> None:
        account_id = selected_id(self.accounts)
        visible = self.session is not None and account_id is not None
        for widget in (self.history, self.history_title, self.checks_section):
            widget.setVisible(visible)
        if self.session is None or account_id is None:
            self.history.clear()
            self.checks.setRowCount(0)
            return
        from opesvault.charts.data import account_balance_history
        from opesvault.domain.balance_checks import results

        ledger = self.session.ledger
        end = YearMonth.of(date.today())
        self.history_title.setText(ledger.account(account_id).name)
        self.history.show_chart(account_balance_history(ledger, account_id, end.add(-(HISTORY_MONTHS - 1)), end))
        set_rows(
            self.checks,
            [
                (
                    [
                        fmt_date(r.check.on),
                        fmt(r.check.informed),
                        fmt(r.computed),
                        "confere" if r.matches else fmt(r.difference),
                        r.check.note or "",
                    ],
                    r.check.id,
                )
                for r in results(ledger, account_id)
            ],
        )
        fit_to_rows(self.checks)

    def check_balance(self) -> None:
        account_id = selected_id(self.accounts)
        if self.session is None or account_id is None:
            return
        from opesvault.ui.planning_dialogs import BalanceCheckDialog

        dialog = BalanceCheckDialog(self, self.session.ledger, account_id)
        if dialog.exec():
            result = run_guarded(self, dialog.apply)
            if result:
                from opesvault.domain.balance_checks import results

                latest = next((r for r in results(self.session.ledger, account_id) if r.check.id == result.id), None)
                if latest is not None and latest.matches:
                    self.notify("Saldo conferido: confere com o banco.")
                elif latest is not None:
                    self.notify(f"Saldo conferido: diferença de {fmt(latest.difference)}. Procure o lançamento.")
                self.changed()

    def _open_account_ledger(self) -> None:
        account_id = selected_id(self.accounts)
        if account_id is not None:
            self.navigate("ledger", ("filter", account_id, None))

    # ── loans ───────────────────────────────────────

    def _refresh_loans(self) -> None:
        if self.session is None:
            self.loans.setRowCount(0)
            return
        from opesvault.domain.loans import SYSTEM_LABELS, plans, status
        from opesvault.ui.planning_dialogs import rate_label

        ledger = self.session.ledger
        selected = selected_id(self.loans)
        rows = []
        for plan in sorted(plans(ledger).values(), key=lambda p: p.name.casefold()):
            current = status(ledger, plan.id)
            following = current.next_due
            rows.append(
                (
                    [
                        plan.name,
                        SYSTEM_LABELS[plan.system].split(" (")[0],
                        rate_label(plan.monthly_rate),
                        f"{current.paid} de {len(current.installments)}",
                        f"{fmt_date(following.due)} · {fmt(following.payment)}" if following else "quitado",
                        fmt(current.outstanding),
                        fmt(current.ledger_balance),
                    ],
                    plan.id,
                )
            )
        set_rows(self.loans, rows)
        fit_to_rows(self.loans)
        self.loans.setVisible(bool(rows))
        self.loan_empty.setVisible(not rows)
        self._select_row(self.loans, selected)
        if rows and selected_id(self.loans) is None:
            self.loans.selectRow(0)
        self._refresh_loan_detail()

    def _refresh_loan_detail(self) -> None:
        plan_id = selected_id(self.loans)
        for widget in self._loan_detail:
            widget.setVisible(plan_id is not None and self.session is not None)
        if plan_id is None or self.session is None:
            self.schedule.setRowCount(0)
            self.loan_chart.clear()
            return
        from opesvault.charts.data import loan_chart
        from opesvault.domain.loans import STATE_LABELS, InstallmentState, state_of, status

        ledger = self.session.ledger
        today = date.today()
        current = status(ledger, plan_id, today)
        self.loan_figures.set("Saldo devedor", fmt(current.outstanding))
        self.loan_figures.set("Juros a pagar", fmt(current.interest_to_come))
        self.loan_figures.set("Parcelas vencidas", str(current.overdue), "negative" if current.overdue else None)
        self.loan_figures.set("Termina em", fmt_date(current.end))
        self.loan_chart.show_chart(loan_chart(ledger, plan_id))
        selected = selected_id(self.schedule)
        rows = []
        for item in current.installments:
            state = state_of(ledger, plan_id, item, today)
            label = STATE_LABELS[state]
            if item.prepaid_after:
                label += f" · amortização antecipada de {fmt(item.prepaid_after)}"
            rows.append(
                (
                    [
                        str(item.number),
                        fmt_date(item.due),
                        fmt(item.payment),
                        fmt(item.amortization),
                        fmt(item.interest),
                        fmt(item.fees),
                        fmt(item.balance_after),
                        label,
                    ],
                    item.number,
                )
            )
        set_rows(self.schedule, rows)
        fit_to_rows(self.schedule)
        self._select_row(self.schedule, selected)
        if selected_id(self.schedule) is None:
            following = next(
                (i for i in current.installments if state_of(ledger, plan_id, i, today) is not InstallmentState.PAID),
                None,
            )
            if following is not None:
                self._select_row(self.schedule, following.number)
                current = self.schedule.item(self.schedule.currentRow(), 0)
                if current is not None:
                    self.schedule.scrollToItem(current)

    def add_loan(self) -> None:
        if self.session is None:
            return
        from opesvault.ui.planning_dialogs import LoanDialog

        dialog = LoanDialog(self, self.session.ledger)
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.notify("Financiamento criado. O cronograma foi calculado pelo contrato.")
            self.changed()

    def pay_installment(self) -> None:
        plan_id = selected_id(self.loans)
        number = selected_id(self.schedule)
        if self.session is None or plan_id is None or number is None:
            return
        from opesvault.domain.loans import paid_numbers, plan_schedule, plans
        from opesvault.ui.planning_dialogs import PayInstallmentDialog

        ledger = self.session.ledger
        if number in paid_numbers(ledger, plan_id):
            self.notify("Esta parcela já está paga.")
            return
        item = next((i for i in plan_schedule(ledger, plan_id) if i.number == number), None)
        if item is None:
            return
        dialog = PayInstallmentDialog(self, ledger, plans(ledger)[plan_id], item)
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.notify(f"Parcela {number} registrada: amortização, juros e encargos separados.")
            self.changed()

    def prepay_loan(self) -> None:
        plan_id = selected_id(self.loans)
        if self.session is None or plan_id is None:
            return
        from opesvault.domain.loans import plans
        from opesvault.ui.planning_dialogs import PrepaymentDialog

        ledger = self.session.ledger
        dialog = PrepaymentDialog(self, ledger, plans(ledger)[plan_id])
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.notify("Amortização antecipada registrada; o cronograma foi recalculado.")
            self.changed()

    def _open_loan_ledger(self) -> None:
        plan_id = selected_id(self.loans)
        if self.session is None or plan_id is None:
            return
        from opesvault.domain.loans import plans

        self.navigate("ledger", ("filter", plans(self.session.ledger)[plan_id].liability_account_id, None))

    # ── deductible categories ───────────────────────

    def mark_deductible(self) -> None:
        category_id = selected_id(self.categories)
        if self.session is None or category_id is None:
            return
        ledger = self.session.ledger
        if ledger.account(category_id).type is not AccountType.EXPENSE:
            self.notify("Só categorias de despesa podem ser dedutíveis.")
            return
        from opesvault.ui.planning_dialogs import DeductibleDialog

        dialog = DeductibleDialog(self, ledger, category_id)
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.changed()


def deductible_label(ledger: Any, account: Any) -> str:
    if account.type is not AccountType.EXPENSE:
        return ""
    from opesvault.domain.deductibles import KIND_LABELS, kind_of

    kind = kind_of(ledger, account.id)
    return KIND_LABELS[kind] if kind is not None else ""
