"""Contas e cartões: members, accounts, cards, bills, loans, categories and rules (RF-03, RF-04).

Tabs separate different objects; within a tab, a chart and the table of its values sit
together in collapsible sections. The richer tabs are widgets of their own (`PageTab`); the
three plain lists (cards, categories, members) live here.
"""

from collections.abc import Callable, Sequence
from typing import Any

from PySide6.QtWidgets import QTableWidget, QTabWidget, QVBoxLayout, QWidget

from opesvault.domain import queries
from opesvault.domain.model import AccountType
from opesvault.domain.money import ZERO
from opesvault.ui.common import fmt, frameless, make_table, run_guarded, selected_id, set_rows, stretch_column
from opesvault.ui.components import button, hbox
from opesvault.ui.dialogs import ROLE_LABELS, CardDialog, CategoryDialog
from opesvault.ui.pages.accounts.bank import BankAccountsTab
from opesvault.ui.pages.accounts.bills import BillsTab
from opesvault.ui.pages.accounts.ledger_accounts import AccountsTab
from opesvault.ui.pages.accounts.loans import LoansTab
from opesvault.ui.pages.accounts.rules import RulesTab
from opesvault.ui.pages.base import Page
from opesvault.ui.theme import SPACE_L, SPACE_M


class AccountsPage(Page):
    title = "Contas e cartões"
    section = "Cadastros"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.cards = make_table(["Cartão", "Portador", "Final", "Fechamento", "Vencimento", "Fatura em aberto"])
        self.categories = make_table(["Categoria", "Tipo", "Dentro de", "Dedutível"])
        self.members = make_table(["Integrante", "Papel", "Situação"])
        for table, name in ((self.cards, "Cartões"), (self.categories, "Categorias"), (self.members, "Integrantes")):
            table.setAccessibleName(name)
            stretch_column(table)  # names take the slack so amounts sit next to what they belong to
        self.cards.doubleClicked.connect(lambda _: self.edit_card())
        self.members.doubleClicked.connect(lambda _: self.edit_member())

        self.bank_tab = BankAccountsTab(self)
        self.accounts_tab = AccountsTab(self)
        self.bills_tab = BillsTab(self)
        self.loans_tab = LoansTab(self)
        self.rules_tab = RulesTab(self)
        self.tabs = QTabWidget()
        # Most used first: where the money is, then cards and their bills, then the setup lists.
        for widget, label in (
            (self.bank_tab, "Contas bancárias"),
            (self.accounts_tab, "Todas as contas"),
            (_list_tab(self.cards, [("Novo cartão…", self.add_card), ("Editar…", self.edit_card)]), "Cartões"),
            (self.bills_tab, "Faturas"),
            (self.loans_tab, "Financiamentos"),
            (
                _list_tab(
                    self.categories,
                    [("Nova categoria…", self.add_category), ("Dedutível no IR…", self.mark_deductible)],
                ),
                "Categorias",
            ),
            (self.rules_tab, "Regras"),
            (
                _list_tab(self.members, [("Novo integrante…", self.add_member), ("Editar…", self.edit_member)]),
                "Integrantes",
            ),
        ):
            self.tabs.addTab(widget, label)
        layout = self.page_layout()
        layout.addWidget(self.tabs, 1)

    def _tab_widgets(self) -> tuple[Any, ...]:
        return (self.bank_tab, self.accounts_tab, self.bills_tab, self.loans_tab, self.rules_tab)

    def refresh(self) -> None:
        for tab in self._tab_widgets():
            tab.refresh()
        if self.session is None:
            for table in (self.cards, self.categories, self.members):
                table.setRowCount(0)
            self.header.set_subtitle("")
            return
        ledger = self.session.ledger
        names = {m.id: m.name for m in ledger.members.values()}
        balances = queries.balances(ledger)
        set_rows(
            self.members,
            [
                ([m.name, ROLE_LABELS[m.role], "Ativo" if m.active else "Inativo"], m.id)
                for m in ledger.members.values()
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
                        fmt(balances.get(c.liability_account_id, ZERO)),
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
        n_accounts = sum(1 for a in ledger.accounts.values() if a.type in (AccountType.ASSET, AccountType.LIABILITY))
        self.header.set_subtitle(
            f"{n_accounts} contas · {len(ledger.cards)} cartões · {len(ledger.members)} integrantes"
        )

    def reveal(self, ref: object, *, act: bool = False) -> None:
        """(card, month) from a bill alert opens Faturas on that bill and, with `act`, its payment;
        ("loan", plan, installment) opens Financiamentos; ("check", account) the account's checks."""
        match ref:
            case ("loan", plan_id, number):
                self.tabs.setCurrentWidget(self.loans_tab)
                self.loans_tab.show_installment(plan_id, number, pay=act)
            case ("check", account_id):
                self.tabs.setCurrentWidget(self.accounts_tab)
                self.accounts_tab.show_check(account_id)
            case (card_id, month):
                self.tabs.setCurrentWidget(self.bills_tab)
                self.bills_tab.show_bill(card_id, month, pay=act)

    # ── members, cards and categories ───────────────

    def _run(self, dialog: Any, apply: Callable[[], object] | None = None) -> None:
        if dialog.exec() and run_guarded(self, apply or dialog.apply):
            self.changed()

    def add_member(self) -> None:
        from opesvault.ui.dialogs import MemberDialog

        if self.session is not None:
            self._run(MemberDialog(self, self.session.ledger))

    def edit_member(self) -> None:
        from opesvault.ui.dialogs import MemberDialog

        member_id = selected_id(self.members)
        if self.session is not None and member_id is not None:
            self._run(MemberDialog(self, self.session.ledger, self.session.ledger.members[member_id]))

    def add_card(self) -> None:
        if self.session is not None:
            self._run(CardDialog(self, self.session.ledger))

    def edit_card(self) -> None:
        card_id = selected_id(self.cards)
        if self.session is not None and card_id is not None:
            self._run(CardDialog(self, self.session.ledger, self.session.ledger.cards[card_id]))

    def add_category(self) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        dialog = CategoryDialog(self, ledger)
        self._run(dialog, lambda: ledger.add_account(dialog.build()))

    def mark_deductible(self) -> None:
        category_id = selected_id(self.categories)
        if self.session is None or category_id is None:
            return
        ledger = self.session.ledger
        if ledger.account(category_id).type is not AccountType.EXPENSE:
            self.notify("Só categorias de despesa podem ser dedutíveis.")
            return
        from opesvault.ui.planning_dialogs import DeductibleDialog

        self._run(DeductibleDialog(self, ledger, category_id))


def _list_tab(table: QTableWidget, buttons: Sequence[tuple[str, Callable[[], None]]]) -> QWidget:
    """A plain list with its commands above it."""
    box = QWidget()
    layout = QVBoxLayout(box)
    layout.setContentsMargins(0, SPACE_L, 0, 0)
    layout.setSpacing(SPACE_M)
    layout.addLayout(hbox(*(button(label, slot) for label, slot in buttons), None))
    layout.addWidget(frameless(table), 1)
    return box


def deductible_label(ledger: Any, account: Any) -> str:
    if account.type is not AccountType.EXPENSE:
        return ""
    from opesvault.domain.deductibles import KIND_LABELS, kind_of

    kind = kind_of(ledger, account.id)
    return KIND_LABELS[kind] if kind is not None else ""
