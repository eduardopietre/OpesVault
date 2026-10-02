"""Visão geral: the month at a glance — cash, competence result, net worth, balances and
spending by category, plus what still needs attention (docs/07 §2)."""

from datetime import date
from decimal import Decimal
from typing import Any

from PySide6.QtCore import QRectF, Qt
from PySide6.QtGui import QColor, QPainter
from PySide6.QtWidgets import (
    QGridLayout,
    QStyledItemDelegate,
    QStyleOptionViewItem,
    QTableWidget,
    QVBoxLayout,
)

from opesvault.domain import queries
from opesvault.domain.model import AccountType, YearMonth
from opesvault.domain.money import ZERO
from opesvault.ui.alerts_panel import AlertsPanel
from opesvault.ui.common import fit_to_rows, fmt, fmt_date, month_label, set_rows, stretch_column, summary_table
from opesvault.ui.components import Figures, MonthPicker, Section, button, scroll_body, separator, text
from opesvault.ui.pages.base import Page
from opesvault.ui.theme import SPACE_M, SPACE_S, SPACE_XL, SPACE_XS, SPACE_XXL, tokens

SHARE_ROLE = Qt.ItemDataRole.UserRole + 2
SHARE_BARS_FROM = 3  # categories needed before a bar adds anything to the percentage


