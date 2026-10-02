"""Shared UI primitives built on the design tokens (ui/theme.py).

Pages compose these instead of styling widgets one by one, so equivalent things look
and behave the same everywhere.
"""

from collections.abc import Callable, Iterable, Sequence

from PySide6.QtCore import QPoint, QRect, QSize, Qt, Signal
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (
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
        row = QHBoxLayout(self)
        row.setContentsMargins(0, 0, 0, SPACE_XS)
        row.setSpacing(SPACE_L)
        row.addLayout(titles, 1)
        row.addLayout(self.trailing)

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
    """Reserves the height its wrapped rows need at the current width."""

    def resizeEvent(self, event: object) -> None:  # noqa: N802 - Qt override
        layout = self.layout()
        if layout is not None:
            needed = layout.heightForWidth(self.width())
            if needed != self.minimumHeight():
                self.setMinimumHeight(needed)
        super().resizeEvent(event)  # type: ignore[arg-type]


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
