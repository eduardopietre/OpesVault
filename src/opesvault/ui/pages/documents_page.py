"""Documents stored in the vault, rendered in memory (docs/03 §6)."""

from uuid import UUID

from PySide6.QtCore import Qt
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import QLabel, QScrollArea, QSpinBox, QVBoxLayout, QWidget

from opesvault.importing.model import ImportBatch
from opesvault.ui.common import file_size, frameless, make_table, selected_id, set_rows
from opesvault.ui.components import button
from opesvault.ui.pages.base import Page


class PdfView(QWidget):
    """Page-by-page PDF viewer over in-memory bytes."""

    def __init__(self) -> None:
        super().__init__()
        self.data: bytes | None = None
        self.highlight: tuple[float, float, float, float] | None = None
        self.highlight_page = 1
        self.page = QSpinBox()
        self.page.setMinimum(1)
        self.page.valueChanged.connect(self._render)
        self.image = QLabel("Nenhum documento selecionado")
        self.image.setAlignment(Qt.AlignmentFlag.AlignCenter)
        scroll = QScrollArea()
        scroll.setWidget(self.image)
        scroll.setWidgetResizable(True)
        from opesvault.ui.components import hbox, text

        self.image.setProperty("textStyle", "secondary")
        self.image.setWordWrap(True)
        self.page.setAccessibleName("Página")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addLayout(hbox(text("Documento original", "headline"), None, text("Página", "secondary"), self.page))
        layout.addWidget(scroll)

    def show_pdf(
        self, data: bytes | None, page: int = 1, highlight: tuple[float, float, float, float] | None = None
    ) -> None:
        self.highlight = highlight
        self.data = data
        if data is None:
            self.image.setText("Nenhum documento selecionado")
            return
        from opesvault.pdf_render import page_count

        try:
            self.page.setMaximum(page_count(data))
        except Exception:
            self.image.setText("Não foi possível abrir este PDF (protegido por senha ou inválido).")
            return
        self.highlight_page = page
        self.page.setValue(page)
        self._render()

    def _render(self) -> None:
        if self.data is None:
            return
        from opesvault.pdf_render import render_page

        scale = 1.5
        try:
            image = render_page(self.data, self.page.value() - 1, scale)
        except Exception:
            self.image.setText("Não foi possível renderizar esta página.")
            return
        if self.highlight is not None and self.page.value() == self.highlight_page:
            from PySide6.QtGui import QColor, QPainter, QPen

            x0, top, x1, bottom = (v * scale for v in self.highlight)
            painter = QPainter(image)
            painter.setPen(QPen(QColor(220, 0, 0), 2))
            painter.fillRect(
                int(x0) - 2, int(top) - 2, int(x1 - x0) + 4, int(bottom - top) + 4, QColor(255, 230, 0, 70)
            )
            painter.drawRect(int(x0) - 2, int(top) - 2, int(x1 - x0) + 4, int(bottom - top) + 4)
            painter.end()
        self.image.setPixmap(QPixmap.fromImage(image))


class DocumentsPage(Page):
    title = "Documentos"
    section = "Arquivo"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        from PySide6.QtWidgets import QSplitter, QStackedWidget

        from opesvault.ui.components import EmptyState

        # What someone looking for a bill needs: when, which account or card, and whether it was posted.
        # The SHA-256 summary stays in the file name's tooltip.
        self.table = frameless(make_table(["Arquivo", "Data", "Conta ou cartão", "Situação"]))
        self.table.setAccessibleName("Documentos no cofre")
        self.table.itemSelectionChanged.connect(self._show)
        self.open_review = button("Abrir na revisão", self._open_review, tip="Os itens deste documento em Importar")
        self.open_review.setEnabled(False)
        self.header.add(self.open_review)
        self._batches: dict[UUID, ImportBatch] = {}
        self.viewer = PdfView()
        split = QSplitter(Qt.Orientation.Horizontal)
        split.setChildrenCollapsible(False)
        split.addWidget(self.table)
        split.addWidget(self.viewer)
        split.setSizes([620, 520])
        self.empty = EmptyState(
            "Nenhum documento no cofre",
            "Os arquivos importados ficam guardados aqui, cifrados, como evidência dos lançamentos.",
        )
        self.views = QStackedWidget()
        self.views.addWidget(split)
        self.views.addWidget(self.empty)
        layout = self.page_layout()
        layout.addWidget(self.views, 1)

    def refresh(self) -> None:
        if self.session is None:
            self.table.setRowCount(0)
            self.viewer.show_pdf(None)
            return
        from opesvault.importing import pipeline
        from opesvault.ui.common import fmt_date
        from opesvault.ui.pages.import_page import STATUS_LABELS

        ledger = self.session.ledger
        self._batches = {b.document_id: b for b in pipeline.batches(ledger).values()}
        rows = []
        for d in self.session.documents:
            batch = self._batches.get(d.meta.id)
            when, where, state = "—", "—", "Sem importação"
            if batch is not None:
                header = batch.header
                day = header.due_on or header.period_end or batch.created_at.date()
                when = fmt_date(day)
                account = ledger.accounts.get(batch.account_id) if batch.account_id else None
                card = ledger.cards.get(batch.card_id) if batch.card_id else None
                where = card.name if card else account.name if account else "—"
                state = STATUS_LABELS.get(batch.status, "—")
            rows.append(([d.meta.original_name, when, where, state], d.meta.id))
        set_rows(self.table, rows)
        for row, d in enumerate(self.session.documents):
            item = self.table.item(row, 0)
            if item is not None:
                item.setToolTip(f"{file_size(d.meta.size)} · SHA-256 {d.meta.sha256}")
        documents = self.session.documents
        self.views.setCurrentIndex(0 if documents else 1)
        size = file_size(sum(d.meta.size for d in documents))
        self.header.set_subtitle(f"{len(documents)} arquivo(s) · {size}" if documents else "")

    def _open_review(self) -> None:
        batch = self._batches.get(selected_id(self.table))
        if batch is not None:
            self.navigate("import", batch.id)

    def _show(self) -> None:
        doc_id = selected_id(self.table)
        self.open_review.setEnabled(doc_id in self._batches)
        if self.session is None or doc_id is None:
            return
        document = self.session.document(doc_id)
        if document.meta.original_name.lower().endswith(".pdf"):
            self.viewer.show_pdf(document.data)
        else:
            self.viewer.image.setText("Arquivo estruturado (CSV/OFX): sem visualização de página.")