class ShareBarDelegate(QStyledItemDelegate):
    """A short neutral bar left of the percentage; the number stays the primary reading."""

    def paint(self, painter: QPainter, option: QStyleOptionViewItem, index: Any) -> None:
        super().paint(painter, option, index)
        share = index.data(SHARE_ROLE)
        if not isinstance(share, float):
            return
        rect = option.rect  # type: ignore[attr-defined]
        track = QRectF(rect.left() + SPACE_S, rect.center().y() - 2, max(rect.width() - 64, 0), 4)
        t = tokens()
        painter.save()
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(t.separator))
        painter.drawRoundedRect(track, 2, 2)
        painter.setBrush(QColor(t.tertiary))
        painter.drawRoundedRect(QRectF(track.left(), track.top(), track.width() * min(share, 1.0), 4), 2, 2)
        painter.restore()


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
        self._following = False
        self.month.changed.connect(self._month_changed)
        self.close_button = button("Fechar mês…", self.close_month, tip="Bloqueia alterações no mês")
        self.reopen_button = button("Reabrir mês…", self.reopen_month, tip="Libera alterações; exige motivo")
        # Time navigation and the month action are separate groups.
        self.header.add(self.month, SPACE_XL, self.close_button, self.reopen_button)
        self._month_chosen = False
        self.alerts = AlertsPanel(self.navigate)

        self.cash = Figures(["Entradas", "Saídas", "Saldo do mês"])
        self.result = Figures(["Receitas", "Despesas", "Resultado"])
        self.worth = Figures(["Ativos", "Passivos", "Patrimônio líquido"])
        # Cash and competence are two readings of the same month: equal columns, and heading,
        # caption and figures share grid rows so they line up across the columns.
        month_grid = QGridLayout()
        month_grid.setContentsMargins(0, 0, 0, 0)
        month_grid.setHorizontalSpacing(SPACE_XXL)
        month_grid.setVerticalSpacing(SPACE_XS)
        columns = (
            ("Caixa", "O que entrou e saiu das contas. Transferências entre contas próprias não contam.", self.cash),
            ("Resultado por competência", "Despesas no mês em que aconteceram, inclusive no cartão.", self.result),
        )
        for column, (title, caption, figures) in enumerate(columns):
            month_grid.addWidget(text(title, "headline"), 0, column)
            note = text(caption, "caption", wrap=True)
            note.setMinimumWidth(160)
            month_grid.addWidget(note, 1, column, Qt.AlignmentFlag.AlignTop)
            month_grid.addWidget(figures, 3, column, Qt.AlignmentFlag.AlignTop)
            month_grid.setColumnStretch(column, 1)
        month_grid.setRowMinimumHeight(2, SPACE_S)

        # Net worth is a position, not a flow: its own band, below a rule.
        self.worth_caption = text("", "caption")
        worth = QVBoxLayout()
        worth.setContentsMargins(0, 0, 0, 0)
        worth.setSpacing(SPACE_XS)
        worth.addWidget(separator())
        worth.addSpacing(SPACE_XL)
        worth.addWidget(text("Patrimônio no fim do mês", "headline"))
        worth.addWidget(self.worth_caption)
        worth.addSpacing(SPACE_M)
        worth.addWidget(self.worth)

        self.pending = text("", wrap=True)
        self.pending.setProperty("tone", "warning")
        # What blocks closing the month, apart from "Atenção" (what is due or waiting today).
        self.pending_section = Section("Antes de fechar o mês")
        self.pending_section.add(self.pending)

        self.balances = summary_table(["Conta", "Saldo"])
        self.categories = summary_table(["Categoria", "Despesa", "% do total"])
        self.categories.setItemDelegateForColumn(2, ShareBarDelegate(self.categories))
        for table in (self.balances, self.categories):
            stretch_column(table)
            # Each line opens its operations in the Ledger, for this month.
            table.cellClicked.connect(lambda row, _column, t=table: self._open_row(t, row))
            table.itemActivated.connect(lambda item, t=table: self._open_row(t, item.row()))
            table.viewport().setCursor(Qt.CursorShape.PointingHandCursor)
            table.setToolTip("Clique para ver os lançamentos deste mês no Livro financeiro")
        tables = QGridLayout()
        tables.setContentsMargins(0, 0, 0, 0)
        tables.setHorizontalSpacing(SPACE_XXL)
        tables.setVerticalSpacing(SPACE_S)
        for column, (title, table) in enumerate(
            (("Saldos das contas", self.balances), ("Despesas por categoria", self.categories))
        ):
            tables.addWidget(text(title, "headline"), 0, column)
            tables.addWidget(table, 1, column, Qt.AlignmentFlag.AlignTop)
            tables.setColumnStretch(column, 1)

        # Short windows scroll the content instead of forcing a taller window.
        scroll, content = scroll_body()
        content.addWidget(self.alerts)
        content.addLayout(month_grid)
        content.addLayout(worth)
        content.addWidget(self.pending_section)
        content.addLayout(tables)
        content.addStretch(1)
        layout = self.page_layout()
        layout.addWidget(scroll, 1)

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
            self.month_chosen(latest)  # Budget and Ledger open on the same month

    def _month_changed(self) -> None:
        self._month_chosen = True  # a month picked here or elsewhere wins over the automatic default
        self.refresh()
        if not self._following:
            self.month_chosen(self.month.current())

    def follow_month(self, month: object) -> None:
        self._month_chosen = True
        self._following = True
        try:
            self.month.set_month(month)
        finally:
            self._following = False

    def show_alerts(self) -> None:
        """Called when a vault opens: the panel comes back even if it was hidden before."""
        self.alerts.reveal()
        self.refresh()

    def set_session(self, session) -> None:  # type: ignore[no-untyped-def]
        self._month_chosen = False
        self.alerts.dismissed = False
        super().set_session(session)

    def refresh(self) -> None:
        if self.session is None:
            self.alerts.set_alerts([])
            return
        self._default_month()
        ledger = self.session.ledger
        from opesvault.domain.alerts import alerts

        self.alerts.set_alerts(alerts(ledger))
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
        # The month itself is shown once, in the picker.
        self.header.set_subtitle("Mês fechado" if closed else "Mês aberto")
        self.worth_caption.setText(f"Saldos de todas as contas em {fmt_date(month.last_day())}.")
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
        # Bars only help when there is something to compare.
        bars = bool(total) and len(rows) >= SHARE_BARS_FROM
        for row, (_cells, account_id) in enumerate(rows):
            item = self.categories.item(row, 2)
            if item is not None and bars:
                item.setData(SHARE_ROLE, float(spending[account_id] / total))
        self.categories.setColumnWidth(2, 150 if bars else 96)
        fit_to_rows(self.balances)
        fit_to_rows(self.categories)

    def _open_row(self, table: QTableWidget, row: int) -> None:
        item = table.item(row, 0)
        account_id = item.data(Qt.ItemDataRole.UserRole) if item is not None else None
        if account_id is not None:
            self.navigate("ledger", ("filter", account_id, self.month.current()))

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
    """Numeric column: header and cells on the right edge."""
    header = table.horizontalHeaderItem(column)
    if header is not None:
        header.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
    for row in range(table.rowCount()):
        item = table.item(row, column)
        if item is not None:
            item.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
