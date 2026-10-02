"""Orçamento: planned, actual by competence and remaining per expense category and month."""

from decimal import Decimal
from uuid import UUID

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor
from PySide6.QtWidgets import QComboBox, QMessageBox, QStackedWidget, QTableWidgetItem, QWidget

from opesvault.domain import budget
from opesvault.domain.budget import BudgetState
from opesvault.domain.ledger import DomainError
from opesvault.domain.model import AccountType, YearMonth
from opesvault.ui.common import (
    fill_combo,
    fit_to_rows,
    fmt,
    money_edit,
    month_label,
    read_money,
    run_guarded,
    select_combo,
    stretch_column,
    summary_table,
)
from opesvault.ui.components import EmptyState, Figures, MonthPicker, button, menu_button
from opesvault.ui.dialogs import FormDialog, category_items
from opesvault.ui.pages.base import Page
from opesvault.ui.theme import SPACE_L, SPACE_S, SPACE_XL, tokens

STATE_LABELS = {BudgetState.OK: "Dentro", BudgetState.NEAR: "Perto do limite", BudgetState.OVER: "Estourado"}


class BudgetDialog(FormDialog):
    def __init__(self, parent: QWidget | None, ledger, month: YearMonth, category_id: UUID | None = None) -> None:  # type: ignore[no-untyped-def]
        super().__init__(parent, f"Orçamento de {month_label(month)}", "Salvar")
        self.category = QComboBox()
        fill_combo(self.category, category_items(ledger, AccountType.EXPENSE))
        self.category.setAccessibleName("Categoria")
        self.amount = money_edit()
        self.amount.setAccessibleName("Valor planejado")
        if category_id is not None:
            select_combo(self.category, category_id)
            self.category.setEnabled(False)
            line = budget.line_for(ledger, category_id, month)
            if line is not None:
                self.amount.setText(f"{line.amount:f}".replace(".", ","))
        self.form.addRow("Categoria:", self.category)
        self.form.addRow("Planejado para o mês:", self.amount)

    def validate(self) -> None:
        if self.category.currentData() is None:
            raise DomainError("Escolha a categoria.")
        value = read_money(self.amount)
        if value is None or value <= 0:
            raise DomainError("Informe um valor positivo.")


