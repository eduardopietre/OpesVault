"""Importar e revisar: queue of documents and side-by-side review (docs/07 §2, RF-05..RF-09)."""

import threading
from collections.abc import Callable
from html import escape
from pathlib import Path
from typing import TYPE_CHECKING, Any
from uuid import UUID

from PySide6.QtCore import QMimeData, QObject, QRunnable, Qt, QThreadPool, Signal
from PySide6.QtGui import QDragEnterEvent, QDropEvent, QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QInputDialog,
    QLineEdit,
    QMessageBox,
    QProgressBar,
    QSplitter,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from opesvault.domain.ledger import DomainError
from opesvault.domain.model import AccountSubtype, AccountType
from opesvault.importing import pipeline, rules
from opesvault.importing.model import BatchStatus, ExtractedItem, ImportBatch, ItemKind, ItemStatus
from opesvault.importing.parsers import PARSERS
from opesvault.importing.pipeline import ImportRequest
from opesvault.importing.source import PROBLEM_MESSAGES, SourceError, SourceProblem
from opesvault.ui.background import BackgroundJob
from opesvault.ui.common import fill_combo, fmt, fmt_date, make_table, read_money, run_guarded, selected_id, set_rows
from opesvault.ui.components import EmptyState, button, flow_row, hbox, hbox_widget, menu_button, text
from opesvault.ui.dialogs import FormDialog, ask_reason
from opesvault.ui.pages.base import Page
from opesvault.ui.pages.documents_page import PdfView
from opesvault.ui.theme import SPACE_L, SPACE_S, SPACE_XS, restyle, tokens

if TYPE_CHECKING:
    from opesvault.ai.ollama import OllamaClient

STATUS_LABELS = {
    BatchStatus.UNSUPPORTED: "Não suportado",
    BatchStatus.AMBIGUOUS: "Escolher layout",
    BatchStatus.IN_REVIEW: "Em revisão",
    BatchStatus.PARTIAL: "Parcial",
    BatchStatus.APPROVED: "Aprovado",
    BatchStatus.REJECTED: "Rejeitado",
}
ITEM_STATUS_LABELS = {
    ItemStatus.NEEDS_REVIEW: "Revisar",
    ItemStatus.READY: "Pronto",
    ItemStatus.APPROVED: "Aprovado",
    ItemStatus.REJECTED: "Rejeitado",
    ItemStatus.DUPLICATE: "Já registrado",
}
KIND_LABELS = {
    ItemKind.PURCHASE: "Compra",
    ItemKind.CARD_CREDIT: "Crédito/estorno",
    ItemKind.CARD_PAYMENT: "Pagamento",
    ItemKind.CARD_CHARGE: "Encargo",
    ItemKind.DEBIT: "Saída",
    ItemKind.CREDIT: "Entrada",
    ItemKind.TRADE: "Negócio",
    ItemKind.FEE: "Custo",
}
SOURCE_LABELS = {"history": "sugestão (histórico)", "rule": "sugestão (regra padrão)"}


def source_label(source: str) -> str:
    if source.startswith("user_rule:"):
        return "sugestão (sua regra)"
    if source.startswith("ollama:"):
        # "ollama:<model>:<prompt>[@digest]": the model name is what a person recognizes.
        model = source.removeprefix("ollama:").split("@")[0].rsplit(":", 1)[0]
        return f"sugestão (IA local, {model})"
    return SOURCE_LABELS.get(source, f"sugestão ({source})")


class _ImportSignals(QObject):
    done = Signal(object)


class _ImportJob(QRunnable):
    """Extraction runs off the UI thread (RNF-05); the page stays disabled meanwhile."""

    def __init__(self, fn: Any) -> None:
        super().__init__()
        self.fn = fn
        self.signals = _ImportSignals()

    def run(self) -> None:
        try:
            result: object = self.fn()
        except (SourceError, DomainError) as exc:  # classified: shown to the user as such
            result = exc
        except Exception as exc:  # reported per file; one failure never affects the others
            from opesvault.diagnostics import record

            record("IMPORT_FAILED", exc)
            result = exc
        self.signals.done.emit(result)


