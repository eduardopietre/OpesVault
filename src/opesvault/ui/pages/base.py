from collections.abc import Callable

from PySide6.QtWidgets import QWidget

from opesvault.session import Session


class Page(QWidget):
    """A sidebar page. `changed` must be called after any edit so the shell refreshes."""

    title = ""

    def __init__(self, changed: Callable[[], None]) -> None:
        super().__init__()
        self.session: Session | None = None
        self._changed = changed

    def set_session(self, session: Session | None) -> None:
        self.session = session
        self.refresh()

    def refresh(self) -> None:  # pragma: no cover - overridden
        pass

    def changed(self) -> None:
        self._changed()
