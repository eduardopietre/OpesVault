"""Shared UI primitives built on the design tokens (ui/theme.py).

Pages compose these instead of styling widgets one by one, so equivalent things look
and behave the same everywhere.
"""

from collections.abc import Callable, Iterable, Sequence

from PySide6.QtCore import QEvent, QPoint, QRect, QSize, Qt, Signal
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (
    QBoxLayout,
    QDialog,
    QDialogButtonBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLayout,
    QLayoutItem,
    QMenu,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSpacerItem,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from opesvault.ui.theme import SPACE_L, SPACE_M, SPACE_S, SPACE_XL, SPACE_XS, SPACE_XXL, restyle

FIGURE_GAP = SPACE_XL + SPACE_S  # between key figures of one group

# (label, slot) or (label, slot, shortcut); None draws a separator.
MenuEntry = tuple[str, Callable[[], object]] | tuple[str, Callable[[], object], str] | None


def text(value: str = "", style: str | None = None, *, wrap: bool = False) -> QLabel:
    label = QLabel(value)
    if style:
        label.setProperty("textStyle", style)
    label.setWordWrap(wrap)
    label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
    return label


def set_tone(label: QLabel, tone: str | None) -> None:
    """positive / negative / warning, always paired with text or a sign, never color alone."""
    label.setProperty("tone", tone or "")
    restyle(label)


def separator() -> QFrame:
    line = QFrame()
    line.setObjectName("Separator")
    line.setFrameShape(QFrame.Shape.NoFrame)
    return line


def vseparator() -> QFrame:
    """A thin vertical rule between groups of controls (toolbar)."""
    line = QFrame()
    line.setObjectName("VSeparator")
    line.setFrameShape(QFrame.Shape.NoFrame)
    line.setFixedHeight(20)
    return line


def button(
    label: str, slot: Callable[[], object] | None = None, *, role: str | None = None, tip: str = ""
) -> QPushButton:
    widget = QPushButton(label)
    if role:
        widget.setProperty("role", role)
    if slot is not None:
        widget.clicked.connect(lambda _=False: slot())
    if tip:
        widget.setToolTip(tip)
    widget.setAutoDefault(False)
    return widget


def fill_menu(menu: QMenu, entries: Iterable[MenuEntry]) -> list[QAction]:
    actions = []
    for entry in entries:
        if entry is None:
            menu.addSeparator()
            continue
        action = menu.addAction(entry[0])
        action.triggered.connect(lambda _=False, slot=entry[1]: slot())
        if len(entry) == 3:
            action.setShortcut(QKeySequence(entry[2]))  # type: ignore[misc]
            action.setShortcutVisibleInContextMenu(True)
        actions.append(action)
    return actions


def menu_button(label: str, entries: Sequence[MenuEntry], *, tip: str = "") -> QToolButton:
    """A button that opens a menu: groups secondary commands without hiding them."""
    widget = QToolButton()
    widget.setObjectName("Action")
    widget.setText(label)
    widget.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
    widget.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextOnly)
    menu = QMenu(widget)
    fill_menu(menu, entries)
    widget.setMenu(menu)
    if tip:
        widget.setToolTip(tip)
    return widget


def hbox(*items: QWidget | int | None, spacing: int = SPACE_S) -> QHBoxLayout:
    """Widgets in a row; an int adds fixed space, None adds a stretch."""
    row = QHBoxLayout()
    row.setContentsMargins(0, 0, 0, 0)
    row.setSpacing(spacing)
    for item in items:
        if item is None:
            row.addStretch(1)
        elif isinstance(item, int):
            row.addSpacing(item)
        else:
            row.addWidget(item)
    return row


class PageHeader(QWidget):
    """Where am I (title), what am I looking at (context), what can I do (trailing actions)."""

    def __init__(self, title: str, subtitle: str = "") -> None:
        super().__init__()
        self.title = text(title, "title")
        self.title.setAccessibleName(title)
        self.subtitle = text(subtitle, "secondary", wrap=True)  # wraps instead of widening the window
        self.subtitle.setMinimumWidth(160)
        self.subtitle.setVisible(bool(subtitle))
        self.trailing = QHBoxLayout()
        self.trailing.setSpacing(SPACE_S)
        titles = QVBoxLayout()
        titles.setSpacing(2)
        titles.addWidget(self.title)
        titles.addWidget(self.subtitle)
        # The actions sit on the title's line; when the window is too narrow for both, they move
        # below the title instead of setting the window's minimum width.
        self.row = QBoxLayout(QBoxLayout.Direction.LeftToRight, self)
        self.row.setContentsMargins(0, 0, 0, SPACE_XS)
        self.row.setSpacing(SPACE_L)
        self.row.setSizeConstraint(QLayout.SizeConstraint.SetNoConstraint)
        self.row.addLayout(titles, 1)
        self.row.addLayout(self.trailing)
        self._titles = titles

    def _side_by_side_width(self) -> int:
        return self.title.sizeHint().width() + self.row.spacing() + self.trailing.sizeHint().width()

    def _fit(self) -> None:
        wide = self.width() >= self._side_by_side_width()
        direction = QBoxLayout.Direction.LeftToRight if wide else QBoxLayout.Direction.TopToBottom
        if self.row.direction() != direction:
            self.row.setDirection(direction)
            self.row.setStretchFactor(self._titles, 1 if wide else 0)
            self.row.setSpacing(SPACE_L if wide else SPACE_S)
            self.trailing.setAlignment(Qt.AlignmentFlag.AlignRight if wide else Qt.AlignmentFlag.AlignLeft)
            self.updateGeometry()

    def resizeEvent(self, event: object) -> None:  # noqa: N802 - Qt override
        self._fit()
        super().resizeEvent(event)  # type: ignore[arg-type]

    def minimumSizeHint(self) -> QSize:  # noqa: N802 - Qt override
        margins = self.row.contentsMargins()
        width = max(self._titles.minimumSize().width(), self.trailing.minimumSize().width())
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
                self.trailing.addSpacing(widget)
            else:
                self.trailing.addWidget(widget, alignment=Qt.AlignmentFlag.AlignVCenter)


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
        from PySide6.QtCore import QSettings

        value = QSettings("OpesVault", "OpesVault").value(f"secoes/{self._key}")
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
            from PySide6.QtCore import QSettings

            QSettings("OpesVault", "OpesVault").setValue(f"secoes/{self._key}", expanded)

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