class ItemDialog(FormDialog):
    def __init__(self, parent: QWidget, item: ExtractedItem) -> None:
        super().__init__(parent, "Corrigir item", "Corrigir")
        from opesvault.ui.common import date_edit

        self.description = QLineEdit(item.description)
        self.amount = QLineEdit("" if item.amount is None else fmt(item.amount).replace("R$ ", ""))
        self.when = date_edit(item.occurred_on)
        self.reason = QLineEdit()
        self.form.addRow("Descrição:", self.description)
        self.form.addRow("Valor:", self.amount)
        self.form.addRow("Data:", self.when)
        self.form.addRow("Motivo:", self.reason)

    def validate(self) -> None:
        read_money(self.amount)
        if not self.reason.text().strip():
            raise DomainError("Informe o motivo da correção.")


class ImportPage(Page):
    title = "Importar e revisar"
    section = "Dia a dia"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.batch_id: UUID | None = None
        self._jobs: set[_ImportJob] = set()
        self._queue: list[Path] = []
        self._viewer_document: UUID | None = None
        self._ai_job: BackgroundJob | None = None
        self._ai_cancel = threading.Event()
        self._ai_waiting: list[UUID] = []  # imported batches the local AI looks at once the queue is done

        # ── documents (left)
        self.batches = make_table(["Documento", "Situação", "Itens"])
        self.batches.setAccessibleName("Documentos importados")
        self.batches.itemSelectionChanged.connect(self._select_batch)
        self.batches.setMinimumWidth(160)
        self.import_button = button(
            "Importar arquivos…", self.import_files, role="primary", tip="PDF, CSV ou OFX (Ctrl+I); ou arraste para cá"
        )
        coverage = button("Layouts suportados", self.show_coverage, role="plain", tip="Bancos e documentos lidos")
        self.header.add(coverage, self.import_button)
        self.setAcceptDrops(True)  # dropping the files on the page is the natural gesture here

        # ── review (center): document facts, target, actions, items
        self.batch_title = text("", "headline")
        self.batch_info = text("", "caption", wrap=True)
        self.batch_info.setMinimumWidth(160)
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
        self.ai_label = text("", "caption")
        self.ai_progress = QProgressBar()
        self.ai_progress.setTextVisible(False)
        self.ai_progress.setAccessibleName("Progresso da IA local")
        self.ai_row = QWidget()
        self.ai_row.setLayout(
            hbox(
                self.ai_label,
                self.ai_progress,
                button("Cancelar", self.cancel_ai, role="plain", tip="Para ao fim do lote atual"),
            )
        )
        self.ai_row.hide()

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
        self.viewer.setMinimumWidth(200)
        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.setChildrenCollapsible(False)
        splitter.addWidget(self.batches)
        splitter.addWidget(self.review_stack)
        splitter.addWidget(self.viewer)
        splitter.setStretchFactor(1, 1)
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
            self._ai_cancel.set()  # the vault closed: what is still being asked is no longer wanted
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
        for row in range(self.batches.rowCount()):
            cell = self.batches.item(row, 0)
            if cell is not None and cell.data(Qt.ItemDataRole.UserRole) == self.batch_id:
                self.batches.blockSignals(True)
                self.batches.selectRow(row)
                self.batches.blockSignals(False)
                return

    def _batch(self) -> ImportBatch | None:
        if self.session is None or self.batch_id is None:
            return None
        return pipeline.batches(self.session.ledger).get(self.batch_id)

    def reveal(self, ref: object, *, act: bool = False) -> None:
        """An import alert: open the document waiting for review."""
        for row in range(self.batches.rowCount()):
            item = self.batches.item(row, 0)
            if item is not None and item.data(Qt.ItemDataRole.UserRole) == ref:
                self.batches.selectRow(row)
                self.items.setFocus()  # ready for Ctrl+Enter
                return

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

    def dragEnterEvent(self, event: QDragEnterEvent) -> None:  # noqa: N802 - Qt override
        if self.session is not None and self._dropped_paths(event.mimeData()):
            event.acceptProposedAction()

    def dropEvent(self, event: QDropEvent) -> None:  # noqa: N802 - Qt override
        paths = self._dropped_paths(event.mimeData())
        if self.session is None or not paths:
            return
        event.acceptProposedAction()
        self.import_paths(paths)

    def import_paths(self, paths: list[Path]) -> None:
        """Files dropped here or anywhere on the window: the same queue as "Importar arquivos…"."""
        self._queue.extend(paths)
        self._next_import()

    @staticmethod
    def _dropped_paths(mime: QMimeData) -> list[Path]:
        suffixes = {".pdf", ".csv", ".ofx", ".txt"}
        return [
            Path(url.toLocalFile())
            for url in mime.urls()
            if url.isLocalFile() and Path(url.toLocalFile()).suffix.lower() in suffixes
        ]

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
            index = self.target.findData(("card", batch.card_id))
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
            index = self.target.findData(("account", batch.account_id))
        self.target.setCurrentIndex(max(index, 0))
        self.target.blockSignals(False)
        fill_combo(self.layout_choice, [(f"{p.institution} — {p.product} ({p.id})", p.id) for p in PARSERS])
        needs_layout = batch.status in (BatchStatus.AMBIGUOUS, BatchStatus.UNSUPPORTED)
        self.layout_choice.setEnabled(needs_layout)
        self.layout_row.setVisible(needs_layout)  # only when the user has a decision to make

        rows = []
        batch_items = sorted(pipeline.items_of(ledger, batch.id), key=lambda i: (i.occurred_on is None, i.occurred_on))
        for item in batch_items:
            notes = [*item.warnings]
            if item.installment:
                notes.append(f"parcela {item.installment[0]}/{item.installment[1]}")
            if item.foreign_amount is not None:
                notes.append(f"{item.foreign_currency} {item.foreign_amount}")
            if item.card_last4:
                notes.append(f"cartão final {item.card_last4}")
            if item.suggestion_source:
                notes.append(source_label(item.suggestion_source))
            if item.status is ItemStatus.DUPLICATE:
                notes.append("já existe no livro: aprovar só vincula a evidência")
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
                        "; ".join(notes),
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
            index = combo.findData(item.target_account_id)
            combo.setCurrentIndex(max(index, 0))
            combo.currentIndexChanged.connect(lambda _=0, c=combo, i=item.id: self._set_target(i, c.currentData()))
            self.items.setCellWidget(row, 5, combo)
        # Cell widgets set after the columns were sized sit at the corner until the view lays them out.
        self.items.updateGeometries()

    def _set_target(self, item_id: UUID, target: UUID | None) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        if run_guarded(self, lambda: pipeline.correct_item(ledger, item_id, "target_account_id", target)):
            self.changed()
            self._offer_rule(item_id)

    # ── categorization rules ────────────────────────

    def _offer_rule(self, item_id: UUID) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        item = pipeline.items(ledger).get(item_id)
        target = ledger.accounts.get(item.target_account_id) if item and item.target_account_id else None
        if item is None or target is None or target.subtype is not AccountSubtype.CATEGORY:
            self._dismiss_rule_offer()
            return
        self._offered_item = item_id
        pattern = rules.suggest_pattern(item.description)
        self.rule_offer_text.setText(f"Usar sempre “{target.name}” para descrições com “{pattern}”?")
        self.rule_offer.show()

    def _accept_rule_offer(self) -> None:
        item_id = self._offered_item
        self._dismiss_rule_offer()
        if item_id is not None:
            self.create_rule(item_id)

    def _dismiss_rule_offer(self) -> None:
        self._offered_item = None
        self.rule_offer.hide()

    def create_rule(self, item_id: UUID | None = None) -> None:
        """Ctrl+R: a rule from the selected item (its description and chosen category)."""
        if self.session is None:
            return
        from opesvault.ui.rule_dialog import RuleDialog

        ledger = self.session.ledger
        item_id = item_id or selected_id(self.items)
        item = pipeline.items(ledger).get(item_id) if item_id else None
        if item is None:
            QMessageBox.information(self, "Regra", "Selecione um item para criar a regra a partir dele.")
            return
        batch = pipeline.batches(ledger).get(item.batch_id)
        dialog = RuleDialog(
            self,
            ledger,
            description=item.description,
            target_id=item.target_account_id,
            account_id=batch.account_id if batch else None,
        )
        if not dialog.exec():
            return
        result = run_guarded(self, lambda: dialog.apply(from_item=item.id))
        if result:
            _, changed = result
            self.notify(f"Regra criada. {changed} item(ns) pendente(s) recategorizado(s).")
            self.changed()

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

    # ── keyboard review ─────────────────────────────

    def _shortcut(self, keys: tuple[str, ...], slot: Callable[[], None]) -> None:
        for key in keys:
            shortcut = QShortcut(QKeySequence(key), self)
            shortcut.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
            shortcut.activated.connect(slot)

    def focus_target(self) -> None:
        """Ctrl+K: open the category selector of the current item."""
        row = self.items.currentRow()
        combo = self.items.cellWidget(row, 5) if row >= 0 else None
        if isinstance(combo, QComboBox):
            combo.setFocus()
            combo.showPopup()

    def _after_item_action(self, row: int) -> None:
        """Keep the keyboard flow: after acting on an item, select the next one."""
        self.changed()
        if self.items.rowCount():
            self.items.selectRow(min(row + 1, self.items.rowCount() - 1))
            self.items.setFocus()

    # ── actions ─────────────────────────────────────

    def import_files(self) -> None:
        if self.session is None:
            return
        names, _ = QFileDialog.getOpenFileNames(self, "Importar documentos", "", "Documentos (*.pdf *.csv *.ofx *.txt)")
        # One at a time: two imports must never mutate the same session concurrently.
        self._queue.extend(Path(name) for name in names)
        self._next_import()

    def _next_import(self) -> None:
        if self._jobs or self._ai_job is not None or self.session is None:
            return
        if self._queue:
            self._import_one(self._queue.pop(0), None)
        elif self._ai_waiting:
            waiting, self._ai_waiting = self._ai_waiting, []
            self._start_ai(waiting, quiet=True)

    def _import_one(self, path: Path, password: str | None) -> None:
        assert self.session is not None
        session = self.session
        data = path.read_bytes()
        request = ImportRequest(name=path.name, data=data, password=password)
        job = _ImportJob(lambda: pipeline.import_document(session, request))
        self._jobs.add(job)
        self.setEnabled(False)
        self.set_busy(True)
        self._warm_up_ai()  # the model loads while the document is read

        def done(result: object) -> None:
            self._jobs.discard(job)
            self.setEnabled(True)
            self.set_busy(False)
            if isinstance(result, SourceError) and result.problem in (
                SourceProblem.PASSWORD_REQUIRED,
                SourceProblem.WRONG_PASSWORD,
            ):
                label = PROBLEM_MESSAGES[result.problem] + f"\n{path.name}\nSenha do PDF (não será guardada):"
                pdf_password, ok = QInputDialog.getText(self, "PDF protegido", label, QLineEdit.EchoMode.Password)
                if ok and pdf_password:
                    self._import_one(path, pdf_password)
                else:
                    self._next_import()
                return
            if isinstance(result, DomainError):
                QMessageBox.information(self, "Importação", f"{path.name}: {result}")
            elif isinstance(result, Exception):
                QMessageBox.warning(self, "Importação", f"{path.name}: falha ao processar o arquivo.")
            elif isinstance(result, ImportBatch):
                self.batch_id = result.id
                self._ai_waiting.append(result.id)
            self.changed()
            self._next_import()

        job.signals.done.connect(done)
        QThreadPool.globalInstance().start(job)

    def _change_target(self) -> None:
        batch = self._batch()
        data = self.target.currentData()
        if batch is None or self.session is None or data is None:
            return
        kind, target_id = data
        ledger = self.session.ledger
        if run_guarded(
            self,
            lambda: pipeline.set_batch_target(
                ledger, batch.id, target_id if kind == "account" else None, target_id if kind == "card" else None
            ),
        ):
            self.changed()

    def _choose_layout(self) -> None:
        batch = self._batch()
        if batch is None or self.session is None:
            return
        session = self.session
        parser_id = self.layout_choice.currentData()
        password: str | None = None
        while True:
            try:
                result = run_guarded(self, lambda pw=password: pipeline.reparse_with(session, batch.id, parser_id, pw))
                break
            except SourceError as exc:  # protected PDF: the password was used once at import, never kept
                if exc.problem not in (SourceProblem.PASSWORD_REQUIRED, SourceProblem.WRONG_PASSWORD):
                    QMessageBox.information(self, "Importação", PROBLEM_MESSAGES.get(exc.problem, "Arquivo inválido."))
                    return
                label = PROBLEM_MESSAGES[exc.problem] + "\nSenha do PDF (não será guardada):"
                typed, ok = QInputDialog.getText(self, "PDF protegido", label, QLineEdit.EchoMode.Password)
                if not ok or not typed:
                    return
                password = typed
        if isinstance(result, ImportBatch):
            self.batch_id = result.id
            self.changed()

    def _approve(self, item_ids: list[UUID] | None) -> bool:
        batch = self._batch()
        if batch is None or self.session is None:
            return False
        ledger = self.session.ledger
        divergence = None
        if any(r.ok is False for r in batch.reconciliations):
            divergence = ask_reason(self, "Total divergente — aceitar como pendência documentada")
            if divergence is None:
                return False
        partial = None
        if item_ids is not None:
            partial = ask_reason(self, "Aprovação parcial")
            if partial is None:
                return False
        result = run_guarded(
            self,
            lambda: pipeline.approve(ledger, batch.id, item_ids, accept_divergence=divergence, partial_reason=partial),
        )
        if result is None:
            return False
        if item_ids is None:
            QMessageBox.information(
                self,
                "Aprovação",
                f"{result.created} operação(ões) criada(s), {result.linked} evidência(s) vinculada(s).",
            )
            self.changed()
        return True

    def approve_all(self) -> None:
        self._approve(None)

    def approve_selected(self) -> None:
        item_id = selected_id(self.items)
        if item_id is not None:
            row = self.items.currentRow()
            if self._approve([item_id]):
                self._after_item_action(row)

    def correct(self) -> None:
        item_id = selected_id(self.items)
        if self.session is None or item_id is None:
            return
        ledger = self.session.ledger
        item = pipeline.items(ledger)[item_id]
        dialog = ItemDialog(self, item)
        if not dialog.exec():
            return
        from opesvault.ui.common import from_qdate

        reason = dialog.reason.text().strip()

        def apply() -> bool:
            new_amount = read_money(dialog.amount)
            if new_amount is not None and new_amount < 0:
                raise DomainError("Informe o valor sem sinal; o tipo indica a direção.")
            for field, value in (
                ("description", dialog.description.text().strip()),
                ("amount", new_amount),
                ("occurred_on", from_qdate(dialog.when.date())),
            ):
                if getattr(pipeline.items(ledger)[item_id], field) != value:
                    pipeline.correct_item(ledger, item_id, field, value, reason)
            return True

        if run_guarded(self, apply):
            self.changed()

    def keep_separate(self) -> None:
        item_id = selected_id(self.items)
        if self.session is None or item_id is None:
            return
        row = self.items.currentRow()
        reason = ask_reason(self, "Manter como lançamento separado")
        ledger = self.session.ledger
        if reason and run_guarded(self, lambda: pipeline.keep_separate(ledger, item_id, reason) or True):
            self._after_item_action(row)

    def reject(self) -> None:
        item_id = selected_id(self.items)
        if self.session is None or item_id is None:
            return
        row = self.items.currentRow()
        reason = ask_reason(self, "Rejeitar item")
        ledger = self.session.ledger
        if reason and run_guarded(self, lambda: pipeline.reject_items(ledger, [item_id], reason) or True):
            self._after_item_action(row)

    # ── local AI ────────────────────────────────────

    def _ai_client(self) -> "OllamaClient | None":
        from opesvault.ai.ollama import AiUnavailable
        from opesvault.importing.ai_suggestions import client_from_settings

        if self.session is None:
            return None
        try:
            return client_from_settings(self.session.ledger)
        except AiUnavailable:
            return None

    def _update_ai_button(self, batch: ImportBatch | None) -> None:
        from opesvault.importing.ai_suggestions import pending_count

        client = self._ai_client()
        self.ai_button.setVisible(client is not None)
        if client is None or batch is None or self.session is None:
            return
        count = pending_count(self.session.ledger, batch.id)
        running = self._ai_job is not None
        self.ai_button.setEnabled(bool(count) and not running and not self._jobs)
        self.ai_button.setText(f"Sugerir com IA ({count})" if count else "Sugerir com IA")
        self.ai_button.setToolTip(
            f"{client.model} no Ollama local: sugere categorias para os itens sem categoria; nada é aprovado sozinho"
            if count
            else "Todos os itens deste documento já têm categoria"
        )

    def _warm_up_ai(self) -> None:
        client = self._ai_client()
        if client is not None:
            threading.Thread(target=client.warm_up, name="ollama-warm-up", daemon=True).start()

    def suggest_ai(self) -> None:
        """The button: asks about the open document and says plainly when the AI cannot help."""
        batch = self._batch()
        if batch is None or self.session is None or self._jobs or self._ai_job is not None:
            return
        if self._ai_client() is None:
            QMessageBox.information(
                self, "IA local", "A assistência por IA está desligada ou sem modelo escolhido (Configurações)."
            )
            return
        self._start_ai([batch.id], quiet=False)

    def cancel_ai(self) -> None:
        if self._ai_job is not None:
            self._ai_cancel.set()
            self.ai_label.setText("Cancelando ao fim do lote atual…")

    def _start_ai(self, batch_ids: list[UUID], *, quiet: bool) -> None:
        """Asks the model in the background. The page stays usable: only items still without a
        category when the answer arrives are filled, so a choice made meanwhile always wins.

        `quiet` (after an import): problems go to the status bar instead of a dialog.
        """
        from opesvault.ai.ollama import AiUnavailable
        from opesvault.importing.ai_suggestions import AiOutcome, apply_suggestions, ask, plan_requests, remember_used

        client = self._ai_client()
        session = self.session
        if client is None or session is None:
            return
        ledger = session.ledger
        known = pipeline.batches(ledger)
        requests = [r for b in batch_ids if b in known for r in plan_requests(ledger, b)]
        if not requests:
            if not quiet:
                self.notify("IA local: nenhum item sem categoria neste documento.")
            return
        cancel = self._ai_cancel = threading.Event()
        remember_used(client)

        def work(report: Callable[[int, int], None]) -> object:
            try:
                client.check_model()  # fails fast, saying what to install, before any batch
                return ask(client, requests, on_progress=report, cancel=cancel)
            except AiUnavailable as exc:  # expected: Ollama off, model missing, odd answers
                return exc

        total = sum(len(r.descriptions) for r in requests)
        job = BackgroundJob(work)
        self._ai_job = job
        self.ai_progress.setRange(0, total)
        self.ai_progress.setValue(0)
        self.ai_label.setText(f"IA local ({client.model}): 0 de {total} descrição(ões)")
        self.ai_row.show()
        self._update_ai_button(self._batch())

        def progress(done: int, of: int) -> None:
            self.ai_progress.setValue(done)
            if not cancel.is_set():
                self.ai_label.setText(f"IA local ({client.model}): {done} de {of} descrição(ões)")

        def done(result: object) -> None:
            self._ai_job = None
            self.ai_row.hide()
            if self.session is not session:  # the vault was closed meanwhile
                return
            if isinstance(result, AiOutcome):
                count = apply_suggestions(ledger, result.planned)
                message = f"IA local: {count} categoria(s) sugerida(s)"
                if result.cancelled:
                    message += ", consulta cancelada"
                elif result.failed:
                    message += f"; {result.failed} item(ns) sem resposta válida"
                self.notify(message + (". Revise antes de aprovar." if count else "."))
                if count:
                    self.changed()  # one undo step for the whole answer
                else:
                    self.refresh()
            else:
                reason = str(result) if isinstance(result, AiUnavailable) else "A consulta falhou."
                if quiet:
                    self.notify(f"IA local: {reason}")
                else:
                    QMessageBox.information(self, "IA local", f"{reason} A revisão manual continua disponível.")
                self.refresh()
            self._update_ai_button(self._batch())
            self._next_import()

        job.signals.progress.connect(progress)
        job.signals.done.connect(done)
        job.start()
