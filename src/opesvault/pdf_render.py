"""In-memory PDF rendering: no temporary files, thumbnails or caches on disk.

Password-protected PDFs are opened with the password the user types once; the password
itself is not kept (docs/05 §3). A viewer keeps the opened document while it is on screen.
"""

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from PySide6.QtGui import QImage


class PdfPasswordRequired(Exception):
    """The PDF needs a user password (none given, or the one given is wrong)."""


def open_document(data: bytes, password: str | None = None) -> pdfium.PdfDocument:
    try:
        return pdfium.PdfDocument(data, password=password)
    except pdfium.PdfiumError as exc:
        if getattr(exc, "err_code", None) == pdfium_c.FPDF_ERR_PASSWORD:
            raise PdfPasswordRequired from None
        raise


def page_count(data: bytes, password: str | None = None) -> int:
    pdf = open_document(data, password)
    try:
        return len(pdf)
    finally:
        pdf.close()


def render_document(pdf: pdfium.PdfDocument, index: int = 0, scale: float = 1.5) -> QImage:
    page = pdf[index]
    try:
        # pypdfium2 annotates `scale` as int, but documents and accepts float.
        bitmap = page.render(scale=scale, rev_byteorder=True, prefer_bgrx=True)  # pyright: ignore[reportArgumentType]
        try:
            image = QImage(bitmap.buffer, bitmap.width, bitmap.height, bitmap.stride, QImage.Format.Format_RGBX8888)
            # Detach from PDFium's buffer before it is freed.
            return image.copy()
        finally:
            bitmap.close()
    finally:
        page.close()


def render_page(data: bytes, index: int = 0, scale: float = 1.5, password: str | None = None) -> QImage:
    pdf = open_document(data, password)
    try:
        return render_document(pdf, index, scale)
    finally:
        pdf.close()


def page_width(pdf: pdfium.PdfDocument, index: int = 0) -> float:
    """Width of a page in PDF points (1/72 in), to fit it to the viewer."""
    page = pdf[index]
    try:
        return float(page.get_width())
    finally:
        page.close()
