"""Todas as contas: every account and card liability with its balance, then the selected
account's balance over time and its checks against the bank statement."""

from datetime import date
from typing import TYPE_CHECKING, Any

from opesvault.domain import queries
from opesvault.domain.model import AccountType, YearMonth
from opesvault.domain.money import ZERO
from opesvault.ui.common import (
    fit_to_rows,
    fmt,
    fmt_date,
    frameless,
    make_table,
    run_guarded,
    select_id,
    selected_id,
    set_rows,
    stretch_column,
    summary_table,
)
from opesvault.ui.components import Collapsible, ElidedLabel, button, hbox, scroll_body
from opesvault.ui.dialogs import SUBTYPE_LABELS, AccountDialog
from opesvault.ui.pages.accounts.tab import PageTab
from opesvault.ui.theme import SPACE_L

if TYPE_CHECKING:
    from opesvault.ui.pages.base import Page

HISTORY_MONTHS = 12


class AccountsTab(PageTab):
    def __init__(self, page: "Page") -> None:
        super().__init__(page)
        from opesvault.ui.chart_panel import ChartPanel

        self.table = make_table(["Conta", "Tipo", "Instituição", "Titulares", "Saldo", "Conferido com o banco"])
        self.table.setAccessibleName("Contas")
        stretch_column(self.table)
        self.table.setSortingEnabled(False)
        self.table.setProperty("maxRows", 10)
        self.table.itemSelectionChanged.connect(self._account_selected)
        self.table.doubleClicked.connect(lambda _: self.edit())
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
            button("Ver lançamentos", self.open_ledger, role="plain"),
        )
        self.checks_section.add(self.checks)
        self.history_title = ElidedLabel("", "headline")
        layout = self.column()
        layout.addLayout(
            hbox(
                button("Nova conta…", self.add),
                button("Editar…", self.edit),
                button("Conferir saldo…", self.check_balance),
                None,
            )
        )
        scroll, content = scroll_body()
        content.setSpacing(SPACE_L)
        content.addWidget(frameless(self.table))
        content.addWidget(self.history_title)
        content.addWidget(self.history)
        content.addWidget(self.checks_section)
        content.addStretch(1)
        layout.addWidget(scroll, 1)

    def refresh(self) -> None:
        if self.session is None:
            self.table.setRowCount(0)
            self._account_selected()
            return
        ledger = self.session.ledger
        names = {m.id: m.name for m in ledger.members.values()}
        balances = queries.balances(ledger)
        from opesvault.domain.balance_checks import latest

        checked = latest(ledger)

        def check_label(account_id: Any) -> str:
            result = checked.get(account_id)
            if result is None:
                return "nunca"
            when = fmt_date(result.check.on)
            return f"{when}: confere" if result.matches else f"{when}: diferença de {fmt(result.difference)}"

        selected = selected_id(self.table)
        set_rows(
            self.table,
            [
                (
                    [
                        a.name,
                        SUBTYPE_LABELS.get(a.subtype, a.subtype.value),
                        a.institution or "",
                        ", ".join(names.get(h, "?") for h in a.holders),
                        fmt(balances.get(a.id, ZERO)),
                        check_label(a.id),
                    ],
                    a.id,
                )
                for a in sorted(ledger.accounts.values(), key=lambda a: a.name)
                if a.type in (AccountType.ASSET, AccountType.LIABILITY)
            ],
        )
        fit_to_rows(self.table)
        select_id(self.table, selected)
        if selected_id(self.table) is None and self.table.rowCount():
            self.table.selectRow(0)
        self._account_selected()

    def show_check(self, account_id: object) -> None:
        """A balance that differs from the bank: the account selected, its checks open."""
        select_id(self.table, account_id)
        self.checks_section.set_expanded(True)

    def _account_selected(self) -> None:
        account_id = selected_id(self.table)
        visible = self.session is not None and account_id is not None
        for widget in (self.history, self.history_title, self.checks_section):
            widget.setVisible(visible)
        if self.session is None or account_id is None:
            self.history.clear()
            self.checks.setRowCount(0)
            self.history_title.clear()
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

    # ── commands ────────────────────────────────────

    def add(self) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        dialog = AccountDialog(self, ledger)
        if not dialog.exec():
            return

        def apply() -> object:
            account = ledger.add_account(dialog.build())
            opening = dialog.opening_balance()
            if opening is not None:
                ledger.record_opening_balance(account.id, opening[0], opening[1])
            return account

        if run_guarded(self, apply):
            self.changed()

    def edit(self) -> None:
        account_id = selected_id(self.table)
        if self.session is None or account_id is None:
            return
        ledger = self.session.ledger
        dialog = AccountDialog(self, ledger, ledger.accounts[account_id])
        if dialog.exec() and run_guarded(self, lambda: ledger.update_account(dialog.build(), "Edição do cadastro")):
            self.changed()

    def check_balance(self) -> None:
        account_id = selected_id(self.table)
        if self.session is None or account_id is None:
            return
        from opesvault.domain.balance_checks import results
        from opesvault.ui.planning_dialogs import BalanceCheckDialog

        dialog = BalanceCheckDialog(self, self.session.ledger, account_id)
        if not dialog.exec():
            return
        result = run_guarded(self, dialog.apply)
        if not result:
            return
        found = next((r for r in results(self.session.ledger, account_id) if r.check.id == result.id), None)
        if found is not None and found.matches:
            self.notify("Saldo conferido: confere com o banco.")
        elif found is not None:
            self.notify(f"Saldo conferido: diferença de {fmt(found.difference)}. Procure o lançamento.")
        self.changed()

    def open_ledger(self) -> None:
        account_id = selected_id(self.table)
        if account_id is not None:
            self.navigate("ledger", ("filter", account_id, None))
