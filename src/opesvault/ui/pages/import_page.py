"""Importar e revisar: queue of documents and side-by-side review (docs/07 §2, RF-05..RF-09)."""

from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import UUID

from PySide6.QtCore import QObject, QRunnable, Qt, QThreadPool, Signal
from PySide6.QtGui import QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from opesvault.domain.ledger import DomainError
from opesvault.domain.model import AccountType
from opesvault.importing import pipeline
from opesvault.importing.model import BatchStatus, ExtractedItem, ImportBatch, ItemKind, ItemStatus
from opesvault.importing.parsers import PARSERS
from opesvault.importing.pipeline import ImportRequest
from opesvault.importing.source import PROBLEM_MESSAGES, SourceError, SourceProblem
from opesvault.ui.common import fill_combo, fmt, fmt_date, make_table, read_money, run_guarded, selected_id, set_rows
from opesvault.ui.dialogs import FormDialog, ask_reason
from opesvault.ui.pages.base import Page
from opesvault.ui.pages.documents_page import PdfView

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
SOURCE_LABELS = {"history": "sugestão (histórico)", "rule": "sugestão (regra)"}


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
        except Exception as exc:  # reported per file; one failure never affects the others
            result = exc
        self.signals.done.emit(result)


class ItemDialog(FormDialog):
    def __init__(self, parent: QWidget, item: ExtractedItem) -> None:
        super().__init__(parent, "Corrigir item")
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

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.batch_id: UUID | None = None
        self._jobs: set[_ImportJob] = set()
        self._queue: list[Path] = []

        self.batches = make_table(["Arquivo", "Layout", "Situação", "Itens", "Conferência"])
        self.batches.itemSelectionChanged.connect(self._select_batch)
        import_button = QPushButton("Importar arquivos…")
        import_button.clicked.connect(self.import_files)
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.addWidget(import_button)
        left_layout.addWidget(self.batches)

        self.header = QLabel()
        self.header.setWordWrap(True)
        self.target = QComboBox()
        self.target.activated.connect(self._change_target)
        self.layout_choice = QComboBox()
        choose = QPushButton("Usar layout")
        choose.clicked.connect(self._choose_layout)
        target_row = QFormLayout()
        target_row.addRow("Conta/cartão do documento:", self.target)
        layout_row = QHBoxLayout()
        layout_row.addWidget(self.layout_choice)
        layout_row.addWidget(choose)
        target_row.addRow("Layout:", layout_row)

        self.items = make_table(
            ["Situação", "Data", "Descrição", "Tipo", "Valor", "Categoria/contrapartida", "Observações"]
        )
        self.items.itemSelectionChanged.connect(self._select_item)
        buttons = QHBoxLayout()
        for label, slot, keys in (
            ("Aprovar prontos", self.approve_all, ("Ctrl+Shift+Return", "Ctrl+Shift+Enter")),
            ("Aprovar selecionado", self.approve_selected, ("Ctrl+Return", "Ctrl+Enter")),
            ("Corrigir", self.correct, ("F2",)),
            ("Manter separado", self.keep_separate, ("Ctrl+M",)),
            ("Rejeitar", self.reject, ("Delete",)),
            ("Sugerir com IA", self.suggest_ai, ()),
        ):
            button = QPushButton(label)
            button.clicked.connect(slot)
            if keys:
                button.setToolTip(f"Atalho: {keys[0]}")
            buttons.addWidget(button)
            self._shortcut(keys, slot)
        self._shortcut(("Ctrl+I",), self.import_files)
        self._shortcut(("Ctrl+K",), self.focus_target)
        buttons.addStretch()

        review = QWidget()
        review_layout = QVBoxLayout(review)
        review_layout.addWidget(self.header)
        review_layout.addLayout(target_row)
        review_layout.addLayout(buttons)
        review_layout.addWidget(self.items)

        self.viewer = PdfView()
        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.addWidget(left)
        splitter.addWidget(self.viewer)
        splitter.addWidget(review)
        splitter.setSizes([280, 520, 700])
        layout = QVBoxLayout(self)
        layout.addWidget(splitter)

    # ── data ────────────────────────────────────────

    def refresh(self) -> None:
        if self.session is None:
            self.batches.setRowCount(0)
            self.items.setRowCount(0)
            self.viewer.show_pdf(None)
            self.header.setText("")
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
                ([name, batch.parser_id or "—", STATUS_LABELS[batch.status], str(len(batch_items)), check], batch.id)
            )
        set_rows(self.batches, rows)
        self._show_batch()

    def _batch(self) -> ImportBatch | None:
        if self.session is None or self.batch_id is None:
            return None
        return pipeline.batches(self.session.ledger).get(self.batch_id)

    def _select_batch(self) -> None:
        self.batch_id = selected_id(self.batches)
        self._show_batch()
        batch = self._batch()
        if batch is not None and self.session is not None:
            document = self.session.document(batch.document_id)
            if document.meta.original_name.lower().endswith(".pdf"):
                self.viewer.show_pdf(document.data)
            else:
                self.viewer.show_pdf(None)
                self.viewer.image.setText("Arquivo estruturado: veja a linha de origem em Observações.")

    def _show_batch(self) -> None:
        batch = self._batch()
        if batch is None or self.session is None:
            self.items.setRowCount(0)
            self.header.setText("Selecione um documento.")
            return
        ledger = self.session.ledger
        h = batch.header
        parts = [f"<b>{h.institution or 'Instituição não identificada'}</b>"]
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
        lines = [" · ".join(parts)]
        for r in batch.reconciliations:
            mark = {True: "✔ confere", False: "✘ diverge", None: "não comparável"}[r.ok]
            lines.append(f"{r.label}: documento {fmt(r.expected)}, calculado {fmt(r.computed)} — {mark}")
        if batch.unmapped_lines:
            lines.append(f"{batch.unmapped_lines} linha(s) não mapeada(s) preservadas no original.")
        lines.extend(f"⚠ {w}" for w in batch.warnings)
        self.header.setText("<br>".join(lines))

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
        self.layout_choice.setEnabled(batch.status in (BatchStatus.AMBIGUOUS, BatchStatus.UNSUPPORTED))

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
                notes.append(SOURCE_LABELS.get(item.suggestion_source, f"sugestão ({item.suggestion_source})"))
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
            fill_combo(combo, options, empty="(padrão)")
            index = combo.findData(item.target_account_id)
            combo.setCurrentIndex(max(index, 0))
            combo.currentIndexChanged.connect(lambda _=0, c=combo, i=item.id: self._set_target(i, c.currentData()))
            self.items.setCellWidget(row, 5, combo)

    def _set_target(self, item_id: UUID, target: UUID | None) -> None:
        if self.session is None:
            return
        ledger = self.session.ledger
        if run_guarded(self, lambda: pipeline.correct_item(ledger, item_id, "target_account_id", target)):
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
        if self._jobs or not self._queue or self.session is None:
            return
        self._import_one(self._queue.pop(0), None)

    def _import_one(self, path: Path, password: str | None) -> None:
        assert self.session is not None
        session = self.session
        data = path.read_bytes()
        request = ImportRequest(name=path.name, data=data, password=password)
        job = _ImportJob(lambda: pipeline.import_document(session, request))
        self._jobs.add(job)
        self.setEnabled(False)
        self.set_busy(True)

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
        result = run_guarded(self, lambda: pipeline.reparse_with(session, batch.id, parser_id))
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

    def suggest_ai(self) -> None:
        batch = self._batch()
        if batch is None or self.session is None:
            return
        from opesvault.ai.ollama import AiUnavailable
        from opesvault.domain.settings import get_settings
        from opesvault.importing.ai_suggestions import suggest_with_ai

        if not get_settings(self.session.ledger).ai_enabled:
            QMessageBox.information(self, "IA local", "A assistência por IA está desligada (Configurações).")
            return
        try:
            count = suggest_with_ai(self.session.ledger, batch.id)
        except AiUnavailable as exc:
            QMessageBox.information(self, "IA local", f"{exc} A revisão manual continua disponível.")
            return
        QMessageBox.information(self, "IA local", f"{count} sugestão(ões) preenchida(s). Revise antes de aprovar.")
        self.changed()
