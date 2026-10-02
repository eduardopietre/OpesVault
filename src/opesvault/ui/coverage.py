"""Which documents the importer reads: one line per institution, product and layout."""

from PySide6.QtWidgets import QDialog, QDialogButtonBox, QVBoxLayout, QWidget

from opesvault.ui.common import frameless, make_table, set_rows, stretch_column
from opesvault.ui.components import text
from opesvault.ui.theme import SPACE_L, SPACE_M, SPACE_XL


class CoverageDialog(QDialog):
    """Supported layouts, opened from Importar when a new bank is about to be imported."""

    def __init__(self, parent: QWidget | None) -> None:
        from opesvault.importing.parsers import PARSERS

        super().__init__(parent)
        self.setWindowTitle("Layouts suportados")
        self.table = frameless(
            make_table(["Instituição", "Produto", "Formato", "Layout", "Versão", "Validado", "Limitações"])
        )
        set_rows(
            self.table,
            [
                (
                    [
                        p.institution,
                        p.product,
                        p.doc_format.value.upper(),
                        p.id,
                        p.version,
                        "sim" if p.validated_with_real_documents else "não (sintético)",
                        p.limitations,
                    ],
                    p.id,
                )
                for p in PARSERS
            ],
        )
        stretch_column(self.table, 6)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        buttons.rejected.connect(self.reject)
        close = buttons.button(QDialogButtonBox.StandardButton.Close)
        if close is not None:
            close.setText("Fechar")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(SPACE_XL, SPACE_XL, SPACE_XL, SPACE_L)
        layout.setSpacing(SPACE_M)
        layout.addWidget(text("Layouts suportados", "headline"))
        layout.addWidget(
            text(
                "Layouts sem validação com documentos reais mostram um aviso a cada importação; confira os itens. "
                "Um documento sem layout pode ser registrado manualmente no Livro financeiro.",
                "caption",
                wrap=True,
            )
        )
        layout.addWidget(self.table, 1)
        layout.addWidget(buttons)
        self.resize(940, 520)
