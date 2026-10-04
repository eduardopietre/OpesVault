"""The page header: title, context line and the page's actions, which wrap below when narrow."""

from PySide6.QtCore import QEvent, QObject, QSize, Qt
from PySide6.QtWidgets import (
    QBoxLayout,
    QLayout,
    QVBoxLayout,
    QWidget,
)

from opesvault.ui.components.basics import text
from opesvault.ui.components.layout import FlowHost, FlowLayout
from opesvault.ui.theme import SPACE_L, SPACE_S, SPACE_XS


class PageHeader(QWidget):
    """Where am I (title), what am I looking at (context), what can I do (trailing actions)."""

    def __init__(self, title: str, subtitle: str = "") -> None:
        super().__init__()
        self.title = text(title, "title")
        self.title.setAccessibleName(title)
        self.subtitle = text(subtitle, "secondary", wrap=True)  # wraps instead of widening the window
        self.subtitle.setMinimumWidth(160)
        self.subtitle.setVisible(bool(subtitle))
        # The actions wrap like a flow row: one line beside the title when there is room, and below
        # it, wrapping as needed, when the window narrows. The widest action sets the minimum width.
        self._trail = FlowHost()
        self.trailing = FlowLayout(self._trail, SPACE_S)
        titles = QVBoxLayout()
        titles.setSpacing(2)
        titles.addWidget(self.title)
        titles.addWidget(self.subtitle)
        self.row = QBoxLayout(QBoxLayout.Direction.LeftToRight, self)
        self.row.setContentsMargins(0, 0, 0, SPACE_XS)
        self.row.setSpacing(SPACE_L)
        self.row.setSizeConstraint(QLayout.SizeConstraint.SetNoConstraint)
        self.row.addLayout(titles, 1)
        self.row.addWidget(self._trail, 0, Qt.AlignmentFlag.AlignVCenter)
        self._titles = titles
        self._wide: bool | None = None
        self._trail.installEventFilter(self)  # an action shown or hidden changes the line's width

    def eventFilter(self, watched: QObject, event: QEvent) -> bool:  # noqa: N802 - Qt override
        if watched is self._trail and event.type() == QEvent.Type.LayoutRequest:
            self._fit()
        return False

    def _line_width(self) -> int:
        """Width of all actions on a single line."""
        hints = []
        for index in range(self.trailing.count()):
            item = self.trailing.itemAt(index)
            widget = item.widget() if item is not None else None
            if item is not None and not (widget is not None and widget.isHidden()):
                hints.append(item.sizeHint().width())
        return sum(hints) + SPACE_S * max(0, len(hints) - 1)

    def _side_by_side_width(self) -> int:
        return self.title.sizeHint().width() + self.row.spacing() + self._line_width()

    def _fit(self) -> None:
        wide = self.width() >= self._side_by_side_width()
        # beside the title the actions keep one line; below it they may wrap
        self._trail.setMinimumWidth(self._line_width() if wide else 0)
        if self._wide == wide:
            return
        self._wide = wide
        self.row.setDirection(QBoxLayout.Direction.LeftToRight if wide else QBoxLayout.Direction.TopToBottom)
        self.row.setStretchFactor(self._titles, 1 if wide else 0)
        self.row.setSpacing(SPACE_L if wide else SPACE_S)
        self.updateGeometry()

    def resizeEvent(self, event: object) -> None:  # noqa: N802 - Qt override
        self._fit()
        super().resizeEvent(event)  # type: ignore[arg-type]

    def minimumSizeHint(self) -> QSize:  # noqa: N802 - Qt override
        margins = self.row.contentsMargins()
        width = max(self._titles.minimumSize().width(), self.trailing.minimumSize().width())  # widest action
        return QSize(width + margins.left() + margins.right(), self.row.minimumSize().height())

    def sizeHint(self) -> QSize:  # noqa: N802 - Qt override
        return self.row.sizeHint().expandedTo(self.minimumSizeHint())

    def hasHeightForWidth(self) -> bool:  # noqa: N802 - Qt override
        return True

    def heightForWidth(self, width: int) -> int:  # noqa: N802 - Qt override
        return self.row.heightForWidth(width) if self.row.hasHeightForWidth() else self.row.sizeHint().height()

    def set_subtitle(self, value: str) -> None:
        self.subtitle.setText(value)
        self.subtitle.setVisible(bool(value))

    def add(self, *widgets: QWidget | int) -> None:
        """Trailing actions; an int adds that much space (separates unrelated groups)."""
        for widget in widgets:
            if isinstance(widget, int):
                gap = QWidget()
                gap.setFixedSize(max(0, widget - SPACE_S), 1)
                self.trailing.addWidget(gap)
            else:
                self.trailing.addWidget(widget)
        self._fit()
