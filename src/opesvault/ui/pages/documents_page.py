"""Documents stored in the vault, rendered in memory (docs/03 §6)."""

from PySide6.QtCore import Qt
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import QHBoxLayout, QLabel, QScrollArea, QSpinBox, QVBoxLayout, QWidget

from opesvault.ui.common import make_table, selected_id, set_rows
from opesvault.ui.pages.base import Page


class PdfView(QWidget):
    """Page-by-page PDF viewer over in-memory bytes."""

    def __init__(self) -> None:
        super().__init__()
        self.data: bytes | None = None
        self.page = QSpinBox()
        self.page.setMinimum(1)
        self.page.valueChanged.connect(self._render)
        self.image = QLabel("Nenhum documento selecionado")
        self.image.setAlignment(Qt.AlignmentFlag.AlignCenter)
        scroll = QScrollArea()
        scroll.setWidget(self.image)
        scroll.setWidgetResizable(True)
        layout = QVBoxLayout(self)
        bar = QHBoxLayout()
        bar.addWidget(QLabel("Página:"))
        bar.addWidget(self.page)
        bar.addStretch()
        layout.addLayout(bar)
        layout.addWidget(scroll)

    def show_pdf(self, data: bytes | None, page: int = 1) -> None:
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
        self.page.setValue(page)
        self._render()

    def _render(self) -> None:
        if self.data is None:
            return
        from opesvault.pdf_render import render_page

        try:
            image = render_page(self.data, self.page.value() - 1)
        except Exception:
            self.image.setText("Não foi possível renderizar esta página.")
            return
        self.image.setPixmap(QPixmap.fromImage(image))


class DocumentsPage(Page):
    title = "Documentos"

    def __init__(self, changed) -> None:  # type: ignore[no-untyped-def]
        super().__init__(changed)
        self.table = make_table(["Arquivo", "Tamanho", "Resumo (SHA-256)"])
        self.table.itemSelectionChanged.connect(self._show)
        self.viewer = PdfView()
        layout = QHBoxLayout(self)
        layout.addWidget(self.table, 2)
        layout.addWidget(self.viewer, 3)

    def refresh(self) -> None:
        if self.session is None:
            self.table.setRowCount(0)
            self.viewer.show_pdf(None)
            return
        set_rows(
            self.table,
            [
                ([d.meta.original_name, f"{d.meta.size / 1024:.0f} KiB", d.meta.sha256[:16]], d.meta.id)
                for d in self.session.documents
            ],
        )

    def _show(self) -> None:
        doc_id = selected_id(self.table)
        if self.session is None or doc_id is None:
            return
        document = self.session.document(doc_id)
        if document.meta.original_name.lower().endswith(".pdf"):
            self.viewer.show_pdf(document.data)
        else:
            self.viewer.image.setText("Arquivo estruturado (CSV/OFX): sem visualização de página.")
