from collections.abc import Callable

from PySide6.QtWidgets import QVBoxLayout, QWidget

from opesvault.session import Session
from opesvault.ui.components import PageHeader, page_margins


class Page(QWidget):
    """A sidebar page. `changed` must be called after any edit so the shell refreshes.

    Every page has the same frame: a header (title, context line, page actions) and
    its content below, built with `page_layout()`.
    """

    title = ""
    subtitle = ""
    section = ""  # sidebar group

    def __init__(self, changed: Callable[[], None]) -> None:
        super().__init__()
        self.setObjectName("Page")
        self.session: Session | None = None
        self._changed = changed
        self._busy_hook: Callable[[bool], None] | None = None
        self._notify_hook: Callable[[str], None] | None = None
        self._navigate_hook: Callable[[str], None] | None = None
        self.header = PageHeader(self.title, self.subtitle)

    def page_layout(self) -> QVBoxLayout:
        layout = QVBoxLayout(self)
        page_margins(layout)
        layout.addWidget(self.header)
        return layout

    def set_busy_hook(self, hook: Callable[[bool], None]) -> None:
        self._busy_hook = hook

    def set_notify_hook(self, hook: Callable[[str], None]) -> None:
        self._notify_hook = hook

    def set_navigate_hook(self, hook: Callable[[str], None]) -> None:
        self._navigate_hook = hook

    def navigate(self, target: str) -> None:
        """Opens another section by key ("budget", "import", "accounts", "recurrences", "ledger")."""
        if self._navigate_hook is not None:
            self._navigate_hook(target)

    def set_busy(self, busy: bool) -> None:
        """Background work that mutates the session must block saving and other edits."""
        if self._busy_hook is not None:
            self._busy_hook(busy)

    def notify(self, message: str) -> None:
        """Brief, non-blocking confirmation of what an action did (status bar)."""
        if self._notify_hook is not None:
            self._notify_hook(message)

    def focus_search(self) -> bool:
        """Ctrl+F: pages with a search field focus it and return True."""
        return False

    def set_session(self, session: Session | None) -> None:
        self.session = session
        self.refresh()

    def refresh(self) -> None:  # pragma: no cover - overridden
        pass

    def changed(self) -> None:
        self._changed()
