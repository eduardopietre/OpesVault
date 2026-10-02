"""Visão geral: the month at a glance — cash, competence result, net worth, balances and
spending by category, plus what still needs attention (docs/07 §2)."""

from datetime import date
from decimal import Decimal

from PySide6.QtWidgets import QGridLayout, QTableWidget

from opesvault.domain import queries
from opesvault.domain.model import AccountType, YearMonth
from opesvault.domain.money import ZERO
from opesvault.ui.common import fmt, make_table, month_label, set_rows, stretch_column
from opesvault.ui.components import Figures, MonthPicker, Section, button, flow_row, text
from opesvault.ui.pages.base import Page
from opesvault.ui.theme import SPACE_XL


def _tone(value: Decimal | None) -> str | None:
    if value is None or value == 0:
        return None
    return "positive" if value > 0 else "negative"


class OverviewPage(Page):
    title = "Visão geral"
    section = "Dia a dia"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.month = MonthPicker()
        self.month.changed.connect(self.refresh)
        self.close_button = button("Fechar mês…", self.close_month, tip="Bloqueia alterações no mês")
        self.reopen_button = button("Reabrir mês…", self.reopen_month, tip="Libera alterações; exige motivo")
        self.header.add(self.month, self.close_button, self.reopen_button)
        self._month_chosen = False

        self.cash = Figures(["Entradas", "Saídas", "Saldo do mês"])
        self.result = Figures(["Receitas", "Despesas", "Resultado"])
        self.worth = Figures(["Ativos", "Passivos", "Patrimônio líquido"])
        cash = Section("Caixa", "O que entrou e saiu das contas. Transferências entre contas próprias não contam.")
        cash.add(self.cash)
        result = Section("Resultado por competência", "Despesas no mês em que aconteceram, inclusive no cartão.")
        result.add(self.result)
        worth = Section("Patrimônio no fim do mês")
        worth.add(self.worth)

        self.pending = text("", wrap=True)
        self.pending.setProperty("tone", "warning")
        self.pending_section = Section("Pendências do mês")
        self.pending_section.add(self.pending)

        self.balances = make_table(["Conta", "Saldo"])
        self.categories = make_table(["Categoria", "Despesa", "Parte"])
        for table in (self.balances, self.categories):
            table.setSortingEnabled(False)
            table.setMinimumHeight(160)
            stretch_column(table)
        balances = Section("Saldos das contas")
        balances.add(self.balances, 1)
        categories = Section("Despesas por categoria")
        categories.add(self.categories, 1)

        # The three groups sit side by side on wide windows and wrap on narrow ones.
        for group in (cash, result, worth):
            group.setMinimumWidth(group.sizeHint().width())
            group.setFixedHeight(group.sizeHint().height())
        figures = flow_row(cash, result, worth, spacing=SPACE_XL * 2, line_spacing=0)
        tables = QGridLayout()
        tables.setHorizontalSpacing(SPACE_XL)
        tables.addWidget(balances, 0, 0)
        tables.addWidget(categories, 0, 1)
        layout = self.page_layout()
        layout.addWidget(figures)
        layout.addWidget(self.pending_section)
        layout.addLayout(tables, 1)

    def _default_month(self) -> None:
        """Opens on the latest month with activity, not on an empty current month."""
        if self.session is None or self._month_chosen:
            return
        dates = [d for op in self.session.ledger.operations.values() if (d := op.occurred_on or op.cash_date)]
        if dates:
            latest = YearMonth.of(min(max(dates), date.today()))
            self.month.blockSignals(True)
            self.month.set_month(latest)
            self.month.blockSignals(False)
            self._month_chosen = True

    def set_session(self, session) -> None:  # type: ignore[no-untyped-def]
        self._month_chosen = False
        super().set_session(session)

    def refresh(self) -> None:
        if self.session is None:
            return
        self._default_month()
        ledger = self.session.ledger
        month: YearMonth = self.month.current()
        flow = queries.cash_flow(ledger, month, month)[month]
        statement = queries.income_statement(ledger, month)
        worth = queries.net_worth(ledger, month.last_day())
        self.cash.set("Entradas", fmt(flow.inflow))
        self.cash.set("Saídas", fmt(flow.outflow))
        self.cash.set("Saldo do mês", fmt(flow.net), _tone(flow.net))
        self.result.set("Receitas", fmt(statement.total_income))
        self.result.set("Despesas", fmt(statement.total_expense))
        self.result.set("Resultado", fmt(statement.result), _tone(statement.result))
        self.worth.set("Ativos", fmt(worth.assets))
        self.worth.set("Passivos", fmt(worth.liabilities))
        self.worth.set("Patrimônio líquido", fmt(worth.net), _tone(worth.net))

        from opesvault.domain.periods import is_closed, pending_items

        closed = is_closed(ledger, month)
        pending = pending_items(ledger, month)
        state = "fechado" if closed else "aberto"
        self.header.set_subtitle(f"{month_label(month).capitalize()} · mês {state}")
        self.close_button.setVisible(not closed)
        self.reopen_button.setVisible(closed)
        self.pending.setText("\n".join(f"• {p}" for p in pending))
        self.pending_section.setVisible(bool(pending))

        at = month.last_day()
        all_balances = queries.balances(ledger, at)
        accounts = sorted(
            (a for a in ledger.accounts.values() if a.type in (AccountType.ASSET, AccountType.LIABILITY)),
            key=lambda a: (a.type.value, a.name.casefold()),
        )
        set_rows(
            self.balances,
            [([a.name, fmt(all_balances.get(a.id, ZERO))], a.id) for a in accounts if not a.archived],
        )
        spending = queries.expenses_by_category(ledger, month, month)
        total = sum(spending.values(), ZERO)
        rows = []
        for account_id, value in sorted(spending.items(), key=lambda kv: kv[1], reverse=True):
            share = f"{(value / total * 100).quantize(Decimal('1'))}%" if total else "—"
            rows.append(([ledger.accounts[account_id].name, fmt(value), share], account_id))
        set_rows(self.categories, rows)
        _align_right(self.categories, 2)

    def close_month(self) -> None:
        if self.session is None:
            return
        from opesvault.domain.periods import close_month, pending_items
        from opesvault.ui.common import run_guarded
        from opesvault.ui.dialogs import ask_reason

        ledger = self.session.ledger
        month: YearMonth = self.month.current()
        note = None
        if pending_items(ledger, month):
            note = ask_reason(self, "Fechar com pendências (justificativa)")
            if note is None:
                return
        if run_guarded(self, lambda: close_month(ledger, month, note)):
            self.notify(f"{month_label(month).capitalize()} fechado.")
            self.changed()

    def reopen_month(self) -> None:
        if self.session is None:
            return
        from opesvault.domain.periods import reopen_month
        from opesvault.ui.common import run_guarded
        from opesvault.ui.dialogs import ask_reason

        ledger = self.session.ledger
        month: YearMonth = self.month.current()
        reason = ask_reason(self, "Reabrir mês")
        if reason and run_guarded(self, lambda: reopen_month(ledger, month, reason)):
            self.notify(f"{month_label(month).capitalize()} reaberto.")
            self.changed()


def _align_right(table: QTableWidget, column: int) -> None:
    from PySide6.QtCore import Qt

    for row in range(table.rowCount()):
        item = table.item(row, column)
        if item is not None:
            item.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
