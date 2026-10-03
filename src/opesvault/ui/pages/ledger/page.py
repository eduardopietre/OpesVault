"""Livro financeiro: every operation, with search, filters, a details inspector and the
corrections the docs allow (RF-10, RF-22).

Layout: header (title, count, search, "Novo lançamento"), one filter row, then the
table beside an inspector that follows the selection. Row commands live in the
"Ações" menu, the context menu and the keyboard (Enter edits). The model only
formats rows on screen, so tens of thousands of operations stay responsive.
"""

from collections.abc import Callable
from typing import Any
from uuid import UUID

from PySide6.QtCore import QPoint, Qt
from PySide6.QtGui import QKeySequence, QShortcut
from PySide6.QtWidgets import QAbstractItemView, QLabel, QMenu, QSplitter, QStackedWidget, QTableView

from opesvault.domain.model import Operation, YearMonth
from opesvault.domain.search import find_operations
from opesvault.ui.common import install_column_chooser, month_label, run_guarded, share_width, style_table
from opesvault.ui.components import EmptyState, button, fill_menu, menu_button
from opesvault.ui.dialogs import OperationDialog
from opesvault.ui.pages.base import Page
from opesvault.ui.pages.ledger.actions import OperationActions
from opesvault.ui.pages.ledger.filters import LedgerFilters
from opesvault.ui.pages.ledger.inspector import OperationInspector
from opesvault.ui.pages.ledger.model import OperationsModel

# Below this page width the table takes the room and the details hide (until the user chooses).
INSPECTOR_MIN_PAGE_WIDTH = 900


