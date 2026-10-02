"""Livro financeiro: virtual operations table with filters, full edit, bulk reclassification
and history (RF-10, RF-22). The model only formats rows that are on screen, so tens of
thousands of operations stay responsive."""

from collections.abc import Callable
from datetime import date
from typing import Any
from uuid import UUID

from PySide6.QtCore import QAbstractTableModel, QModelIndex, QPersistentModelIndex, Qt, QTimer
from PySide6.QtWidgets import (
    QAbstractItemView,
    QComboBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QTableView,
    QVBoxLayout,
    QWidget,
)

from opesvault.domain.edits import reclassify
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, Operation, OperationKind, OriginKind
from opesvault.domain.money import ZERO
from opesvault.domain.search import OperationFilter, StatusFilter, find_operations
from opesvault.ui.common import combo_value, fill_combo, fmt, fmt_date, run_guarded
from opesvault.ui.dialogs import FormDialog, OperationDialog, ask_reason, category_items
from opesvault.ui.operation_edit import OperationEditDialog, OptionalDate
from opesvault.ui.pages.base import Page

KIND_LABELS = {
    OperationKind.OPENING_BALANCE: "Saldo de abertura",
    OperationKind.INCOME: "Receita",
    OperationKind.EXPENSE: "Despesa",
    OperationKind.TRANSFER: "Transferência",
    OperationKind.CARD_PURCHASE: "Compra no cartão",
    OperationKind.CARD_PAYMENT: "Pagamento de fatura",
    OperationKind.CARD_CHARGE: "Encargo do cartão",
    OperationKind.REFUND: "Estorno do lojista",
    OperationKind.INVESTMENT_CONTRIBUTION: "Aporte",
    OperationKind.INVESTMENT_WITHDRAWAL: "Resgate",
    OperationKind.INVESTMENT_INCOME: "Provento",
    OperationKind.TAX_PAYMENT: "Pagamento de imposto",
    OperationKind.REVERSAL: "Estorno",
    OperationKind.OTHER: "Outra",
}
ORIGIN_LABELS = {
    OriginKind.MANUAL: "Manual",
    OriginKind.IMPORT: "Importado",
    OriginKind.RECURRENCE: "Recorrência",
    OriginKind.SYSTEM: "Sistema",
}
STATUS_LABELS = {
    StatusFilter.ALL: "Ativos e cancelados",
    StatusFilter.ACTIVE: "Só ativos",
    StatusFilter.CANCELLED: "Só cancelados",
}


def operation_total(op: Operation):  # type: ignore[no-untyped-def]
    return sum((p.amount for p in op.postings if p.amount > 0), ZERO)


def operation_amount(op: Operation) -> str:
    return fmt(operation_total(op))


def operation_accounts(ledger: Ledger, op: Operation) -> str:
    debit = [ledger.accounts[p.account_id].name for p in op.postings if p.amount > 0]
    credit = [ledger.accounts[p.account_id].name for p in op.postings if p.amount < 0]
    return f"{', '.join(credit)} → {', '.join(debit)}"


