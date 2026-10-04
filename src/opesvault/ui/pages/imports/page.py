"""Importar e revisar: queue of documents and side-by-side review (docs/07 §2, RF-05..RF-09).

Three panes: the imported documents, the review of the selected one (facts, checks, items and
their categories) and the original file with the selected item's evidence. Reading files is in
`queue`, the review commands in `review` and the optional local AI in `ai`.
"""

from collections.abc import Callable
from html import escape
from pathlib import Path
from uuid import UUID

from PySide6.QtCore import Qt
from PySide6.QtGui import QKeySequence, QShortcut
from PySide6.QtWidgets import QComboBox, QHeaderView, QSplitter, QStackedWidget, QVBoxLayout, QWidget

from opesvault.domain.model import AccountType
from opesvault.importing import pipeline
from opesvault.importing.model import BatchStatus, ExtractedItem, ImportBatch, ItemKind, ItemStatus
from opesvault.importing.parsers import PARSERS
from opesvault.ui.common import (
    fill_combo,
    fmt,
    fmt_date,
    make_table,
    select_combo,
    select_id,
    selected_id,
    set_rows,
    stretch_column,
)
from opesvault.ui.components import ElidedLabel, EmptyState, button, flow_row, hbox, hbox_widget, menu_button, text
from opesvault.ui.local_ai import AiRunRow
from opesvault.ui.pages.base import Page
from opesvault.ui.pages.documents_page import PdfView
from opesvault.ui.pages.imports.ai import AiAssist
from opesvault.ui.pages.imports.labels import ITEM_STATUS_LABELS, KIND_LABELS, STATUS_LABELS, item_notes
from opesvault.ui.pages.imports.queue import ImportJob, ImportQueue
from opesvault.ui.pages.imports.review import ReviewCommands
from opesvault.ui.theme import SPACE_L, SPACE_S, SPACE_XS, restyle, tokens