class LedgerPage(OperationActions, Page):
    title = "Livro financeiro"
    section = "Dia a dia"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.filters = LedgerFilters(self)
        self.filters.changed.connect(self.refresh)
        new_entries: list[tuple[str, Callable[[], object]]] = [
            (label, lambda k=kind: self.new_operation(k)) for kind, label in OperationDialog.KINDS.items()
        ]
        self.new_button = menu_button("Novo lançamento", new_entries, tip="Registrar uma operação manual")
        self.new_button.setProperty("role", "primary")
        self.header.add(self.filters.search, self.new_button)

        self.saved_filters = menu_button("Filtros salvos", [], tip="Guardar ou aplicar uma combinação de filtros")
        self.saved_filters.setAccessibleName("Filtros salvos")
        saved_menu = self.saved_filters.menu()
        if saved_menu is not None:
            saved_menu.aboutToShow.connect(self._fill_saved_filters)
        self._row_commands: list[Any] = [
            ("Corrigir…", self.edit, "Return"),
            ("Corrigir partidas…", self.edit_postings),
            ("Reclassificar…", self.reclassify_selected),
            ("Marcadores…", self.tag_selected),
            ("Anexar comprovante…", self.attach_receipt),
            ("Detalhar rendimento (IR)…", self.detail_income),
            ("Nomear estabelecimento…", self.name_merchant),
            ("Reembolso a receber…", self.request_reimbursement),
            ("Está certo (silenciar aviso)", self.mark_reviewed),
            ("Estornar…", self.reverse),
            ("Histórico", self.show_history),
            None,
            ("Cancelar lançamento…", self.cancel),
        ]
        self.actions_button = menu_button(
            "Ações", self._row_commands, tip="Comandos para os lançamentos selecionados (também no botão direito)"
        )
        self.details_button = button("Detalhes", self.toggle_inspector, role="plain", tip="Mostrar ou ocultar detalhes")
        self.details_button.setCheckable(True)
        self.details_button.setChecked(True)
        self._inspector_chosen = False
        # One flow for filters and row commands: on a narrow window they share the lines, instead
        # of the commands keeping a column that leaves the filters one per line.
        self.filters.add_to_row(self.saved_filters, self.actions_button, self.details_button)

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
        # Data, Descrição, De → Para, Valor, Competência, Tipo, Origem, Situação: on a wide window
        # the room goes to the description and the accounts, which are the ones cut short
        share_width(self.table, (104, 240, 240, 110, 104, 130, 90, 110), {1: 3, 2: 3, 5: 1})
        install_column_chooser(
            self.table, "livro", required={OperationsModel.DATE, OperationsModel.DESCRIPTION, OperationsModel.AMOUNT}
        )
        self.table.selectionModel().selectionChanged.connect(lambda *_: self._update_selection())

        self.empty_action = button("Limpar filtros", self.filters.reset)
        self.empty = EmptyState("", "", [self.empty_action])
        self.empty_new = EmptyState(
            "Nenhum lançamento ainda",
            "Importe uma fatura ou um extrato em “Importar e revisar”, ou registre uma operação em Novo lançamento.",
        )
        self.views = QStackedWidget()
        for widget in (self.table, self.empty, self.empty_new):
            self.views.addWidget(widget)
        self.inspector = OperationInspector()
        self.inspector.open_document = self.open_attachment
        self.split = QSplitter(Qt.Orientation.Horizontal)
        self.split.setChildrenCollapsible(False)
        self.split.addWidget(self.views)
        self.split.addWidget(self.inspector)
        # the inspector also grows on a wide window (a quarter of the extra room), the table more
        self.split.setStretchFactor(0, 3)
        self.split.setStretchFactor(1, 1)
        self.split.setSizes([900, 300])

        self.count = QLabel()  # kept for scripts and tests; the visible count is the header subtitle
        layout = self.page_layout()
        layout.addWidget(self.filters.row)
        layout.addWidget(self.split, 1)

    # ── filters ─────────────────────────────────────

    def focus_search(self) -> bool:
        self.filters.search.setFocus()
        self.filters.search.selectAll()
        return True

    def follow_month(self, month: object) -> None:
        """The month chosen in the Overview or the Budget; shown when the period is "the month"."""
        if isinstance(month, YearMonth) and self.filters.follow_month(month):
            self.refresh()

    def reveal(self, ref: object, *, act: bool = False) -> None:
        """("filter", account or category, period[, member]) or ("tag", name): the operations behind a number.

        `period` is a month (Overview, Reports), a (start, end) pair of dates, or None for all.
        """
        if self.session is None:
            return
        ledger = self.session.ledger
        match ref:
            case ("tag", str(tag)):
                self.filters.show_tag(ledger, tag)
            case ("filter", account_id, period):
                self.filters.show(ledger, account_id, period)
            case ("filter", account_id, period, member_id):
                self.filters.show(ledger, account_id, period, member_id)

    def reset_filters(self) -> None:
        self.filters.reset()

    def _fill_saved_filters(self) -> None:
        from opesvault.domain.saved_filters import saved

        menu = self.saved_filters.menu()
        if menu is None:
            return
        menu.clear()
        save = menu.addAction("Salvar filtro atual…")
        save.triggered.connect(lambda _=False: self.save_current_filter())
        found = saved(self.session.ledger) if self.session is not None else []
        if found:
            menu.addSeparator()
        for flt in found:
            action = menu.addAction(flt.name)
            action.triggered.connect(lambda _=False, f=flt: self.apply_saved_filter(f))
        if found:
            menu.addSeparator()
            remove = menu.addMenu("Excluir filtro")
            for flt in found:
                action = remove.addAction(flt.name)
                action.triggered.connect(lambda _=False, f=flt: self.delete_saved_filter(f.id))

    def save_current_filter(self) -> None:
        if self.session is None:
            return
        from PySide6.QtWidgets import QInputDialog

        from opesvault.domain.saved_filters import save_filter

        if self.filters.period.currentData() == "custom":
            self.notify("Período personalizado não é salvo. Escolha um período com nome.")
            return
        name, ok = QInputDialog.getText(self, "Salvar filtro", "Nome (ex.: Cartão da Ana este mês):")
        if not ok or not name.strip():
            return
        flt = self.filters.snapshot(name)
        ledger = self.session.ledger
        if run_guarded(self, lambda: save_filter(ledger, flt)):
            self.notify(f"Filtro “{flt.name.strip()}” salvo no cofre.")
            self.changed()

    def apply_saved_filter(self, flt: Any) -> None:
        if self.session is not None:
            self.filters.apply_saved(self.session.ledger, flt)
            self.notify(f"Filtro “{flt.name}” aplicado.")

    def delete_saved_filter(self, filter_id: UUID) -> None:
        if self.session is None:
            return
        from opesvault.domain.saved_filters import delete_filter

        delete_filter(self.session.ledger, filter_id)
        self.notify("Filtro excluído. Ctrl+Z desfaz.")
        self.changed()

    # ── data ────────────────────────────────────────

    def refresh(self) -> None:
        self.filters.fill(self.session.ledger if self.session else None)
        if self.session is None:
            self.model.reset(None, [])
            self.count.setText("")
            self.header.set_subtitle("")
            self.inspector.show_operation(None, None, 0)
            return
        ledger = self.session.ledger
        selected = set(self.selected_ids())
        ops = find_operations(ledger, self.filters.current(ledger))
        self.model.reset(ledger, ops)
        header = self.table.horizontalHeader()
        self.model.sort(header.sortIndicatorSection(), header.sortIndicatorOrder())
        total = len(ledger.operations)
        active = self.filters.active()
        self.count.setText(f"{len(ops)} de {total} lançamentos")
        self.header.set_subtitle(f"{len(ops)} de {total} lançamentos" if active else f"{total} lançamentos")
        self.filters.clear_button.setVisible(active)
        if total == 0:
            self.views.setCurrentWidget(self.empty_new)
        elif not ops:
            self._show_empty()
        else:
            self.views.setCurrentWidget(self.table)
        if selected:
            self._select(selected)
        self._update_selection()

    def _show_empty(self) -> None:
        if self.filters.month_only():
            self.empty.set_text(
                f"Nenhum lançamento em {month_label(self.filters.month)}", "Veja todo o período ou escolha outro mês."
            )
            self.empty_action.setText("Ver todo o período")  # a reset is "Todo o período"
        else:
            self.empty.set_text("Nenhum lançamento com estes filtros", "Ajuste a busca ou limpe os filtros.")
            self.empty_action.setText("Limpar filtros")
        self.views.setCurrentWidget(self.empty)

    # ── selection ───────────────────────────────────

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
            wide = self.width() >= INSPECTOR_MIN_PAGE_WIDTH
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
