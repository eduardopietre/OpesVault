"""Livro financeiro: every operation, with search, filters, a details inspector and the
corrections the docs allow (RF-10, RF-22).

Layout: header (title, count, search, "Novo lançamento"), one filter row, then the
table beside an inspector that follows the selection. Row commands live in the
"Ações" menu, the context menu and the keyboard (Enter edits). The model only
formats rows on screen, so tens of thousands of operations stay responsive.
"""

from collections.abc import Callable
from datetime import date, timedelta
from typing import Any
from uuid import UUID

from PySide6.QtCore import QAbstractTableModel, QModelIndex, QPersistentModelIndex, QPoint, Qt, QTimer
from PySide6.QtGui import QColor, QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QAbstractItemView,
    QComboBox,
    QLabel,
    QLineEdit,
    QMenu,
    QMessageBox,
    QScrollArea,
    QSplitter,
    QStackedWidget,
    QTableView,
    QVBoxLayout,
    QWidget,
)

from opesvault.domain.edits import reclassify
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, Operation, OperationKind, OriginKind, YearMonth
from opesvault.domain.money import ZERO
from opesvault.domain.search import OperationFilter, StatusFilter, find_operations
from opesvault.ui.common import (
    combo_value,
    fill_combo,
    fmt,
    fmt_date,
    install_column_chooser,
    month_label,
    run_guarded,
    select_combo,
    style_table,
)
from opesvault.ui.components import EmptyState, button, fill_menu, flow_row, hbox, menu_button, separator, text
from opesvault.ui.dialogs import FormDialog, OperationDialog, ask_reason, category_items
from opesvault.ui.operation_edit import OperationEditDialog, OptionalDate, SimpleEditDialog, is_simple
from opesvault.ui.pages.base import Page
from opesvault.ui.theme import SPACE_M, SPACE_S, tokens

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


def operation_total(op: Operation):  # type: ignore[no-untyped-def]
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
                return str(op.competence) if op.competence else "—"
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


def _pair(label: str, value: str) -> QWidget:
    widget = QWidget()
    widget.setLayout(hbox(text(label, "secondary"), None, text(value)))
    return widget


class OperationInspector(QScrollArea):
    """Details of the selected operation, kept beside the table instead of in a dialog."""

    def __init__(self) -> None:
        super().__init__()
        self.setWidgetResizable(True)
        self.setFrameShape(QScrollArea.Shape.NoFrame)
        self.setMinimumWidth(240)
        body = QWidget()
        body.setObjectName("Surface")
        self.body = QVBoxLayout(body)
        self.body.setContentsMargins(SPACE_M, 0, 0, 0)
        self.body.setSpacing(SPACE_S)
        self.setWidget(body)
        self.setAccessibleName("Detalhes do lançamento")

    def _clear(self) -> None:
        while self.body.count():
            item = self.body.takeAt(0)
            widget = item.widget() if item is not None else None
            if widget is not None:
                widget.deleteLater()

    def show_operation(self, ledger: Ledger | None, op: Operation | None, selected: int) -> None:
        self._clear()
        add = self.body.addWidget
        if ledger is None or op is None:
            message = "Nenhum lançamento selecionado" if selected == 0 else f"{selected} lançamentos selecionados"
            add(text(message, "secondary", wrap=True))
            if selected > 1:
                add(text("Use Ações › Reclassificar para mudar a categoria de todos.", "caption", wrap=True))
            self.body.addStretch(1)
            return
        add(text(op.description, "headline", wrap=True))
        status = "Ativo" if op.active else "Cancelado"
        kind = KIND_LABELS.get(op.kind, op.kind.value)
        add(text(f"{kind} · {status} · {ORIGIN_LABELS[op.origin.kind]}", "secondary", wrap=True))
        add(text(operation_amount(op), "figure"))
        add(separator())
        member = ledger.members.get(op.member_id) if op.member_id else None
        for label, value in (
            ("Ocorrência", fmt_date(op.occurred_on)),
            ("Lançamento", fmt_date(op.booked_on)),
            ("Liquidação", fmt_date(op.settled_on)),
            ("Vencimento", fmt_date(op.due_on)),
            ("Competência", str(op.competence) if op.competence else "—"),
            ("Responsável", member.name if member else "Família"),
        ):
            add(_pair(label, value))
        add(separator())
        add(text("Partidas", "headline"))
        for posting in op.postings:
            account = ledger.accounts.get(posting.account_id)
            side = "débito" if posting.amount > 0 else "crédito"
            share = ledger.members.get(posting.member_id) if posting.member_id else None
            detail = f"{side} · {share.name}" if share else side
            add(_pair(account.name if account else "?", f"{fmt(abs(posting.amount))} ({detail})"))
        if op.notes:
            add(separator())
            add(text("Observações", "headline"))
            add(text(op.notes, wrap=True))
        history = ledger.history_of(op.id)
        if history:
            add(separator())
            add(text("Histórico", "headline"))
            for entry in history[-5:]:
                who = entry.operator or "operador não informado"
                add(text(f"{entry.at:%d/%m/%Y %H:%M} · v{entry.version} · {who}", "caption", wrap=True))
                if entry.reason:
                    add(text(f"Motivo: {entry.reason}", wrap=True))
        self.body.addStretch(1)


