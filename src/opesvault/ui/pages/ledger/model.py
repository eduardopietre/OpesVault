"""What the ledger table shows: labels, periods and a model that formats only visible rows."""

from collections.abc import Callable
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from PySide6.QtCore import QAbstractTableModel, QModelIndex, QPersistentModelIndex, Qt
from PySide6.QtGui import QColor

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import Operation, OperationKind, OriginKind, YearMonth
from opesvault.domain.money import ZERO
from opesvault.domain.search import StatusFilter
from opesvault.ui.common import fmt, fmt_date
from opesvault.ui.theme import tokens

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
PERIODS = (
    ("Todo o período", "all"),
    ("Mês selecionado", "month"),  # relabelled with the month itself (shared with Overview and Budget)
    ("Este mês", "this_month"),
    ("Mês passado", "last_month"),
    ("Últimos 3 meses", "last_3"),
    ("Este ano", "this_year"),
    ("Personalizado", "custom"),
)

MONTH_PERIOD = 1  # index of the shared month in the period filter


def period_range(key: str, today: date) -> tuple[date | None, date | None]:
    first = today.replace(day=1)
    if key == "this_month":
        return first, today
    if key == "last_month":
        end = first - timedelta(days=1)
        return end.replace(day=1), end
    if key == "last_3":
        start = first
        for _ in range(2):
            start = (start - timedelta(days=1)).replace(day=1)
        return start, today
    if key == "this_year":
        return today.replace(month=1, day=1), today
    return None, None


def operation_total(op: Operation) -> Decimal:
    return sum((p.amount for p in op.postings if p.amount > 0), ZERO)


def operation_amount(op: Operation) -> str:
    return fmt(operation_total(op))


def operation_accounts(ledger: Ledger, op: Operation) -> str:
    debit = [ledger.accounts[p.account_id].name for p in op.postings if p.amount > 0]
    credit = [ledger.accounts[p.account_id].name for p in op.postings if p.amount < 0]
    return f"{', '.join(credit)} → {', '.join(debit)}"


class OperationsModel(QAbstractTableModel):
    # Most useful first; the rest can be hidden from the header's context menu.
    HEADERS = ("Data", "Descrição", "De → Para", "Valor", "Competência", "Tipo", "Origem", "Situação")
    DATE, DESCRIPTION, ACCOUNTS, AMOUNT, COMPETENCE, KIND, ORIGIN, STATUS = range(8)

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
        if orientation is not Qt.Orientation.Horizontal:
            return None
        if role == Qt.ItemDataRole.DisplayRole:
            return self.HEADERS[section]
        if role == Qt.ItemDataRole.TextAlignmentRole:
            side = Qt.AlignmentFlag.AlignRight if section == self.AMOUNT else Qt.AlignmentFlag.AlignLeft
            return int(side | Qt.AlignmentFlag.AlignVCenter)
        return None

    def data(self, index: QModelIndex | QPersistentModelIndex, role: int = Qt.ItemDataRole.DisplayRole) -> Any:
        if not index.isValid() or self.ledger is None:
            return None
        op = self.ops[index.row()]
        column = index.column()
        if role == Qt.ItemDataRole.DisplayRole:
            return self._cell(op, column)
        if role == Qt.ItemDataRole.TextAlignmentRole and column == self.AMOUNT:
            return int(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        if role == Qt.ItemDataRole.ForegroundRole and not op.active:
            return QColor(tokens().tertiary)  # paired with the "Cancelado" text, never color alone
        if role == Qt.ItemDataRole.ToolTipRole and column == self.DESCRIPTION and op.notes:
            return op.notes
        if role == Qt.ItemDataRole.UserRole:
            return op.id
        return None

    def _cell(self, op: Operation, column: int) -> str:
        assert self.ledger is not None
        match column:
            case self.DATE:
                return fmt_date(op.occurred_on or op.cash_date)
            case self.DESCRIPTION:
                return op.description
            case self.ACCOUNTS:
                return operation_accounts(self.ledger, op)
            case self.AMOUNT:
                return operation_amount(op)
            case self.COMPETENCE:
                return _short_month(op.competence) if op.competence else "—"
            case self.KIND:
                return KIND_LABELS.get(op.kind, op.kind.value)
            case self.ORIGIN:
                return ORIGIN_LABELS[op.origin.kind]
            case _:
                return "Ativo" if op.active else "Cancelado"

    def sort(self, column: int, order: Qt.SortOrder = Qt.SortOrder.AscendingOrder) -> None:
        keys: dict[int, Callable[[Operation], Any]] = {
            self.DATE: lambda o: o.occurred_on or o.cash_date or date.min,
            self.COMPETENCE: lambda o: (o.competence.year, o.competence.month) if o.competence else (0, 0),
            self.AMOUNT: operation_total,
            self.STATUS: lambda o: o.active,
        }
        key = keys.get(column, lambda o: self._cell(o, column).casefold())
        self.layoutAboutToBeChanged.emit()
        self.ops.sort(key=key, reverse=order is Qt.SortOrder.DescendingOrder)
        self.layoutChanged.emit()


def _short_month(month: YearMonth) -> str:
    """'out/2026' (how the charts and tables read months), not '2026-10'."""
    from opesvault.ui.chart_panel import MONTHS

    return f"{MONTHS[month.month - 1]}/{month.year}"