class BudgetPage(Page):
    title = "Orçamento"
    section = "Dia a dia"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.month = MonthPicker(months_ahead=12)
        self.month.changed.connect(self.refresh)
        more = menu_button(
            "Mais",
            [
                ("Copiar do mês anterior", self.copy_previous),
                None,
                ("Alterar valor…", self.edit_selected),
                ("Remover do orçamento", self.remove_selected),
            ],
        )
        self.header.add(self.month, SPACE_XL, more, button("Definir orçamento…", self.define, role="primary"))
        self.more = more

        self.figures = Figures(["Planejado", "Realizado", "Restante", "Sem orçamento"])
        self.table = summary_table(["Categoria", "Planejado", "Realizado", "Restante", "Uso", "Situação"], max_rows=16)
        self.table.setAccessibleName("Orçamento por categoria")
        self.table.doubleClicked.connect(lambda _: self.edit_selected())
        stretch_column(self.table)
        self.empty = EmptyState(
            "Sem orçamento neste mês",
            "Defina quanto pretende gastar por categoria. O realizado vem dos lançamentos por competência: "
            "compras no cartão contam no mês em que aconteceram.",
            [button("Copiar do mês anterior", self.copy_previous), button("Definir orçamento…", self.define)],
        )
        self.views = QStackedWidget()
        self.views.addWidget(self.table)
        self.views.addWidget(self.empty)
        layout = self.page_layout()
        layout.addSpacing(SPACE_S)
        layout.addWidget(self.figures)
        layout.addSpacing(SPACE_L)
        layout.addWidget(self.views)
        layout.addStretch(1)

    def _selected_category(self) -> UUID | None:
        row = self.table.currentRow()
        item = self.table.item(row, 0) if row >= 0 else None
        value = item.data(Qt.ItemDataRole.UserRole) if item is not None else None
        return value if isinstance(value, UUID) else None

    def refresh(self) -> None:
        if self.session is None:
            self.table.setRowCount(0)
            return
        ledger = self.session.ledger
        month: YearMonth = self.month.current()
        status = budget.status(ledger, month)
        remaining = status.total_planned - status.total_actual
        self.figures.set("Planejado", fmt(status.total_planned))
        self.figures.set("Realizado", fmt(status.total_actual))
        self.figures.set("Restante", fmt(remaining), "negative" if remaining < 0 else None)
        self.figures.set("Sem orçamento", fmt(status.unbudgeted))
        over, near = len(status.over), len(status.near)
        # The month is shown once, in the picker; the subtitle says how it is going.
        summary = []
        if over:
            summary.append(f"{over} categoria(s) estourada(s)")
        if near:
            summary.append(f"{near} perto do limite")
        if status.rows and not summary:
            summary.append("Todas as categorias dentro do planejado")
        self.header.set_subtitle(" · ".join(summary))
        self.views.setCurrentWidget(self.table if status.rows else self.empty)
        self.table.setRowCount(len(status.rows))
        right = Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter
        t = tokens()
        colors = {BudgetState.OVER: t.negative, BudgetState.NEAR: t.warning, BudgetState.OK: t.text}
        for column in (1, 2, 3, 4):
            header = self.table.horizontalHeaderItem(column)
            if header is not None:
                header.setTextAlignment(right)
        for r, row in enumerate(status.rows):
            percent = f"{(row.used * 100).quantize(Decimal('1'))}%"
            cells = [row.name, fmt(row.planned), fmt(row.actual), fmt(row.remaining), percent, STATE_LABELS[row.state]]
            for c, value in enumerate(cells):
                item = QTableWidgetItem(value)
                if c in (1, 2, 3, 4):
                    item.setTextAlignment(right)
                if c in (3, 5) and row.state is not BudgetState.OK:
                    item.setForeground(QColor(colors[row.state]))  # with the state in words, never color alone
                if c == 0:
                    item.setData(Qt.ItemDataRole.UserRole, row.category_id)
                self.table.setItem(r, c, item)
        for column in range(1, self.table.columnCount()):  # figures at their width; the name takes the rest
            self.table.resizeColumnToContents(column)
        fit_to_rows(self.table)

    # ── actions ─────────────────────────────────────

    def define(self, category_id: UUID | None = None) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        month: YearMonth = self.month.current()
        dialog = BudgetDialog(self, ledger, month, category_id)
        if not dialog.exec():
            return
        value = read_money(dialog.amount)
        target = dialog.category.currentData()
        if run_guarded(self, lambda: budget.set_budget(ledger, target, month, value)):
            self.notify(f"Orçamento de {month_label(month)} atualizado.")
            self.changed()

    def edit_selected(self) -> None:
        category_id = self._selected_category()
        if category_id is not None:
            self.define(category_id)

    def remove_selected(self) -> None:
        category_id = self._selected_category()
        if self.session is None or category_id is None:
            return
        month: YearMonth = self.month.current()
        budget.remove_budget(self.session.ledger, category_id, month)
        self.notify("Categoria removida do orçamento. Ctrl+Z desfaz.")
        self.changed()

    def copy_previous(self) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        month: YearMonth = self.month.current()
        copied = run_guarded(self, lambda: budget.copy_month(ledger, month.add(-1), month) or 0)
        if copied:
            self.notify(f"{copied} categoria(s) copiada(s) de {month_label(month.add(-1))}.")
            self.changed()
        elif copied == 0:
            QMessageBox.information(
                self,
                "Orçamento",
                f"Nada a copiar: {month_label(month.add(-1))} não tem orçamento, "
                "ou estas categorias já estão definidas neste mês.",
            )
