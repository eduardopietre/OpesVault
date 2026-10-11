"""Layouts that keep a small window usable: rows that wrap, parts side by side only with room,
scrolling page bodies."""

from PySide6.QtCore import QEvent, QPoint, QRect, QSize, Qt, Signal
from PySide6.QtWidgets import (
    QBoxLayout,
    QHBoxLayout,
    QLayout,
    QLayoutItem,
    QScrollArea,
    QSizePolicy,
    QSpacerItem,
    QVBoxLayout,
    QWidget,
)

from opesvault.ui.theme import SPACE_L, SPACE_M, SPACE_S, SPACE_XL, SPACE_XXL


def scroll_body() -> tuple[QScrollArea, QVBoxLayout]:
    """A page body that scrolls vertically, with section spacing (32 px) between its parts.

    Used by pages made of several sections, so a short window scrolls instead of growing.
    """
    body = QWidget()
    body.setObjectName("Surface")
    layout = QVBoxLayout(body)
    layout.setContentsMargins(0, SPACE_S, 0, SPACE_L)
    layout.setSpacing(SPACE_XXL)
    scroll = QScrollArea()
    scroll.setWidgetResizable(True)
    scroll.setFrameShape(QScrollArea.Shape.NoFrame)
    scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
    scroll.setWidget(body)
    return scroll, layout


def page_margins(layout: QVBoxLayout | QHBoxLayout) -> None:
    layout.setContentsMargins(SPACE_XL, SPACE_L, SPACE_XL, SPACE_L)
    layout.setSpacing(SPACE_M)


class FlowLayout(QLayout):
    """Lays widgets left to right and wraps to the next line when the window narrows."""

    def __init__(self, parent: QWidget | None = None, spacing: int = SPACE_S, line_spacing: int | None = None) -> None:
        super().__init__(parent)
        self._items: list[QLayoutItem] = []
        self._spacing = spacing
        self._line_spacing = spacing if line_spacing is None else line_spacing
        self.setContentsMargins(0, 0, 0, 0)

    def addItem(self, item: QLayoutItem) -> None:  # noqa: N802 - Qt override
        self._items.append(item)

    def count(self) -> int:
        return len(self._items)

    def itemAt(self, index: int) -> QLayoutItem | None:  # noqa: N802 - Qt override
        return self._items[index] if 0 <= index < len(self._items) else None

    def takeAt(self, index: int) -> QLayoutItem | None:  # noqa: N802 - Qt override
        return self._items.pop(index) if 0 <= index < len(self._items) else None

    def expandingDirections(self) -> Qt.Orientation:  # noqa: N802 - Qt override
        return Qt.Orientation(0)

    def hasHeightForWidth(self) -> bool:  # noqa: N802 - Qt override
        return True

    def heightForWidth(self, width: int) -> int:  # noqa: N802 - Qt override
        return self._arrange(QRect(0, 0, width, 0), apply=False)

    def setGeometry(self, rect: QRect) -> None:  # noqa: N802 - Qt override
        super().setGeometry(rect)
        self._arrange(rect, apply=True)

    def sizeHint(self) -> QSize:  # noqa: N802 - Qt override
        return self.minimumSize()

    def minimumSize(self) -> QSize:  # noqa: N802 - Qt override
        size = QSize()
        for item in self._items:
            size = size.expandedTo(item.minimumSize())
        return size

    def _arrange(self, rect: QRect, *, apply: bool) -> int:
        x, y, line = rect.x(), rect.y(), 0
        for item in self._items:
            widget = item.widget()
            if widget is not None and widget.isHidden():
                continue
            hint = item.sizeHint()
            if x + hint.width() > rect.right() + 1 and line > 0:
                x, y, line = rect.x(), y + line + self._line_spacing, 0
            if apply:
                item.setGeometry(QRect(QPoint(x, y), hint))
            x += hint.width() + self._spacing
            line = max(line, hint.height())
        return y + line - rect.y()


class FlowHost(QWidget):
    """Reserves the height its wrapped rows need at the current width.

    Recomputed on resize and whenever a child is shown or hidden (a layout request): otherwise
    a control hidden after the first layout leaves its wrapped line behind as an empty gap.
    """

    def _fit(self) -> None:
        layout = self.layout()
        if layout is not None:
            needed = layout.heightForWidth(self.width())
            if needed != self.minimumHeight():
                self.setMinimumHeight(needed)

    def resizeEvent(self, event: object) -> None:  # noqa: N802 - Qt override
        self._fit()
        super().resizeEvent(event)  # type: ignore[arg-type]

    def event(self, event: QEvent) -> bool:
        if event.type() == QEvent.Type.LayoutRequest:
            self._fit()
        return super().event(event)


def flow_row(*widgets: QWidget, spacing: int = SPACE_S, line_spacing: int | None = None) -> QWidget:
    """A row of controls that wraps instead of forcing a minimum window width."""
    host = FlowHost()
    flow = FlowLayout(host, spacing, line_spacing)
    for widget in widgets:
        flow.addWidget(widget)
    host.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
    return host


