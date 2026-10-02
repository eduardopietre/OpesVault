"""In-memory PDF rendering: no temporary files, thumbnails or caches on disk."""

import pypdfium2 as pdfium
from PySide6.QtGui import QImage


def page_count(data: bytes) -> int:
    pdf = pdfium.PdfDocument(data)
    try:
        return len(pdf)
    finally:
        pdf.close()


def render_page(data: bytes, index: int = 0, scale: float = 1.5) -> QImage:
    pdf = pdfium.PdfDocument(data)
    try:
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
    finally:
        pdf.close()
