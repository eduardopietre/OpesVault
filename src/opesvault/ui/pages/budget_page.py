"""Orçamento: planned, actual by competence and remaining per expense category and month."""

from decimal import Decimal
from uuid import UUID

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QHBoxLayout,
    QLineEdit,
    QMessageBox,
    QStackedWidget,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from opesvault.domain import budget
from opesvault.domain.budget import BudgetState
from opesvault.domain.ledger import DomainError, Ledger
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
    style_table,
    summary_table,
)
from opesvault.ui.components import EmptyState, Figures, MonthPicker, button, menu_button
from opesvault.ui.dialogs import FormDialog, category_items
from opesvault.ui.pages.base import Page
from opesvault.ui.theme import SPACE_L, SPACE_S, SPACE_XL, tokens


def _editable(value: Decimal) -> str:
    """A planned amount as typed in the form: '2.350,00' (the same format the field reads)."""
    from opesvault.domain.money import format_brl

    return format_brl(value).replace("R$", "").strip()


STATE_LABELS = {BudgetState.OK: "Dentro", BudgetState.NEAR: "Perto do limite", BudgetState.OVER: "Estourado"}


class BudgetGridDialog(QDialog):
    """The whole month at once: every expense category with its plan, this month's spending and
    last month's plan beside it. Empty means no plan for that category."""

    COLUMNS = ("Categoria", "Planejado", "Gasto no mês", "Mês anterior")

    def __init__(self, parent: QWidget | None, ledger: Ledger, month: YearMonth) -> None:
        from opesvault.domain import queries
        from opesvault.ui.components import text

        super().__init__(parent)
        self.ledger = ledger
        self.month = month
        self.setWindowTitle(f"Orçamento de {month_label(month)}")
        spending = queries.expenses_by_category(ledger, month, month)
        previous = month.add(-1)
        self.categories = category_items(ledger, AccountType.EXPENSE)
        self.table = QTableWidget(len(self.categories), len(self.COLUMNS))
        self.table.setHorizontalHeaderLabels(list(self.COLUMNS))
        style_table(self.table)
        self.table.setAlternatingRowColors(False)
        self.edits: list[QLineEdit] = []
        self.previous: list[Decimal | None] = []
        right = Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter
        for row, (name, category_id) in enumerate(self.categories):
            line = budget.line_for(ledger, category_id, month)
            before = budget.line_for(ledger, category_id, previous)
            edit = money_edit("sem plano")
            edit.setAccessibleName(f"Planejado para {name}")
            if line is not None:
                edit.setText(_editable(line.amount))
            self.edits.append(edit)
            self.previous.append(before.amount if before is not None else None)
            self.table.setItem(row, 0, QTableWidgetItem(name))
            self.table.setCellWidget(row, 1, edit)
            for column, value in ((2, spending.get(category_id)), (3, self.previous[-1])):
                item = QTableWidgetItem(fmt(value) if value is not None else "—")
                item.setTextAlignment(right)
                self.table.setItem(row, column, item)
        for column in (1, 2, 3):
            header = self.table.horizontalHeaderItem(column)
            if header is not None:
                header.setTextAlignment(right)
        self.table.resizeColumnsToContents()
        self.table.setColumnWidth(1, 140)
        stretch_column(self.table)
        self.error = text("", wrap=True)
        self.error.setProperty("tone", "negative")
        self.error.hide()
        copy = button(
            "Copiar do mês anterior", self.copy_previous, tip="Preenche os campos vazios com o plano anterior"
        )
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        save = buttons.button(QDialogButtonBox.StandardButton.Ok)
        cancel = buttons.button(QDialogButtonBox.StandardButton.Cancel)
        if save is not None and cancel is not None:
            save.setText("Salvar orçamento")
            save.setProperty("role", "primary")
            cancel.setText("Cancelar")
        buttons.accepted.connect(self._try_accept)
        buttons.rejected.connect(self.reject)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(SPACE_XL, SPACE_XL, SPACE_XL, SPACE_L)
        layout.setSpacing(SPACE_S)
        layout.addWidget(text(f"Orçamento de {month_label(month)}", "headline"))
        layout.addWidget(
            text(
                "Quanto planeja gastar em cada categoria. Deixe vazio o que não quer acompanhar. O gasto segue a "
                "competência: compras no cartão contam no mês em que aconteceram.",
                "caption",
                wrap=True,
            )
        )
        layout.addWidget(self.table, 1)
        layout.addWidget(self.error)
        bottom = QHBoxLayout()
        bottom.addWidget(copy)
        bottom.addStretch(1)
        bottom.addWidget(buttons)
        layout.addLayout(bottom)
        self.resize(720, 560)

    def copy_previous(self) -> None:
        for edit, value in zip(self.edits, self.previous, strict=True):
            if value is not None and not edit.text().strip():
                edit.setText(_editable(value))

    def values(self) -> list[tuple[UUID, Decimal | None]]:
        """(category, planned) for every row; None where the field is empty."""
        result = []
        for (name, category_id), edit in zip(self.categories, self.edits, strict=True):
            value = read_money(edit, allow_empty=True)
            if value is not None and value <= 0:
                raise DomainError(f"{name}: informe um valor positivo ou deixe vazio.")
            result.append((category_id, value))
        return result

    def _try_accept(self) -> None:
        try:
            self.values()
        except DomainError as exc:
            self.error.setText(str(exc))
            self.error.show()
            return
        self.accept()

    def apply(self) -> int:
        """Writes the differences only; returns how many categories changed."""
        changed = 0
        for category_id, value in self.values():
            line = budget.line_for(self.ledger, category_id, self.month)
            current = line.amount if line is not None else None
            if value == current:
                continue
            if value is None:
                budget.remove_budget(self.ledger, category_id, self.month)
            else:
                budget.set_budget(self.ledger, category_id, self.month, value)
            changed += 1
        return changed


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
                self.amount.setText(_editable(line.amount))
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
        self._following = False
        self.month.changed.connect(self._month_changed)
        more = menu_button(
            "Mais",
            [
                ("Copiar do mês anterior", self.copy_previous),
                None,
                ("Alterar valor…", self.edit_selected),
                ("Remover do orçamento", self.remove_selected),
            ],
        )
        self.header.add(self.month, SPACE_XL, more, button("Orçamento do mês…", self.define_month, role="primary"))
        self.more = more

        self.figures = Figures(["Planejado", "Realizado", "Restante", "Gasto fora do plano"])
        self.figures.values["Gasto fora do plano"].setToolTip("Despesas do mês em categorias sem orçamento")
        self.table = summary_table(["Categoria", "Planejado", "Realizado", "Restante", "Uso", "Situação"], max_rows=16)
        self.table.setAccessibleName("Orçamento por categoria")
        self.table.doubleClicked.connect(lambda _: self.edit_selected())
        stretch_column(self.table)
        self.empty = EmptyState(
            "Sem orçamento neste mês",
            "Defina quanto pretende gastar por categoria. O realizado vem dos lançamentos por competência: "
            "compras no cartão contam no mês em que aconteceram.",
            [button("Copiar do mês anterior", self.copy_previous), button("Definir o mês…", self.define_month)],
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

    def _month_changed(self) -> None:
        self.refresh()
        if not self._following:
            self.month_chosen(self.month.current())

    def follow_month(self, month: object) -> None:
        self._following = True
        try:
            self.month.set_month(month)
        finally:
            self._following = False

    def reveal(self, ref: object, *, act: bool = False) -> None:
        """A budget alert: open its month with the category selected."""
        if not (isinstance(ref, tuple) and len(ref) == 2):
            return
        category_id, month = ref
        self.month.set_month(month)
        for row in range(self.table.rowCount()):
            item = self.table.item(row, 0)
            if item is not None and item.data(Qt.ItemDataRole.UserRole) == category_id:
                self.table.selectRow(row)
                return

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
        self.figures.set("Gasto fora do plano", fmt(status.unbudgeted))
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

    def define_month(self) -> None:
        """Every category of the month in one grid: one dialog, one undo step."""
        if self.session is None:
            return
        ledger = self.session.ledger
        month: YearMonth = self.month.current()
        dialog = BudgetGridDialog(self, ledger, month)
        if dialog.exec():
            changed = run_guarded(self, dialog.apply)
            if changed:
                self.notify(f"Orçamento de {month_label(month)}: {changed} categoria(s) alterada(s).")
                self.changed()
        dialog.deleteLater()

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
