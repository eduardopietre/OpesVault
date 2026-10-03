"""The sidebar: destinations grouped by section, Settings pinned below, attention counts."""

from collections.abc import Collection, Sequence
from typing import Any

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QFont, QFontMetrics, QPainter
from PySide6.QtWidgets import (
    QListWidget,
    QListWidgetItem,
    QStyle,
    QStyledItemDelegate,
    QStyleOptionViewItem,
    QVBoxLayout,
    QWidget,
)

from opesvault.ui.pages.base import Page
from opesvault.ui.theme import NAV_ROW_HEIGHT, SPACE_S

BADGE_ROLE = Qt.ItemDataRole.UserRole + 1
MAX_WIDTH = 300
SCROLLBAR = 12


def _badge_text(count: int) -> str:
    return str(count) if count < 1000 else "999+"


class SidebarDelegate(QStyledItemDelegate):
    """Draws an attention count at the right edge of a sidebar row."""

    @staticmethod
    def _badge_width(option: QStyleOptionViewItem, count: int) -> int:
        return max(22, option.fontMetrics.horizontalAdvance(_badge_text(count)) + 12)  # type: ignore[attr-defined]

    def initStyleOption(self, option: QStyleOptionViewItem, index: Any) -> None:  # noqa: N802 - Qt override
        """A name never runs under the count: it is cut with "…" before the badge."""
        super().initStyleOption(option, index)
        count = index.data(BADGE_ROLE)
        if count:
            room = option.rect.width() - self._badge_width(option, count) - 28  # type: ignore[attr-defined]
            option.text = option.fontMetrics.elidedText(  # type: ignore[attr-defined]
                option.text,
                Qt.TextElideMode.ElideRight,
                max(room, 20),  # type: ignore[attr-defined]
            )

    def paint(self, painter: QPainter, option: QStyleOptionViewItem, index: Any) -> None:
        super().paint(painter, option, index)
        count = index.data(BADGE_ROLE)
        if not count:
            return
        from opesvault.ui.theme import tokens

        t = tokens()
        rect = option.rect.adjusted(0, 5, -10, -5)  # type: ignore[attr-defined]
        width = self._badge_width(option, count)
        badge = rect.adjusted(rect.width() - width, 0, 0, 0)
        selected = bool(option.state & QStyle.StateFlag.State_Selected)  # type: ignore[attr-defined]
        painter.save()
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(t.accent_text if selected else t.selection_inactive))
        painter.drawRoundedRect(badge, badge.height() / 2, badge.height() / 2)
        painter.setPen(QColor(t.accent if selected else t.text))
        painter.drawText(badge, Qt.AlignmentFlag.AlignCenter, _badge_text(count))
        painter.restore()


class Sidebar(QWidget):
    """Two lists, one selection: the pages by section and, pinned below, the footer pages.

    Rows are addressed by page index; group labels between them are not destinations.
    """

    page_chosen = Signal(int)

    def __init__(self, pages: Sequence[Page], counted: Collection[int] = ()) -> None:
        super().__init__()
        self.setObjectName("Sidebar")
        self.nav = self._list("Sidebar", "Seções")
        # Settings is about the app, not the family's money: pinned below the destinations.
        self.footer = self._list("SidebarFooter", "Configurações")
        self._items: list[QListWidgetItem] = []  # page index -> its row
        self._counted = set(counted)  # pages that may show a count (room is kept for it)
        self._titles = [page.title for page in pages]
        section = None
        for index, page in enumerate(pages):
            target = self.footer if page.footer else self.nav
            if not page.footer and page.section and page.section != section:
                section = page.section
                header = QListWidgetItem(section)
                header.setFlags(Qt.ItemFlag.NoItemFlags)  # a label, not a destination
                self.nav.addItem(header)
            item = QListWidgetItem(page.title)
            item.setData(Qt.ItemDataRole.UserRole, index)
            item.setToolTip(f"{page.title} (Ctrl+{index + 1})" if index < 9 else page.title)
            target.addItem(item)
            self._items.append(item)
        self.footer.setFixedHeight(
            self.footer.count() * (NAV_ROW_HEIGHT + 2) + 2 * SPACE_S + 2 * self.footer.frameWidth() + 1
        )
        column = QVBoxLayout(self)
        column.setContentsMargins(0, 0, 0, 0)
        column.setSpacing(0)
        column.addWidget(self.nav, 1)
        column.addWidget(self.footer)
        self.setMinimumWidth(self.preferred_width())
        self.setMaximumWidth(MAX_WIDTH)

    def _list(self, name: str, accessible: str) -> QListWidget:
        widget = QListWidget()
        widget.setObjectName(name)
        widget.setAccessibleName(accessible)
        widget.setFrameShape(QListWidget.Shape.NoFrame)
        widget.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        widget.setTextElideMode(Qt.TextElideMode.ElideRight)
        widget.setSpacing(1)
        widget.setItemDelegate(SidebarDelegate(widget))
        widget.currentRowChanged.connect(lambda row, w=widget: self._row_changed(w, row))
        return widget

    def item(self, index: int) -> QListWidgetItem:
        """The row of page `index`."""
        return self._items[index]

    def select(self, index: int) -> None:
        if 0 <= index < len(self._items):
            item = self._items[index]
            owner = item.listWidget()
            if owner is not None:
                owner.setCurrentItem(item)

    def _row_changed(self, source: QListWidget, row: int) -> None:
        item = source.item(row)
        index = item.data(Qt.ItemDataRole.UserRole) if item is not None else None
        if not isinstance(index, int):
            return
        other = self.footer if source is self.nav else self.nav
        other.blockSignals(True)
        other.setCurrentRow(-1)
        other.blockSignals(False)
        self.page_chosen.emit(index)

    def set_counts(self, counts: dict[int, int]) -> None:
        """Counts that need attention next to a page name, also told to screen readers."""
        for index, item in enumerate(self._items):
            count = counts.get(index, 0)
            title = self._titles[index]
            item.setData(BADGE_ROLE, count or None)
            item.setData(
                Qt.ItemDataRole.AccessibleTextRole, f"{title}, {count} itens pedem atenção" if count else title
            )

    def preferred_width(self) -> int:
        """Wide enough for the longest name in bold (the selected weight), its count and the scrollbar."""
        font = QFont(self.nav.font())
        font.setWeight(QFont.Weight.DemiBold)
        metrics = QFontMetrics(font)
        badge = metrics.horizontalAdvance("88") + 12 + SPACE_S
        label = max(
            metrics.horizontalAdvance(title) + (badge if index in self._counted else 0)
            for index, title in enumerate(self._titles)
        )
        return min(MAX_WIDTH, label + 4 * SPACE_S + SCROLLBAR + 2 * self.nav.frameWidth())
