"""Recent vaults: the File › Recentes menu and the welcome list, only with consent (docs/07 §1)."""

from pathlib import Path

from opesvault.ui import preferences
from opesvault.ui.shell.contract import WindowParts


class RecentVaults(WindowParts):
    def _fill_recents(self) -> None:
        self.recent_menu.clear()
        if not preferences.recents_enabled():
            action = self.recent_menu.addAction("Desativado (Configurações)")
            action.setEnabled(False)
            return
        for path in preferences.recent_paths()[: preferences.MAX_RECENTS]:
            action = self.recent_menu.addAction(path)
            action.triggered.connect(lambda _=False, p=path: self._open_recent(Path(p)))

    def _open_recent(self, path: Path) -> None:
        if not self.busy and self._confirm_discard("abrir outro cofre", lambda: self._open_recent(path)):
            self.open_path(path)

    def _remember(self, path: Path) -> None:
        preferences.remember_vault(path)

    def _refresh_welcome(self) -> None:
        self.welcome.show_recents(preferences.recent_paths(), enabled=preferences.recents_enabled())

    def _consent_recents(self, enabled: bool) -> None:
        preferences.app_settings().setValue(preferences.RECENTS_ENABLED, enabled)
        self.notify("Os próximos cofres abertos aparecerão aqui. Para desligar, use Configurações.")
