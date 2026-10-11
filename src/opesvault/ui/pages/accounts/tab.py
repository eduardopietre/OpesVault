"""A tab of the Contas e cartões page: it shares the page's session and hooks."""

from typing import TYPE_CHECKING, Any

from PySide6.QtWidgets import QVBoxLayout, QWidget

from opesvault.ui.common import run_guarded
from opesvault.ui.theme import SPACE_L, SPACE_M

if TYPE_CHECKING:
    from opesvault.session import Session
    from opesvault.ui.pages.base import Page


class PageTab(QWidget):
    """Reads the session from its page and reports through it, so a change made in a tab is one
    undo step and its messages reach the status bar like the page's own."""

    def __init__(self, page: "Page") -> None:
        super().__init__()
        self.page = page

    @property
    def session(self) -> "Session | None":
        return self.page.session

    def changed(self) -> None:
        self.page.changed()

    def notify(self, message: str) -> None:
        self.page.notify(message)

    def navigate(self, target: str, ref: object = None, *, act: bool = False) -> None:
        self.page.navigate(target, ref, act=act)

    def run_dialog(self, dialog: Any, message: str | None = None) -> bool:
        """Opens `dialog`; when confirmed and its `apply` succeeds, says `message` and records the change."""
        if dialog.exec() and run_guarded(self, lambda: dialog.apply() or True):
            if message:
                self.notify(message)
            self.changed()
            return True
        return False

    def column(self) -> QVBoxLayout:
        """The tab's layout, with the spacing every tab uses below the tab bar."""
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, SPACE_L, 0, 0)
        layout.setSpacing(SPACE_M)
        return layout

    def refresh(self) -> None:  # pragma: no cover - overridden
        pass