def expanding(widget: QWidget) -> QWidget:
    widget.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
    return widget


class MonthPicker(QWidget):
    """‹ month ›: steps through competence months; the combo jumps further."""

    changed = Signal()

    def __init__(self, months_back: int = 60, months_ahead: int = 0) -> None:
        from datetime import date

        from PySide6.QtWidgets import QComboBox

        from opesvault.domain.model import YearMonth
        from opesvault.ui.common import month_label

        super().__init__()
        self.combo = QComboBox()
        self.combo.setAccessibleName("Mês")
        today = YearMonth.of(date.today())
        for offset in range(months_back, -months_ahead - 1, -1):
            month = today.add(-offset)
            self.combo.addItem(month_label(month), month)
        self.combo.setCurrentIndex(months_back)  # today
        self.combo.setMinimumContentsLength(16)
        previous = QToolButton()
        previous.setObjectName("Stepper")
        previous.setText("‹")
        previous.setToolTip("Mês anterior (Alt+←)")
        previous.setAccessibleName("Mês anterior")
        previous.setShortcut(QKeySequence("Alt+Left"))
        previous.clicked.connect(lambda: self.step(-1))
        following = QToolButton()
        following.setObjectName("Stepper")
        following.setText("›")
        following.setToolTip("Próximo mês (Alt+→)")
        following.setAccessibleName("Próximo mês")
        following.setShortcut(QKeySequence("Alt+Right"))
        following.clicked.connect(lambda: self.step(1))
        self.combo.setMinimumHeight(previous.sizeHint().height())
        row = hbox(previous, self.combo, following, spacing=2)
        self.setLayout(row)
        self.combo.currentIndexChanged.connect(lambda _: self.changed.emit())

    def current(self):  # type: ignore[no-untyped-def]
        return self.combo.currentData()

    def set_month(self, month: object) -> None:
        # findData compares wrapped Python objects by identity; compare values instead.
        for index in range(self.combo.count()):
            if self.combo.itemData(index) == month:
                self.combo.setCurrentIndex(index)
                return

    def step(self, delta: int) -> None:
        index = self.combo.currentIndex() + delta
        if 0 <= index < self.combo.count():
            self.combo.setCurrentIndex(index)


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


class _FlowHost(QWidget):
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
    host = _FlowHost()
    flow = FlowLayout(host, spacing, line_spacing)
    for widget in widgets:
        flow.addWidget(widget)
    host.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
    return host


def hbox_widget(*items: QWidget | int | None, spacing: int = SPACE_S) -> QWidget:
    host = QWidget()
    host.setLayout(hbox(*items, spacing=spacing))
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
Choice = tuple[str, str, str]


class Decision(QDialog):
    """A question as the title, the consequence below, and buttons named by what they do.

    No icon: the title already says it is a decision. Replaces QMessageBox.question, whose
    Yes/No buttons and generic title make the user read the body to know what is asked.
    """

    def __init__(self, parent: QWidget | None, title: str, message: str, choices: Sequence[Choice]) -> None:
        super().__init__(parent)
        self.setWindowTitle("OpesVault")
        self.choice: str | None = None
        heading = text(title, "headline", wrap=True)
        heading.setAccessibleName(title)
        body = text(message, "secondary", wrap=True)
        body.setVisible(bool(message))
        buttons = QDialogButtonBox()
        roles = {
            "accept": QDialogButtonBox.ButtonRole.AcceptRole,
            "destructive": QDialogButtonBox.ButtonRole.DestructiveRole,
            "reject": QDialogButtonBox.ButtonRole.RejectRole,
        }
        for key, label, role in choices:
            widget = buttons.addButton(label, roles[role])
            if widget is None:
                continue
            widget.setAutoDefault(False)
            if role == "accept":
                widget.setProperty("role", "primary")
                widget.setDefault(True)
            widget.clicked.connect(lambda _=False, k=key: self._choose(k))
        buttons.rejected.connect(self.reject)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(SPACE_XL, SPACE_XL, SPACE_XL, SPACE_L)
        layout.setSpacing(SPACE_S)
        layout.addWidget(heading)
        layout.addWidget(body)
        layout.addSpacing(SPACE_L)
        layout.addWidget(buttons)
        self.setMinimumWidth(420)
        self.setMaximumWidth(560)

    def _choose(self, key: str) -> None:
        self.choice = key
        self.accept()


def decide(parent: QWidget | None, title: str, message: str, choices: Sequence[Choice]) -> str | None:
    """Shows a `Decision` and returns the chosen key, or None when cancelled (Esc, close)."""
    dialog = Decision(parent, title, message, choices)
    dialog.exec()
    choice = dialog.choice
    dialog.deleteLater()
    return choice


def confirm(parent: QWidget | None, title: str, message: str, action: str) -> bool:
    """A yes/cancel decision whose confirm button is the action itself ("Exportar", "Vincular")."""
    return decide(parent, title, message, [("ok", action, "accept"), ("cancel", "Cancelar", "reject")]) == "ok"
