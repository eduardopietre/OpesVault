"""Preferences of this computer (QSettings), outside the vault: never financial data.

Window geometry, collapsed sections, hidden columns, the idle lock and, only with consent,
the paths of recent vaults (docs/07 §1). Everything goes through `app_settings()`, so tests
redirect all of it to a temporary file (on Windows QSettings writes to the user's registry).
"""

from pathlib import Path

from PySide6.QtCore import QSettings

ORGANIZATION = "OpesVault"
APPLICATION = "OpesVault"
RECENTS_ENABLED = "recentes/ativo"
RECENTS_LIST = "recentes/lista"
MAX_RECENTS = 8


def app_settings() -> QSettings:
    return QSettings(ORGANIZATION, APPLICATION)


def recents_enabled() -> bool:
    return bool(app_settings().value(RECENTS_ENABLED, False, type=bool))


def set_recents_enabled(enabled: bool) -> None:
    """Turning the list off also forgets what it held."""
    settings = app_settings()
    settings.setValue(RECENTS_ENABLED, enabled)
    if not enabled:
        settings.remove(RECENTS_LIST)


def recent_paths() -> list[str]:
    value = app_settings().value(RECENTS_LIST, [], type=list)
    return [str(item) for item in value] if isinstance(value, list) else []


def remember_vault(path: Path) -> None:
    """Puts `path` first in the recent list, only when the user agreed to keep one."""
    if not recents_enabled():
        return
    others = [p for p in recent_paths() if p != str(path)]
    app_settings().setValue(RECENTS_LIST, [str(path), *others][:MAX_RECENTS])