class Adaptive(QWidget):
    """Side by side when there is room, stacked when the window narrows (docs/16 §2).

    The product targets 1920x1080, where a single column leaves half the screen empty, but a
    small window must keep working. Below `breakpoint` (this widget's own width) the children
    stack; above it they sit in a row, each with its `stretch` share, aligned at the top. The
    minimum width is always the stacked one, so a wide arrangement never forces the window
    to stay wide: it only appears when the room is already there.
    """

    HYSTERESIS = 32  # a scroll bar coming and going must not make the layout flip back and forth
    arranged = Signal(bool)  # True when the children now sit side by side

    def __init__(
        self, breakpoint: int, spacing: int = SPACE_XL, stacked_spacing: int | None = None, *, first_right: bool = False
    ) -> None:
        super().__init__()
        self.breakpoint = breakpoint
        # first_right: the first child leads when stacked (on top) but sits on the right when wide,
        # like a side rail of things to act on
        self._row = QBoxLayout.Direction.RightToLeft if first_right else QBoxLayout.Direction.LeftToRight
        self._spacing = spacing
        self._stacked_spacing = spacing if stacked_spacing is None else stacked_spacing
        self._stretch: list[int] = []
        self._widgets: list[QWidget] = []
        self.box = QBoxLayout(QBoxLayout.Direction.TopToBottom, self)
        self.box.setContentsMargins(0, 0, 0, 0)
        self.box.setSpacing(self._stacked_spacing)
        self.box.setSizeConstraint(QLayout.SizeConstraint.SetNoConstraint)
        self._tail = QSpacerItem(0, 0, QSizePolicy.Policy.Minimum, QSizePolicy.Policy.Expanding)
        self.box.addItem(self._tail)

    def add(self, widget: QWidget, stretch: int = 1) -> QWidget:
        self.box.insertWidget(len(self._widgets), widget)
        self._widgets.append(widget)
        self._stretch.append(stretch)
        self._arrange()
        return widget

    @property
    def wide(self) -> bool:
        return self.box.direction() != QBoxLayout.Direction.TopToBottom

    def _arrange(self) -> None:
        wide = self.wide
        self.box.setSpacing(self._spacing if wide else self._stacked_spacing)
        for index, widget in enumerate(self._widgets):
            self.box.setStretch(index, self._stretch[index] if wide else 0)
            self.box.setAlignment(widget, Qt.AlignmentFlag.AlignTop if wide else Qt.AlignmentFlag(0))
        # stacked, a folded child gives its room back to what follows; side by side, nothing to give
        if wide:
            self._tail.changeSize(0, 0, QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)
        else:
            self._tail.changeSize(0, 0, QSizePolicy.Policy.Minimum, QSizePolicy.Policy.Expanding)
        self.box.invalidate()
        self.updateGeometry()

    def set_wide(self, wide: bool) -> None:
        if wide == self.wide:
            return
        self.box.setDirection(self._row if wide else QBoxLayout.Direction.TopToBottom)
        self._arrange()
        self.arranged.emit(wide)

    def resizeEvent(self, event: object) -> None:  # noqa: N802 - Qt override
        width = self.width()
        if not self.wide and width >= self.breakpoint:
            self.set_wide(True)
        elif self.wide and width < self.breakpoint - self.HYSTERESIS:
            self.set_wide(False)
        super().resizeEvent(event)  # type: ignore[arg-type]

    def minimumSizeHint(self) -> QSize:  # noqa: N802 - Qt override
        width = max((w.minimumSizeHint().expandedTo(w.minimumSize()).width() for w in self._shown()), default=0)
        return QSize(width, self.box.minimumSize().height())

    def sizeHint(self) -> QSize:  # noqa: N802 - Qt override
        return QSize(self.box.sizeHint().width(), self.box.sizeHint().height()).expandedTo(self.minimumSizeHint())

    def hasHeightForWidth(self) -> bool:  # noqa: N802 - Qt override
        return self.box.hasHeightForWidth()

    def heightForWidth(self, width: int) -> int:  # noqa: N802 - Qt override
        return self.box.heightForWidth(width) if self.box.hasHeightForWidth() else -1

    def _shown(self) -> list[QWidget]:
        return [w for w in self._widgets if not w.isHidden()]


def adaptive(breakpoint: int, *widgets: QWidget | tuple[QWidget, int], spacing: int = SPACE_XL) -> Adaptive:
    """`Adaptive` with its children: a widget (stretch 1) or (widget, stretch)."""
    host = Adaptive(breakpoint, spacing)
    for entry in widgets:
        widget, stretch = entry if isinstance(entry, tuple) else (entry, 1)
        host.add(widget, stretch)
    return host


# A choice offered by `decide`: (key, label, role). Roles: "accept" (the default, first on
# Windows), "destructive" and "reject" (Esc).
