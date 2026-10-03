"""PDF of a report by explicit action (RF-20): the file leaves the vault unencrypted, and says so."""

from collections.abc import Callable

from PySide6.QtWidgets import QFileDialog, QWidget

from opesvault.ui.components import confirm


def write_pdf(path: str, html: str) -> None:
    """Renders HTML into an A4 PDF in memory and writes only the final file (no temporary files)."""
    from PySide6.QtCore import QMarginsF
    from PySide6.QtGui import QPageLayout, QPageSize, QPdfWriter, QTextDocument

    writer = QPdfWriter(path)
    writer.setPageSize(QPageSize(QPageSize.PageSizeId.A4))
    writer.setPageMargins(QMarginsF(15, 15, 15, 15), QPageLayout.Unit.Millimeter)
    writer.setTitle("OpesVault")
    document = QTextDocument()
    document.setHtml(html)
    document.print_(writer)


def save_pdf(parent: QWidget, suggested: str, build: Callable[[], str]) -> bool:
    if not confirm(
        parent,
        "Gerar PDF sem criptografia?",
        "O PDF fica fora do cofre, sem criptografia, e contém dados financeiros da família.",
        "Gerar PDF…",
    ):
        return False
    path, _ = QFileDialog.getSaveFileName(parent, "Salvar PDF", suggested, "PDF (*.pdf)")
    if not path:
        return False
    write_pdf(path, build())
    return True
