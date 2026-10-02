"""Small vector icons drawn at runtime: no image files, no network, crisp at any scale."""

from PySide6.QtCore import QRectF, Qt
from PySide6.QtGui import QColor, QIcon, QPainter, QPen, QPixmap


def sidebar_icon(color: QColor, size: int = 32) -> QIcon:
    """A window outline with a left pane: the conventional 'toggle sidebar' symbol."""
    pixmap = QPixmap(size, size)
    pixmap.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    pen = QPen(color)
    pen.setWidthF(size / 14)
    painter.setPen(pen)
    frame = QRectF(size * 0.12, size * 0.2, size * 0.76, size * 0.6)
    painter.drawRoundedRect(frame, size * 0.08, size * 0.08)
    x = frame.left() + frame.width() * 0.34
    painter.drawLine(int(x), int(frame.top()), int(x), int(frame.bottom()))
    painter.end()
    return QIcon(pixmap)