class ImportPage(ImportQueue, ReviewCommands, AiAssist, Page):
    title = "Importar e revisar"
    section = "Dia a dia"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.batch_id: UUID | None = None
        self._jobs: set[ImportJob] = set()
        self._queue: list[Path] = []
        self._viewer_document: UUID | None = None
        self._ai_waiting: list[UUID] = []  # imported batches the local AI looks at once the queue is done

        # ── documents (left)
        self.batches = make_table(["Documento", "Situação", "Itens"])
        self.batches.setAccessibleName("Documentos importados")
        self.batches.itemSelectionChanged.connect(self._select_batch)
        self.batches.setMinimumWidth(130)
        stretch_column(self.batches)  # a long file name is cut, the item count stays in view
        self.import_button = button(
            "Importar arquivos…", self.import_files, role="primary", tip="PDF, CSV ou OFX (Ctrl+I); ou arraste para cá"
        )
        coverage = button("Layouts suportados", self.show_coverage, role="plain", tip="Bancos e documentos lidos")
        self.header.add(coverage, self.import_button)
        self.setAcceptDrops(True)  # dropping the files on the page is the natural gesture here

        # ── review (center): document facts, target, actions, items
        self.batch_title = ElidedLabel("", "headline")
        self.batch_info = text("", "caption", wrap=True)
        self.batch_info.setMinimumWidth(130)
        self.batch_info.setTextFormat(Qt.TextFormat.RichText)
        self.target = QComboBox()
        self.target.setAccessibleName("Conta ou cartão do documento")
        self.target.setMinimumContentsLength(14)
        self.target.activated.connect(self._change_target)
        self.layout_choice = QComboBox()
        self.layout_choice.setAccessibleName("Layout")
        choose = button("Usar layout", self._choose_layout)
        self.layout_row = QWidget()
        self.layout_row.setLayout(hbox(text("Layout", "secondary"), self.layout_choice, choose))
        target_row = flow_row(hbox_widget(text("Conta ou cartão", "secondary"), self.target), self.layout_row)

        self.items = make_table(["Situação", "Data", "Descrição", "Tipo", "Valor", "Categoria", "Observações"])
        self.items.setAccessibleName("Itens extraídos")
        # Description and notes share the room, so the table never scrolls sideways on a wide window.
        for column in (2, 6):
            self.items.horizontalHeader().setSectionResizeMode(column, QHeaderView.ResizeMode.Stretch)
        self.items.horizontalHeader().setStretchLastSection(False)
        self.items.itemSelectionChanged.connect(self._select_item)
        approve_all = button(
            "Aprovar prontos",
            self.approve_all,
            role="primary",
            tip="Cria os lançamentos dos itens prontos (Ctrl+Shift+Enter)",
        )
        approve_one = button("Aprovar selecionado", self.approve_selected, tip="Ctrl+Enter")
        correct = button("Corrigir…", self.correct, tip="F2")
        more = menu_button(
            "Mais",
            [
                ("Manter separado…", self.keep_separate, "Ctrl+M"),
                ("Criar regra a partir do item…", self.create_rule, "Ctrl+R"),
                None,
                ("Rejeitar item…", self.reject, "Del"),
            ],
        )
        for keys, slot in (
            (("Ctrl+Shift+Return", "Ctrl+Shift+Enter"), self.approve_all),
            (("Ctrl+Return", "Ctrl+Enter"), self.approve_selected),
            (("F2",), self.correct),
            (("Ctrl+M",), self.keep_separate),
            (("Delete",), self.reject),
            (("Ctrl+I",), self.import_files),
            (("Ctrl+K",), self.focus_target),
            (("Ctrl+R",), self.create_rule),
        ):
            self._shortcut(keys, slot)
        # Shown only when the local AI is turned on (Configurações › IA local).
        self.ai_button = button(
            "Sugerir com IA",
            self.suggest_ai,
            tip="Ollama local: sugere categorias para os itens sem categoria; nada é aprovado sozinho",
        )
        self.ai_button.hide()
        self.review_actions = (approve_all, approve_one, correct, more)
        self.approve_all_button = approve_all
        actions = flow_row(approve_all, approve_one, correct, self.ai_button, more)

        # While the model answers, the review stays usable; this row says how far it got.
        self.ai_row = AiRunRow(self)

        review = QWidget()
        review_layout = QVBoxLayout(review)
        review_layout.setContentsMargins(SPACE_L, 0, SPACE_L, 0)
        review_layout.setSpacing(SPACE_S)
        review_layout.addWidget(self.batch_title)
        review_layout.addWidget(self.batch_info)
        review_layout.addSpacing(SPACE_S)
        review_layout.addWidget(target_row)
        review_layout.addWidget(actions)
        review_layout.addWidget(self.ai_row)
        review_layout.addSpacing(SPACE_XS)
        # Offered right after a category is picked by hand: the moment a rule saves time.
        self.rule_offer_text = text("", wrap=True)
        self.rule_offer = QWidget()
        self.rule_offer.setObjectName("FilterChip")
        self.rule_offer.setLayout(
            hbox(
                self.rule_offer_text,
                None,
                button("Criar regra…", self._accept_rule_offer, role="primary"),
                button("Agora não", self._dismiss_rule_offer, role="plain"),
            )
        )
        self.rule_offer.layout().setContentsMargins(SPACE_S, SPACE_XS, SPACE_S, SPACE_XS)  # type: ignore[union-attr]
        self.rule_offer.hide()
        self._offered_item: UUID | None = None
        review_layout.addWidget(self.rule_offer)
        review_layout.addWidget(self.items, 1)
        self.review_empty = EmptyState("Selecione um documento", "Os itens extraídos aparecem aqui para revisão.")
        self.review_stack = QStackedWidget()
        self.review_stack.addWidget(review)
        self.review_stack.addWidget(self.review_empty)

        # ── original document (right): the evidence of the selected item
        self.viewer = PdfView()
        self.viewer.setMinimumWidth(150)
        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.setChildrenCollapsible(False)
        splitter.addWidget(self.batches)
        splitter.addWidget(self.review_stack)
        splitter.addWidget(self.viewer)
        # extra room on a wide window goes mostly to the review and to the original document
        for index, stretch in enumerate((1, 4, 3)):
            splitter.setStretchFactor(index, stretch)
        splitter.setSizes([230, 640, 380])
        # Narrow windows: the side panes can be dragged closed; the review never shrinks away.
        splitter.setCollapsible(0, True)
        splitter.setCollapsible(2, True)
        self.empty = EmptyState(
            "Nenhum documento importado",
            "Importe faturas de cartão, extratos e notas de corretagem em PDF, CSV ou OFX. "
            "Cada item é revisado aqui antes de virar lançamento; o arquivo original fica guardado no cofre. "
            "Você também pode arrastar os arquivos para esta janela.",
            [button("Importar arquivos…", self.import_files)],
        )
        self.views = QStackedWidget()
        self.views.addWidget(splitter)
        self.views.addWidget(self.empty)
        layout = self.page_layout()
        layout.addWidget(self.views, 1)

    # ── data ────────────────────────────────────────

    def refresh(self) -> None:
        if self.session is None:
            self.ai_row.stop()  # the vault closed: what is still being asked is no longer wanted
            self._ai_waiting.clear()
            self.batches.setRowCount(0)
            self.items.setRowCount(0)
            self.viewer.show_pdf(None)
            self._viewer_document = None
            self.batch_id = None
            self.batch_info.setText("")
            return
        ledger = self.session.ledger
        rows = []
        for batch in sorted(pipeline.batches(ledger).values(), key=lambda b: b.created_at, reverse=True):
            name = self.session.document(batch.document_id).meta.original_name
            batch_items = pipeline.items_of(ledger, batch.id)
            check = "—"
            if batch.reconciliations:
                check = (
                    "ok"
                    if all(r.ok for r in batch.reconciliations)
                    else ("divergente" if any(r.ok is False for r in batch.reconciliations) else "não comparável")
                )
            rows.append(
                (
                    [
                        name,
                        STATUS_LABELS[batch.status] + (" · total divergente" if check == "divergente" else ""),
                        str(len(batch_items)),
                    ],
                    batch.id,
                )
            )
        set_rows(self.batches, rows)
        self.views.setCurrentIndex(0 if rows else 1)
        waiting = sum(
            1 for i in pipeline.items(ledger).values() if i.status in (ItemStatus.READY, ItemStatus.NEEDS_REVIEW)
        )
        self.header.set_subtitle(f"{len(rows)} documento(s) · {waiting} item(ns) aguardando revisão" if rows else "")
        if self.batch_id is None and rows:
            self.batch_id = rows[0][1]  # open on the most recent document
        self._reselect_batch()
        self._show_batch()

    def _reselect_batch(self) -> None:
        self.batches.blockSignals(True)  # the same document again: nothing to reload
        select_id(self.batches, self.batch_id)
        self.batches.blockSignals(False)

    def _batch(self) -> ImportBatch | None:
        if self.session is None or self.batch_id is None:
            return None
        return pipeline.batches(self.session.ledger).get(self.batch_id)

    def reveal(self, ref: object, *, act: bool = False) -> None:
        """An import alert: open the document waiting for review."""
        if select_id(self.batches, ref):
            self.items.setFocus()  # ready for Ctrl+Enter

    def _primary(self, reviewing: bool) -> None:
        """One primary action at a time: approving while a document is open, importing otherwise."""
        self.import_button.setProperty("role", "" if reviewing else "primary")
        self.approve_all_button.setProperty("role", "primary" if reviewing else "")
        for widget in (self.import_button, self.approve_all_button):
            restyle(widget)

    def show_coverage(self) -> None:
        from opesvault.ui.coverage import CoverageDialog

        dialog = CoverageDialog(self)
        dialog.exec()
        dialog.deleteLater()

    def _select_batch(self) -> None:
        self.batch_id = selected_id(self.batches)
        self._show_batch()

    def _load_viewer(self, batch: ImportBatch | None) -> None:
        """Shows the batch's original file; skipped when it is already on screen."""
        document_id = batch.document_id if batch is not None else None
        if document_id == self._viewer_document or self.session is None:
            return
        self._viewer_document = document_id
        if batch is None:
            self.viewer.show_pdf(None)
            return
        document = self.session.document(batch.document_id)
        if document.meta.original_name.lower().endswith(".pdf"):
            self.viewer.show_pdf(document.data)
        else:
            self.viewer.show_pdf(None)
            self.viewer.image.setText("Arquivo estruturado: a linha de origem de cada item aparece aqui.")

    def _show_batch(self) -> None:
        batch = self._batch()
        self._load_viewer(batch)
        if batch is None or self.session is None:
            self.items.setRowCount(0)
            self.review_stack.setCurrentWidget(self.review_empty)
            self._primary(False)
            return
        self.review_stack.setCurrentIndex(0)
        self._primary(True)
        ledger = self.session.ledger
        h = batch.header
        self.batch_title.setText(self.session.document(batch.document_id).meta.original_name)
        parts = [h.institution or "Instituição não identificada", STATUS_LABELS[batch.status]]
        if batch.parser_id:
            parts.append(f"layout {batch.parser_id} v{batch.parser_version}")
        if h.due_on:
            parts.append(f"vencimento {fmt_date(h.due_on)}")
        if h.total is not None:
            parts.append(f"total {fmt(h.total)}")
        if h.period_start or h.period_end:
            parts.append(f"período {fmt_date(h.period_start)} a {fmt_date(h.period_end)}")
        if h.net_amount is not None:
            parts.append(f"líquido {fmt(h.net_amount)}")
        t = tokens()
        # One line of facts, then each check with its verdict in words (tone only reinforces it).
        lines = [escape(" · ".join(parts))]
        for r in batch.reconciliations:
            verdict, color = {
                True: ("confere", t.positive),
                False: ("diverge", t.negative),
                None: ("não comparável", t.secondary),
            }[r.ok]
            lines.append(
                f"{escape(r.label)}: documento {fmt(r.expected)}, calculado {fmt(r.computed)} · "
                f'<span style="color:{color}; font-weight:600">{verdict}</span>'
            )
        if batch.unmapped_lines:
            lines.append(f"{batch.unmapped_lines} linha(s) não mapeada(s) preservadas no original.")
        lines.extend(f'<span style="color:{t.warning}">Atenção: {escape(w)}</span>' for w in batch.warnings)
        self.batch_info.setText("<br>".join(lines))
        self._update_ai_button(batch)

        self.target.blockSignals(True)
        if batch.doc_type is not None and batch.doc_type.value == "card_statement":
            fill_combo(self.target, [(c.name, ("card", c.id)) for c in ledger.cards.values()], empty="(escolha)")
            chosen: tuple[str, UUID | None] = ("card", batch.card_id)
        else:
            fill_combo(
                self.target,
                [
                    (a.name, ("account", a.id))
                    for a in sorted(ledger.accounts.values(), key=lambda a: a.name)
                    if a.is_liquid
                ],
                empty="(escolha)",
            )
            chosen = ("account", batch.account_id)
        self.target.setCurrentIndex(0)
        select_combo(self.target, chosen)
        self.target.blockSignals(False)
        fill_combo(self.layout_choice, [(f"{p.institution} — {p.product} ({p.id})", p.id) for p in PARSERS])
        needs_layout = batch.status in (BatchStatus.AMBIGUOUS, BatchStatus.UNSUPPORTED)
        self.layout_choice.setEnabled(needs_layout)
        self.layout_row.setVisible(needs_layout)  # only when the user has a decision to make

        rows = []
        batch_items = sorted(pipeline.items_of(ledger, batch.id), key=lambda i: (i.occurred_on is None, i.occurred_on))
        for item in batch_items:
            target = ledger.accounts.get(item.target_account_id) if item.target_account_id else None
            target_name = target.name if target else "—"
            rows.append(
                (
                    [
                        ITEM_STATUS_LABELS[item.status],
                        fmt_date(item.occurred_on),
                        item.description,
                        KIND_LABELS[item.kind],
                        fmt(item.amount),
                        target_name,
                        item_notes(item),
                    ],
                    item.id,
                )
            )
        set_rows(self.items, rows)
        self._install_target_editors(batch_items)

    def _install_target_editors(self, batch_items: list[ExtractedItem]) -> None:
        """A category/counterpart selector per pending row."""
        assert self.session is not None
        ledger = self.session.ledger
        by_id = {i.id: i for i in batch_items}
        expense = [(a.name, a.id) for a in ledger.categories(AccountType.EXPENSE)]
        income = [(a.name, a.id) for a in ledger.categories(AccountType.INCOME)]
        balance = [
            (f"↔ {a.name}", a.id)
            for a in sorted(ledger.accounts.values(), key=lambda a: a.name)
            if a.type in (AccountType.ASSET, AccountType.LIABILITY)
        ]
        for row in range(self.items.rowCount()):
            cell = self.items.item(row, 0)
            item = by_id.get(cell.data(Qt.ItemDataRole.UserRole)) if cell else None
            if item is None or item.status not in (ItemStatus.READY, ItemStatus.NEEDS_REVIEW):
                continue
            if item.kind in (ItemKind.TRADE, ItemKind.FEE):
                continue
            options = {
                ItemKind.CREDIT: income + balance,
                ItemKind.DEBIT: expense + balance,
                ItemKind.CARD_PAYMENT: balance,
            }.get(item.kind, expense)
            combo = QComboBox()
            combo.setAccessibleName(f"Categoria ou conta de {item.description}")
            fill_combo(combo, options, empty="(padrão)")
            combo.setCurrentIndex(0)
            select_combo(combo, item.target_account_id)
            combo.currentIndexChanged.connect(lambda _=0, c=combo, i=item.id: self._set_target(i, c.currentData()))
            self.items.setCellWidget(row, 5, combo)
        # Cell widgets set after the columns were sized sit at the corner until the view lays them out.
        self.items.updateGeometries()

    def _select_item(self) -> None:
        item_id = selected_id(self.items)
        if self.session is None or item_id is None:
            return
        ledger = self.session.ledger
        item = pipeline.items(ledger).get(item_id)
        if item is None or not item.evidence_ids:
            return
        ev = pipeline.evidence(ledger).get(item.evidence_ids[0])
        if ev is None:
            return
        document = self.session.document(ev.document_id)
        if ev.page is not None:
            self.viewer.show_pdf(document.data, ev.page, ev.bbox)
        else:
            self.viewer.image.setText(f"Linha {ev.line} do arquivo:\n{ev.text}")

    def _shortcut(self, keys: tuple[str, ...], slot: Callable[[], None]) -> None:
        for key in keys:
            shortcut = QShortcut(QKeySequence(key), self)
            shortcut.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
            shortcut.activated.connect(slot)