class OperationsModel(QAbstractTableModel):
    HEADERS = ("Data", "Competência", "Descrição", "Tipo", "Contas (crédito → débito)", "Valor", "Origem", "Situação")
    AMOUNT_COLUMN = 5

    def __init__(self) -> None:
        super().__init__()
        self.ledger: Ledger | None = None
        self.ops: list[Operation] = []

    def reset(self, ledger: Ledger | None, ops: list[Operation]) -> None:
        self.beginResetModel()
        self.ledger, self.ops = ledger, ops
        self.endResetModel()

    def rowCount(self, parent: QModelIndex | QPersistentModelIndex = QModelIndex()) -> int:  # noqa: N802, B008
        return 0 if parent.isValid() else len(self.ops)

    def columnCount(self, parent: QModelIndex | QPersistentModelIndex = QModelIndex()) -> int:  # noqa: N802, B008
        return 0 if parent.isValid() else len(self.HEADERS)

    def headerData(self, section: int, orientation: Qt.Orientation, role: int = Qt.ItemDataRole.DisplayRole) -> Any:  # noqa: N802
        if orientation is Qt.Orientation.Horizontal and role == Qt.ItemDataRole.DisplayRole:
            return self.HEADERS[section]
        return None

    def data(self, index: QModelIndex | QPersistentModelIndex, role: int = Qt.ItemDataRole.DisplayRole) -> Any:
        if not index.isValid() or self.ledger is None:
            return None
        op = self.ops[index.row()]
        column = index.column()
        if role == Qt.ItemDataRole.DisplayRole:
            return self._cell(op, column)
        if role == Qt.ItemDataRole.TextAlignmentRole and column == self.AMOUNT_COLUMN:
            return int(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        if role == Qt.ItemDataRole.ToolTipRole and column == 2 and op.notes:
            return op.notes
        if role == Qt.ItemDataRole.UserRole:
            return op.id
        return None

    def _cell(self, op: Operation, column: int) -> str:
        assert self.ledger is not None
        match column:
            case 0:
                return fmt_date(op.occurred_on or op.cash_date)
            case 1:
                return str(op.competence) if op.competence else "—"
            case 2:
                return op.description
            case 3:
                return KIND_LABELS.get(op.kind, op.kind.value)
            case 4:
                return operation_accounts(self.ledger, op)
            case 5:
                return operation_amount(op)
            case 6:
                return ORIGIN_LABELS[op.origin.kind]
            case _:
                return "Ativo" if op.active else "Cancelado"

    def sort(self, column: int, order: Qt.SortOrder = Qt.SortOrder.AscendingOrder) -> None:
        keys: dict[int, Callable[[Operation], Any]] = {
            0: lambda o: o.occurred_on or o.cash_date or date.min,
            1: lambda o: (o.competence.year, o.competence.month) if o.competence else (0, 0),
            5: operation_total,
            7: lambda o: o.active,
        }
        key = keys.get(column, lambda o: self._cell(o, column).casefold())
        self.layoutAboutToBeChanged.emit()
        self.ops.sort(key=key, reverse=order is Qt.SortOrder.DescendingOrder)
        self.layoutChanged.emit()


class ReclassifyDialog(FormDialog):
    def __init__(self, parent: QWidget | None, ledger: Ledger, count: int) -> None:
        super().__init__(parent, "Reclassificar lançamentos")
        self.target = QComboBox()
        items = [(f"Despesa: {label}", i) for label, i in category_items(ledger, AccountType.EXPENSE)]
        items += [(f"Receita: {label}", i) for label, i in category_items(ledger, AccountType.INCOME)]
        fill_combo(self.target, items)
        self.reason = QLineEdit()
        self.form.addRow(
            QLabel(f"{count} lançamento(s) selecionado(s). Rateios com mais de uma categoria ficam como estão.")
        )
        self.form.addRow("Nova categoria:", self.target)
        self.form.addRow("Motivo:", self.reason)

    def validate(self) -> None:
        if combo_value(self.target) is None:
            raise DomainError("Escolha a categoria de destino.")
        if not self.reason.text().strip():
            raise DomainError("O motivo é obrigatório.")


class LedgerPage(Page):
    title = "Livro financeiro"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.model = OperationsModel()
        self.table = QTableView()
        self.table.setModel(self.model)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.table.setSortingEnabled(True)
        self.table.sortByColumn(0, Qt.SortOrder.DescendingOrder)
        self.table.verticalHeader().setVisible(False)
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Interactive)
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.doubleClicked.connect(lambda _: self.edit())
        for column, width in enumerate((90, 80, 280, 130, 300, 110, 90)):
            self.table.setColumnWidth(column, width)

        self.filter_text = QLineEdit()
        self.filter_text.setPlaceholderText("Descrição ou observação…")
        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.setInterval(250)
        self._debounce.timeout.connect(self.refresh)
        self.filter_text.textChanged.connect(lambda _: self._debounce.start())
        self.filter_start = OptionalDate(None)
        self.filter_end = OptionalDate(None)
        self.filter_account = QComboBox()
        self.filter_member = QComboBox()
        self.filter_status = QComboBox()
        fill_combo(self.filter_status, [(label, s) for s, label in STATUS_LABELS.items()])
        self.filter_origin = QComboBox()
        fill_combo(self.filter_origin, [(label, o) for o, label in ORIGIN_LABELS.items()], empty="Todas as origens")
        for combo in (self.filter_account, self.filter_member, self.filter_status, self.filter_origin):
            combo.currentIndexChanged.connect(self.refresh)
        for optional in (self.filter_start, self.filter_end):
            optional.known.toggled.connect(self.refresh)
            optional.edit.dateChanged.connect(self.refresh)
        self.count = QLabel()

        top = QHBoxLayout()
        for label, kind in OperationDialog.KINDS.items():
            button = QPushButton(kind)
            button.clicked.connect(lambda _=False, k=label: self.new_operation(k))
            top.addWidget(button)
        top.addStretch()
        actions = QHBoxLayout()
        for label, slot in (
            ("Editar…", self.edit),
            ("Reclassificar selecionados…", self.reclassify_selected),
            ("Estornar", self.reverse),
            ("Cancelar lançamento", self.cancel),
            ("Histórico", self.show_history),
        ):
            button = QPushButton(label)
            button.clicked.connect(slot)
            actions.addWidget(button)
        actions.addStretch()
        actions.addWidget(self.count)
        filters = QHBoxLayout()
        filters.addWidget(QLabel("De:"))
        filters.addWidget(self.filter_start)
        filters.addWidget(QLabel("Até:"))
        filters.addWidget(self.filter_end)
        for widget in (self.filter_account, self.filter_member, self.filter_status, self.filter_origin):
            filters.addWidget(widget)
        filters.addWidget(self.filter_text, 1)
        layout = QVBoxLayout(self)
        layout.addLayout(top)
        layout.addLayout(filters)
        layout.addLayout(actions)
        layout.addWidget(self.table)

    # ── data ────────────────────────────────────────

    def _refill(self, combo: QComboBox, items: list[tuple[str, Any]], empty: str) -> None:
        current = combo.currentData()
        combo.blockSignals(True)
        fill_combo(combo, items, empty=empty)
        index = combo.findData(current)
        combo.setCurrentIndex(max(index, 0))
        combo.blockSignals(False)

    def current_filter(self) -> OperationFilter:
        return OperationFilter(
            start=self.filter_start.value(),
            end=self.filter_end.value(),
            account_id=self.filter_account.currentData(),
            member_id=self.filter_member.currentData(),
            text=self.filter_text.text(),
            status=self.filter_status.currentData() or StatusFilter.ALL,
            origin=self.filter_origin.currentData(),
        )

    def refresh(self) -> None:
        if self.session is None:
            self.model.reset(None, [])
            self.count.setText("")
            return
        ledger = self.session.ledger
        accounts = sorted(ledger.accounts.values(), key=lambda a: (a.type.value, a.name.casefold()))
        self._refill(
            self.filter_account,
            [
                (a.name if a.subtype is not AccountSubtype.CATEGORY else f"Categoria: {a.name}", a.id)
                for a in accounts
                if a.type in (AccountType.ASSET, AccountType.LIABILITY) or a.subtype is AccountSubtype.CATEGORY
            ],
            "Todas as contas e categorias",
        )
        self._refill(self.filter_member, [(m.name, m.id) for m in ledger.members.values()], "Todos os integrantes")
        selected = set(self.selected_ids())
        ops = find_operations(ledger, self.current_filter())
        self.model.reset(ledger, ops)
        header = self.table.horizontalHeader()
        self.model.sort(header.sortIndicatorSection(), header.sortIndicatorOrder())
        self.count.setText(f"{len(ops)} de {len(ledger.operations)} lançamentos")
        if selected:
            self._select(selected)

    def _select(self, ids: set[UUID]) -> None:
        selection = self.table.selectionModel()
        for row, op in enumerate(self.model.ops):
            if op.id in ids:
                selection.select(
                    self.model.index(row, 0),
                    selection.SelectionFlag.Select | selection.SelectionFlag.Rows,
                )

    def selected_ids(self) -> list[UUID]:
        rows = sorted({index.row() for index in self.table.selectionModel().selectedRows()})
        return [self.model.ops[r].id for r in rows if r < len(self.model.ops)]

    def _selected(self) -> Operation | None:
        if self.session is None:
            return None
        index = self.table.currentIndex()
        if not index.isValid():
            return None
        return self.session.ledger.operations.get(self.model.ops[index.row()].id)

    # ── actions ─────────────────────────────────────

    def new_operation(self, kind: str) -> None:
        if self.session is None:
            return
        dialog = OperationDialog(self, self.session.ledger, kind)
        if dialog.exec() and run_guarded(self, lambda: dialog.apply() or True):
            self.changed()

    def edit(self) -> None:
        op = self._selected()
        if op is None or self.session is None:
            return
        if not op.active:
            QMessageBox.information(self, "Editar", "Lançamento cancelado não pode ser editado.")
            return
        dialog = OperationEditDialog(self, self.session.ledger, op)
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.changed()

    def reclassify_selected(self) -> None:
        ids = self.selected_ids()
        if not ids or self.session is None:
            return
        ledger = self.session.ledger
        dialog = ReclassifyDialog(self, ledger, len(ids))
        if not dialog.exec():
            return
        result = run_guarded(
            self, lambda: reclassify(ledger, ids, combo_value(dialog.target), dialog.reason.text().strip())
        )
        if result is None:
            return
        message = f"{result.changed} reclassificado(s), {result.skipped} mantido(s)."
        if result.errors:
            message += "\n\n" + "\n".join(result.errors[:10])
        QMessageBox.information(self, "Reclassificação", message)
        if result.changed:
            self.changed()

    def reverse(self) -> None:
        op = self._selected()
        if op is None or self.session is None:
            return
        reason = ask_reason(self, "Estornar lançamento")
        ledger = self.session.ledger
        if reason and run_guarded(self, lambda: ledger.reverse_operation(op.id, date.today(), reason)):
            self.changed()

    def cancel(self) -> None:
        op = self._selected()
        if op is None or self.session is None:
            return
        reason = ask_reason(self, "Cancelar lançamento")
        ledger = self.session.ledger
        if reason and run_guarded(self, lambda: ledger.cancel_operation(op.id, reason)):
            self.changed()

    def show_history(self) -> None:
        op = self._selected()
        if op is None or self.session is None:
            return
        lines = [
            f"{h.at:%d/%m/%Y %H:%M} · v{h.version} · {h.action.value} · {h.operator or 'operador não informado'}"
            + (f" · motivo: {h.reason}" if h.reason else "")
            for h in self.session.ledger.history_of(op.id)
        ]
        QMessageBox.information(self, "Histórico", "\n".join(lines) or "Sem histórico.")