class ReclassifyDialog(FormDialog):
    def __init__(self, parent: QWidget | None, ledger: Ledger, count: int) -> None:
        super().__init__(parent, "Reclassificar lançamentos", "Reclassificar")
        self.target = QComboBox()
        items = [(f"Despesa: {label}", i) for label, i in category_items(ledger, AccountType.EXPENSE)]
        items += [(f"Receita: {label}", i) for label, i in category_items(ledger, AccountType.INCOME)]
        fill_combo(self.target, items)
        self.reason = QLineEdit()
        self.reason.setPlaceholderText("obrigatório; fica no histórico")
        note = f"{count} lançamento(s) selecionado(s). Rateios com mais de uma categoria ficam como estão."
        self.form.addRow(text(note, "secondary", wrap=True))
        self.form.addRow("Nova categoria:", self.target)
        self.form.addRow("Motivo:", self.reason)

    def validate(self) -> None:
        if combo_value(self.target) is None:
            raise DomainError("Escolha a categoria de destino.")
        if not self.reason.text().strip():
            raise DomainError("O motivo é obrigatório.")


class LedgerPage(Page):
    title = "Livro financeiro"
    section = "Dia a dia"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        # ── header: search and the primary action
        self.filter_text = QLineEdit()
        self.filter_text.setPlaceholderText("Buscar descrição ou observação")
        self.filter_text.setClearButtonEnabled(True)
        self.filter_text.setAccessibleName("Buscar lançamentos")
        self.filter_text.setToolTip("Buscar (Ctrl+F)")
        self.filter_text.setMinimumWidth(200)
        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.setInterval(250)
        self._debounce.timeout.connect(self.refresh)
        self.filter_text.textChanged.connect(lambda _: self._debounce.start())
        new_entries: list[tuple[str, Callable[[], object]]] = [
            (label, lambda k=kind: self.new_operation(k)) for kind, label in OperationDialog.KINDS.items()
        ]
        self.new_button = menu_button("Novo lançamento", new_entries, tip="Registrar uma operação manual")
        self.new_button.setProperty("role", "primary")
        self.header.add(self.filter_text, self.new_button)

        # ── one row of filters
        self.period = QComboBox()
        self.period.setAccessibleName("Período")
        fill_combo(self.period, list(PERIODS))
        self._month = YearMonth.of(date.today())
        self._label_month()
        self.filter_start = OptionalDate(None)
        self.filter_end = OptionalDate(None)
        self.filter_start.edit.setAccessibleName("Data inicial")
        self.filter_end.edit.setAccessibleName("Data final")
        for optional in (self.filter_start, self.filter_end):
            optional.known.setChecked(True)
            optional.known.hide()
        self.custom_dates = QWidget()
        self.custom_dates.setLayout(hbox(self.filter_start, text("até", "secondary"), self.filter_end))
        self.custom_dates.hide()
        self.filter_account = QComboBox()
        self.filter_account.setAccessibleName("Conta ou categoria")
        self.filter_member = QComboBox()
        self.filter_member.setAccessibleName("Integrante")
        self.filter_status = QComboBox()
        self.filter_status.setAccessibleName("Situação")
        fill_combo(self.filter_status, [(label, s) for s, label in STATUS_LABELS.items()])
        self.filter_origin = QComboBox()
        self.filter_origin.setAccessibleName("Origem")
        fill_combo(self.filter_origin, [(label, o) for o, label in ORIGIN_LABELS.items()], empty="Todas as origens")
        # Short, fixed option lists show their whole text (the row wraps on narrow windows);
        # account names can be long, so that one keeps a bounded width.
        for combo in (self.period, self.filter_member, self.filter_status, self.filter_origin):
            combo.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToContents)
        self.filter_account.setMinimumContentsLength(18)
        self.filter_account.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToMinimumContentsLengthWithIcon)
        self.period.currentIndexChanged.connect(self._period_changed)
        for combo in (self.filter_account, self.filter_member, self.filter_status, self.filter_origin):
            combo.currentIndexChanged.connect(self.refresh)
        for optional in (self.filter_start, self.filter_end):
            optional.edit.dateChanged.connect(self.refresh)
        self.clear_filters = button("Limpar filtros", self.reset_filters, role="plain")
        row_commands: list[Any] = [
            ("Corrigir…", self.edit, "Return"),
            ("Corrigir partidas…", self.edit_postings),
            ("Reclassificar…", self.reclassify_selected),
            ("Estornar…", self.reverse),
            ("Histórico", self.show_history),
            None,
            ("Cancelar lançamento…", self.cancel),
        ]
        self._row_commands = row_commands
        self.actions_button = menu_button(
            "Ações", row_commands, tip="Comandos para os lançamentos selecionados (também no botão direito)"
        )
        self.details_button = button("Detalhes", self.toggle_inspector, role="plain", tip="Mostrar ou ocultar detalhes")
        self.details_button.setCheckable(True)
        self.details_button.setChecked(True)
        self._inspector_chosen = False
        flow_host = flow_row(
            self.period,
            self.custom_dates,
            self.filter_account,
            self.filter_member,
            self.filter_status,
            self.filter_origin,
            self.clear_filters,
        )
        filters = hbox(flow_host, self.actions_button, self.details_button)
        filters.setAlignment(self.actions_button, Qt.AlignmentFlag.AlignTop)
        filters.setAlignment(self.details_button, Qt.AlignmentFlag.AlignTop)

        # ── table beside the inspector
        self.model = OperationsModel()
        self.table = QTableView()
        self.table.setModel(self.model)
        style_table(self.table)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.table.setSortingEnabled(True)
        self.table.sortByColumn(OperationsModel.DATE, Qt.SortOrder.DescendingOrder)
        self.table.doubleClicked.connect(lambda _: self.edit())
        self.table.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.table.customContextMenuRequested.connect(self._context_menu)
        self.table.setAccessibleName("Lançamentos")
        for key in (Qt.Key.Key_Return, Qt.Key.Key_Enter):
            enter = QShortcut(QKeySequence(key), self.table)
            enter.setContext(Qt.ShortcutContext.WidgetShortcut)
            enter.activated.connect(self.edit)
        for column, width in enumerate((104, 240, 240, 110, 96, 130, 90)):
            self.table.setColumnWidth(column, width)
        install_column_chooser(
            self.table, "livro", required={OperationsModel.DATE, OperationsModel.DESCRIPTION, OperationsModel.AMOUNT}
        )
        self.table.selectionModel().selectionChanged.connect(lambda *_: self._update_selection())

        self.empty_action = button("Limpar filtros", self._empty_action)
        self.empty = EmptyState("", "", [self.empty_action])
        self.empty_new = EmptyState(
            "Nenhum lançamento ainda",
            "Importe uma fatura ou um extrato em “Importar e revisar”, ou registre uma operação em Novo lançamento.",
        )
        self.views = QStackedWidget()
        for widget in (self.table, self.empty, self.empty_new):
            self.views.addWidget(widget)
        self.inspector = OperationInspector()
        self.split = QSplitter(Qt.Orientation.Horizontal)
        self.split.setChildrenCollapsible(False)
        self.split.addWidget(self.views)
        self.split.addWidget(self.inspector)
        self.split.setStretchFactor(0, 1)
        self.split.setSizes([900, 300])

        self.count = QLabel()  # kept for scripts and tests; the visible count is the header subtitle
        layout = self.page_layout()
        layout.addLayout(filters)
        layout.addWidget(self.split, 1)

    # ── data ────────────────────────────────────────

    def focus_search(self) -> bool:
        self.filter_text.setFocus()
        self.filter_text.selectAll()
        return True

    def _refill(self, combo: QComboBox, items: list[tuple[str, Any]], empty: str) -> None:
        current = combo.currentData()
        combo.blockSignals(True)
        fill_combo(combo, items, empty=empty)
        combo.setCurrentIndex(0)
        select_combo(combo, current)
        combo.blockSignals(False)

    def _label_month(self) -> None:
        self.period.setItemText(MONTH_PERIOD, month_label(self._month).capitalize())

    def follow_month(self, month: object) -> None:
        """The month chosen in the Overview or the Budget; shown when the period is "the month"."""
        if not isinstance(month, YearMonth) or month == self._month:
            return
        self._month = month
        self._label_month()
        if self.period.currentData() == "month":
            self.refresh()

    def reveal(self, ref: object, *, act: bool = False) -> None:
        """("filter", account or category, period[, member]): the operations behind a number.

        `period` is a month (Overview, Reports), a (start, end) pair of dates, or None for all.
        """
        if not (isinstance(ref, tuple) and len(ref) in (3, 4) and ref[0] == "filter"):
            return
        account_id, period, member_id = ref[1], ref[2], ref[3] if len(ref) == 4 else None
        custom = isinstance(period, tuple)
        index = MONTH_PERIOD if isinstance(period, YearMonth) else self.period.count() - 1 if custom else 0
        for combo in (self.period, self.filter_account, self.filter_member, self.filter_status, self.filter_origin):
            combo.blockSignals(True)
            combo.setCurrentIndex(index if combo is self.period else 0)
            combo.blockSignals(False)
        self.custom_dates.setVisible(custom)
        if custom:
            for optional, day in zip((self.filter_start, self.filter_end), period, strict=True):
                optional.edit.blockSignals(True)
                optional.set_value(day)
                optional.edit.blockSignals(False)
        month = period
        self.filter_text.blockSignals(True)
        self.filter_text.clear()
        self.filter_text.blockSignals(False)
        if isinstance(month, YearMonth):
            self._month = month
            self._label_month()
        self.refresh()  # fills the account list before choosing from it
        for combo, value in ((self.filter_account, account_id), (self.filter_member, member_id)):
            combo.blockSignals(True)
            select_combo(combo, value)
            combo.blockSignals(False)
        self.refresh()

    def _period_changed(self) -> None:
        self.custom_dates.setVisible(self.period.currentData() == "custom")
        self.refresh()

    def current_filter(self) -> OperationFilter:
        key = self.period.currentData() or "all"
        if key == "custom":
            start, end = self.filter_start.value(), self.filter_end.value()
        elif key == "month":
            start, end = self._month.first_day(), self._month.last_day()
        else:
            start, end = period_range(key, date.today())
        return OperationFilter(
            start=start,
            end=end,
            account_id=self.filter_account.currentData(),
            member_id=self.filter_member.currentData(),
            text=self.filter_text.text(),
            status=self.filter_status.currentData() or StatusFilter.ALL,
            origin=self.filter_origin.currentData(),
        )

    def filters_active(self) -> bool:
        combos = (self.period, self.filter_account, self.filter_member, self.filter_status, self.filter_origin)
        return any(c.currentIndex() > 0 for c in combos) or bool(self.filter_text.text().strip())

    def _only_period_filter(self) -> bool:
        others = (self.filter_account, self.filter_member, self.filter_status, self.filter_origin)
        return not any(c.currentIndex() > 0 for c in others) and not self.filter_text.text().strip()

    def _empty_action(self) -> None:
        self.reset_filters()  # back to "Todo o período", which is also what "Ver todo o período" means

    def reset_filters(self) -> None:
        for combo in (self.period, self.filter_account, self.filter_member, self.filter_status, self.filter_origin):
            combo.blockSignals(True)
            combo.setCurrentIndex(0)
            combo.blockSignals(False)
        self.custom_dates.hide()
        self.filter_text.blockSignals(True)
        self.filter_text.clear()
        self.filter_text.blockSignals(False)
        self.refresh()

    def refresh(self) -> None:
        if self.session is None:
            self.model.reset(None, [])
            self.count.setText("")
            self.header.set_subtitle("")
            self.inspector.show_operation(None, None, 0)
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
            "Todas as contas",
        )
        self._refill(self.filter_member, [(m.name, m.id) for m in ledger.members.values()], "Todos os integrantes")
        selected = set(self.selected_ids())
        ops = find_operations(ledger, self.current_filter())
        self.model.reset(ledger, ops)
        header = self.table.horizontalHeader()
        self.model.sort(header.sortIndicatorSection(), header.sortIndicatorOrder())
        total = len(ledger.operations)
        active = self.filters_active()
        self.count.setText(f"{len(ops)} de {total} lançamentos")
        self.header.set_subtitle(f"{len(ops)} de {total} lançamentos" if active else f"{total} lançamentos")
        self.clear_filters.setVisible(active)
        if total == 0:
            self.views.setCurrentWidget(self.empty_new)
        elif not ops:
            month_only = self.period.currentData() == "month" and self._only_period_filter()
            if month_only:
                self.empty.set_text(
                    f"Nenhum lançamento em {month_label(self._month)}", "Veja todo o período ou escolha outro mês."
                )
            else:
                self.empty.set_text("Nenhum lançamento com estes filtros", "Ajuste a busca ou limpe os filtros.")
            self.empty_action.setText("Ver todo o período" if month_only else "Limpar filtros")
            self.views.setCurrentWidget(self.empty)
        else:
            self.views.setCurrentWidget(self.table)
        if selected:
            self._select(selected)
        self._update_selection()

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
        if not index.isValid() or index.row() >= len(self.model.ops):
            return None
        return self.session.ledger.operations.get(self.model.ops[index.row()].id)

    def _update_selection(self) -> None:
        ids = self.selected_ids()
        ledger = self.session.ledger if self.session else None
        op = ledger.operations.get(ids[0]) if ledger is not None and len(ids) == 1 else None
        self.inspector.show_operation(ledger, op, len(ids))
        self.actions_button.setEnabled(bool(ids))

    def toggle_inspector(self) -> None:
        self._inspector_chosen = True  # an explicit choice wins over the automatic one
        self.inspector.setVisible(self.details_button.isChecked())

    def resizeEvent(self, event: object) -> None:  # noqa: N802 - Qt override
        # Narrow windows give the table the room; the details come back when there is space.
        if not self._inspector_chosen:
            wide = self.width() >= 900
            self.inspector.setVisible(wide)
            self.details_button.setChecked(wide)
        super().resizeEvent(event)  # type: ignore[arg-type]

    def _context_menu(self, position: QPoint) -> None:
        index = self.table.indexAt(position)
        if not index.isValid():
            return
        if index.row() not in {i.row() for i in self.table.selectionModel().selectedRows()}:
            self.table.selectRow(index.row())
        menu = QMenu(self)
        fill_menu(menu, self._row_commands)
        menu.exec(self.table.viewport().mapToGlobal(position))

    # ── actions ─────────────────────────────────────

    def new_operation(self, kind: str) -> None:
        if self.session is None:
            return
        dialog = OperationDialog(self, self.session.ledger, kind)
        if dialog.exec() and run_guarded(self, lambda: dialog.apply() or True):
            self.notify(f"{OperationDialog.KINDS[kind]}: lançamento registrado.")
            self.changed()

    def edit(self) -> None:
        """Enter / double click: the day-to-day form; the postings editor only when needed."""
        op = self._selected()
        if op is None or self.session is None:
            return
        if not op.active:
            QMessageBox.information(self, "Corrigir", "Lançamento cancelado não pode ser corrigido.")
            return
        ledger = self.session.ledger
        if is_simple(ledger, op):
            simple = SimpleEditDialog(self, ledger, op)
            if simple.exec():
                if run_guarded(self, simple.apply):
                    self.notify("Lançamento corrigido. A versão anterior ficou no histórico.")
                    self.changed()
                return
            if not simple.wants_full_editor:
                return
        self.edit_postings()

    def edit_postings(self) -> None:
        """The full editor: dates, competence and every posting (debits and credits)."""
        op = self._selected()
        if op is None or self.session is None:
            return
        if not op.active:
            QMessageBox.information(self, "Corrigir", "Lançamento cancelado não pode ser corrigido.")
            return
        dialog = OperationEditDialog(self, self.session.ledger, op)
        if dialog.exec() and run_guarded(self, dialog.apply):
            self.notify("Lançamento corrigido. A versão anterior ficou no histórico.")
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
            QMessageBox.information(self, "Reclassificação", message + "\n\n" + "\n".join(result.errors[:10]))
        else:
            self.notify(message)
        if result.changed:
            self.changed()

    def reverse(self) -> None:
        op = self._selected()
        if op is None or self.session is None:
            return
        reason = ask_reason(self, "Estornar lançamento")
        ledger = self.session.ledger
        if reason and run_guarded(self, lambda: ledger.reverse_operation(op.id, date.today(), reason)):
            self.notify("Estorno registrado como nova operação; o original foi mantido.")
            self.changed()

    def cancel(self) -> None:
        op = self._selected()
        if op is None or self.session is None:
            return
        reason = ask_reason(self, "Cancelar lançamento")
        ledger = self.session.ledger
        if reason and run_guarded(self, lambda: ledger.cancel_operation(op.id, reason)):
            self.notify("Lançamento cancelado. Ele continua visível em “Só cancelados”.")
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
