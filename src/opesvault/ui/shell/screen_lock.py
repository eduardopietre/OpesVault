"""Visual lock (docs/03 §4): hides the content after idle time; the session stays in RAM."""

from PySide6.QtGui import QAction

from opesvault.ui.shell.contract import WindowParts
from opesvault.vault.errors import ErrorCode


class ScreenLock(WindowParts):
    def configure_lock(self) -> None:
        """The idle lock is set in one place: Configurações, privacy of this computer."""
        from opesvault.ui.pages.settings_page import SettingsPage

        for index, page in enumerate(self.pages):
            if isinstance(page, SettingsPage):
                self.show_page(index)
                page.show_privacy()

    def _on_idle(self) -> None:
        if self.session is not None and not self.locked:
            self.lock_screen()

    def lock_screen(self) -> None:
        if self.locked:
            return
        self.locked = True
        session = self.session
        self.lock_panel.describe(
            needs_password=session is not None and session.revision is not None,
            unsaved=session is not None and session.dirty,
        )
        self.shell.setCurrentWidget(self.lock_panel)
        self._disabled_actions = [a for a in self.findChildren(QAction) if a.isEnabled()]
        for action in self._disabled_actions:
            action.setEnabled(False)
        self.statusBar().hide()
        self.toolbar.hide()
        self.setWindowTitle("OpesVault — bloqueado")
        self.lock_panel.button.setFocus()

    def unlock_screen(self) -> None:
        """A saved vault asks its password again (in the worker); an unsaved one just shows."""
        if not self.locked or self._vault_busy:
            return
        session = self.session
        if session is None or session.revision is None:
            self._show_content()
            return
        revision_id = session.revision.revision_id

        def failed(code: ErrorCode) -> None:
            if code is not ErrorCode.CANCELLED:
                self._show_error(code)
            self.lock_panel.button.setFocus()

        self._run(lambda: self.client.unlock(session.path, revision_id), lambda _: self._show_content(), failed)

    def _show_content(self) -> None:
        self.locked = False
        for action in self._disabled_actions:
            action.setEnabled(True)
        self._disabled_actions = []
        self.statusBar().show()
        self.toolbar.show()
        self.shell.setCurrentWidget(self.content)
        self.idle.last_input = self.idle._now()
        self._refresh()
