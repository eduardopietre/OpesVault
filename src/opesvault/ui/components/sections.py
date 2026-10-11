"""Content blocks: empty states, key figures, titled and collapsible sections."""

from collections.abc import Sequence

from PySide6.QtCore import QSize, Qt, Signal
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QPushButton,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from opesvault.ui.components.basics import hbox, set_tone, text
from opesvault.ui.components.layout import FlowLayout
from opesvault.ui.theme import SPACE_L, SPACE_M, SPACE_S, SPACE_XL, SPACE_XS

FIGURE_GAP = SPACE_XL + SPACE_S  # between key figures of one group

# (label, slot) or (label, slot, shortcut); None draws a separator.


class EmptyState(QWidget):
    """Says what the area is, why it is empty and what to do next."""

    def __init__(self, title: str, message: str = "", actions: Sequence[QPushButton] = ()) -> None:
        super().__init__()
        self.title = text(title, "headline")
        self.title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.message = text(message, "secondary", wrap=True)
        self.message.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.message.setMaximumWidth(460)
        self.message.setMinimumWidth(160)
        self.message.setVisible(bool(message))
        layout = QVBoxLayout(self)
        layout.setSpacing(SPACE_S)
        layout.addStretch(1)
        layout.addWidget(self.title, alignment=Qt.AlignmentFlag.AlignHCenter)
        # No alignment flag here: an aligned label gets its size hint and loses height-for-width.
        centered = QHBoxLayout()
        centered.addStretch(1)
        centered.addWidget(self.message, 100)
        centered.addStretch(1)
        layout.addLayout(centered)
        if actions:
            row = hbox(None, *actions, None)
            layout.addSpacing(SPACE_S)
            layout.addLayout(row)
        layout.addStretch(2)

    def set_text(self, title: str, message: str = "") -> None:
        self.title.setText(title)
        self.message.setText(message)
        self.message.setVisible(bool(message))


class Figures(QWidget):
    """Labelled key figures (label above, value below), separated by space, not boxes.

    They wrap to a new line on narrow windows instead of widening the window.
    """

    def __init__(self, labels: Sequence[str]) -> None:
        super().__init__()
        self.values: dict[str, QLabel] = {}
        flow = FlowLayout(self, FIGURE_GAP, SPACE_M)
        for label in labels:
            block = QWidget()
            column = QVBoxLayout(block)
            column.setContentsMargins(0, 0, 0, 0)
            column.setSpacing(SPACE_XS)
            caption = text(label, "caption")
            value = text("—", "figure")
            value.setAccessibleName(label)
            column.addWidget(caption)
            column.addWidget(value)
            flow.addWidget(block)
            self.values[label] = value

    def hasHeightForWidth(self) -> bool:  # noqa: N802 - Qt override
        return True

    def heightForWidth(self, width: int) -> int:  # noqa: N802 - Qt override
        layout = self.layout()
        return layout.heightForWidth(width) if layout is not None else super().heightForWidth(width)

    def resizeEvent(self, event: object) -> None:  # noqa: N802 - Qt override
        layout = self.layout()
        if layout is not None:
            needed = layout.heightForWidth(self.width())
            if needed != self.minimumHeight():
                self.setMinimumHeight(needed)
        super().resizeEvent(event)  # type: ignore[arg-type]

    def sizeHint(self) -> QSize:  # noqa: N802 - Qt override
        """One line: the natural width of all figures side by side."""
        layout = self.layout()
        if layout is None:
            return super().sizeHint()
        items = [layout.itemAt(i) for i in range(layout.count())]
        widths = [item.sizeHint().width() for item in items if item is not None]
        heights = [item.sizeHint().height() for item in items if item is not None]
        return QSize(sum(widths) + FIGURE_GAP * max(len(widths) - 1, 0), max(heights, default=0))

    def set(self, label: str, value: str, tone: str | None = None) -> None:
        self.values[label].setText(value)
        set_tone(self.values[label], tone)


