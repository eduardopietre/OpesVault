"""The small pieces every page uses: text in a style, buttons, menus, separators and rows."""

from collections.abc import Callable, Iterable, Sequence

from PySide6.QtCore import QEvent, QSize, Qt
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QMenu,
    QPushButton,
    QSizePolicy,
    QToolButton,
    QWidget,
)

from opesvault.ui.theme import SPACE_S, restyle

MenuEntry = tuple[str, Callable[[], object]] | tuple[str, Callable[[], object], str] | None


def text(value: str = "", style: str | None = None, *, wrap: bool = False) -> QLabel:
    label = QLabel(value)
    if style:
        label.setProperty("textStyle", style)
    label.setWordWrap(wrap)
    label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
    return label


class ElidedLabel(QLabel):
    """One line that gives way with "…" on a narrow pane; a cut text shows whole in the tooltip.

    Its minimum width is a few characters, so a long name (a file, a project) never sets the
    window's width. `text()` and `setText()` work on the whole text; a screen reader gets it as the
    accessible description, next to any accessible name the caller sets.
    """

    def __init__(self, value: str = "", style: str | None = None, minimum_chars: int = 6) -> None:
        super().__init__()
        self._full = ""
        self._own_tip = ""
        self._minimum_chars = minimum_chars
        if style:
            self.setProperty("textStyle", style)
        self.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)
        self.setText(value)

    def text(self) -> str:  # the whole text; what is painted may be cut
        return self._full

    def setText(self, value: str) -> None:  # noqa: N802 - Qt override
        self._full = value
        self.setAccessibleDescription(value)
        self._elide()
        self.updateGeometry()

    def clear(self) -> None:
        self.setText("")

    def setToolTip(self, value: str) -> None:  # noqa: N802 - Qt override
        """A tooltip of the caller's (a full path) wins over the automatic one."""
        self._own_tip = value
        self._elide()

    def _elide(self) -> None:
        shown = self.fontMetrics().elidedText(self._full, Qt.TextElideMode.ElideRight, max(0, self.width()))
        super().setText(shown)
        super().setToolTip(self._own_tip or (self._full if shown != self._full else ""))

    def minimumSizeHint(self) -> QSize:  # noqa: N802 - Qt override
        metrics = self.fontMetrics()
        width = min(metrics.horizontalAdvance("M" * self._minimum_chars), metrics.horizontalAdvance(self._full))
        return QSize(width, super().minimumSizeHint().height())

    def sizeHint(self) -> QSize:  # noqa: N802 - Qt override
        return QSize(self.fontMetrics().horizontalAdvance(self._full) + 2, super().sizeHint().height())

    def resizeEvent(self, event: object) -> None:  # noqa: N802 - Qt override
        super().resizeEvent(event)  # type: ignore[arg-type]
        self._elide()

    def changeEvent(self, event: QEvent) -> None:  # noqa: N802 - Qt override
        super().changeEvent(event)
        if event.type() in (QEvent.Type.FontChange, QEvent.Type.StyleChange):
            self._elide()  # the theme's text style changes the font after construction


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


def hbox_widget(*items: QWidget | int | None, spacing: int = SPACE_S) -> QWidget:
    host = QWidget()
    host.setLayout(hbox(*items, spacing=spacing))
    return host