class Section(QWidget):
    """A titled group: heading (with its actions on the right), optional caption, then content.

    Hierarchy by type and space; the actions sit on the heading's line so they read as
    belonging to this group, not floating above its content.
    """

    def __init__(self, title: str, caption: str = "") -> None:
        super().__init__()
        self.heading = text(title, "headline")
        self.caption = text(caption, "caption", wrap=True)
        self.caption.setMinimumWidth(160)
        self.caption.setVisible(bool(caption))
        self.action_row = QHBoxLayout()
        self.action_row.setSpacing(SPACE_S)
        top = QHBoxLayout()
        top.setContentsMargins(0, 0, 0, 0)
        top.setSpacing(SPACE_L)
        top.addWidget(self.heading, 0, Qt.AlignmentFlag.AlignBottom)
        top.addStretch(1)
        top.addLayout(self.action_row)
        self.body = QVBoxLayout()
        self.body.setSpacing(SPACE_S)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(SPACE_XS)
        layout.addLayout(top)
        layout.addWidget(self.caption)
        layout.addSpacing(SPACE_S)
        layout.addLayout(self.body)

    def add(self, widget: QWidget, stretch: int = 0) -> None:
        self.body.addWidget(widget, stretch)

    def add_actions(self, *widgets: QWidget) -> None:
        for widget in widgets:
            self.action_row.addWidget(widget)


class Collapsible(QWidget):
    """A section the user can fold: the heading is a toggle, the body hides below it.

    Charts and the tables of their values sit together on the page as collapsible sections
    instead of hiding each other in tabs (docs/16 §3). With a `key`, the open/closed choice is
    remembered on this computer (never in the vault).
    """

    toggled = Signal(bool)

    def __init__(self, title: str, key: str | None = None, *, caption: str = "", expanded: bool = True) -> None:
        super().__init__()
        self._key = key
        self.toggle = QToolButton()
        self.toggle.setObjectName("SectionToggle")
        self.toggle.setText(title)
        self.toggle.setCheckable(True)
        self.toggle.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self.toggle.setAccessibleName(title)
        self.toggle.setToolTip("Mostrar ou ocultar")
        self.toggle.toggled.connect(self._apply)
        self.toggle.clicked.connect(self._remember)  # only the user's own choice is remembered
        self.caption = text(caption, "caption", wrap=True)
        self.caption.setMinimumWidth(160)
        self.action_row = QHBoxLayout()
        self.action_row.setSpacing(SPACE_S)
        top = QHBoxLayout()
        top.setContentsMargins(0, 0, 0, 0)
        top.setSpacing(SPACE_L)
        top.addWidget(self.toggle, 0, Qt.AlignmentFlag.AlignBottom)
        top.addStretch(1)
        top.addLayout(self.action_row)
        self.content = QWidget()
        self.body = QVBoxLayout(self.content)
        self.body.setContentsMargins(0, SPACE_S, 0, 0)
        self.body.setSpacing(SPACE_S)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(SPACE_XS)
        layout.addLayout(top)
        layout.addWidget(self.caption)
        layout.addWidget(self.content, 1)
        self._caption_text = caption
        stored = self._stored()
        self.toggle.setChecked(expanded if stored is None else stored)
        self._apply(self.toggle.isChecked())

    def _stored(self) -> bool | None:
        if self._key is None:
            return None
        from opesvault.ui import preferences

        value = preferences.app_settings().value(f"secoes/{self._key}")
        if value is None:
            return None
        return str(value).lower() in ("true", "1")

    def _apply(self, expanded: bool) -> None:
        self.toggle.setArrowType(Qt.ArrowType.DownArrow if expanded else Qt.ArrowType.RightArrow)
        self.content.setVisible(expanded)
        self.caption.setVisible(expanded and bool(self._caption_text))
        for index in range(self.action_row.count()):
            item = self.action_row.itemAt(index)
            widget = item.widget() if item is not None else None
            if widget is not None:
                widget.setVisible(expanded)
        self.toggled.emit(expanded)

    def _remember(self, expanded: bool) -> None:
        if self._key is not None:
            from opesvault.ui import preferences

            preferences.app_settings().setValue(f"secoes/{self._key}", expanded)

    @property
    def expanded(self) -> bool:
        return self.toggle.isChecked()

    def set_expanded(self, expanded: bool) -> None:
        self.toggle.setChecked(expanded)

    def set_title(self, title: str) -> None:
        self.toggle.setText(title)
        self.toggle.setAccessibleName(title)

    def set_caption(self, caption: str) -> None:
        self._caption_text = caption
        self.caption.setText(caption)
        self.caption.setVisible(self.expanded and bool(caption))

    def add(self, widget: QWidget, stretch: int = 0) -> None:
        self.body.addWidget(widget, stretch)

    def add_actions(self, *widgets: QWidget) -> None:
        for widget in widgets:
            self.action_row.addWidget(widget)
            widget.setVisible(self.expanded)
