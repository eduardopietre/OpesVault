"""What the window's command groups may use from it, for the type checker only.

Each group (`VaultCommands`, `BackupCommands`, `ScreenLock`, `RecentVaults`) is a mixin of
`MainWindow`. At run time `WindowParts` is plain `object`, so the groups add no Qt base of
their own; while type checking it is a `QMainWindow` that declares the state and the methods
the groups share, so a group calling a part it does not define is still checked.
"""

from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from PySide6.QtGui import QAction
    from PySide6.QtWidgets import QLabel, QMainWindow, QMenu, QStackedWidget, QToolBar, QWidget

    from opesvault.session import Session
    from opesvault.ui.idle_lock import IdleWatcher, LockPanel
    from opesvault.ui.pages.base import Page
    from opesvault.ui.shell.jobs import VaultJob
    from opesvault.ui.shell.welcome import WelcomePanel
    from opesvault.vault.client import VaultClient
    from opesvault.vault.errors import ErrorCode
    from opesvault.vault.lock import VaultLock

    class WindowParts(QMainWindow):
        session: Session | None
        lock: VaultLock | None
        client: VaultClient
        pages: list[Page]
        stack: QStackedWidget
        shell: QStackedWidget
        content: QWidget
        welcome: WelcomePanel
        lock_panel: LockPanel
        toolbar: QToolBar
        status: QLabel
        locked: bool
        idle: IdleWatcher
        recent_menu: QMenu
        _disabled_actions: list[QAction]
        _jobs: set[VaultJob]
        _vault_busy: bool
        _dirty_since: float | None

        @property
        def busy(self) -> bool: ...
        def _refresh(self) -> None: ...
        def notify(self, message: str) -> None: ...
        def navigate(self, target: str, ref: object = None, *, act: bool = False) -> None: ...
        def show_page(self, index: int) -> None: ...
        def on_changed(self) -> None: ...
        def show_alerts_on_open(self) -> None: ...
        # Defined by one group, used by others.
        def _run(
            self,
            fn: Callable[[], Any],
            on_done: Callable[[Any], None],
            on_failed: Callable[[ErrorCode], None] | None = None,
        ) -> None: ...
        def _show_error(self, code: ErrorCode) -> None: ...
        def _confirm_discard(self, action: str = "sair", then: Callable[[], object] | None = None) -> bool: ...
        def _drop_session(self, *, exiting: bool = False) -> None: ...
        def _take_lock(self, path: Path) -> bool: ...
        def _after_open(self, path: Path) -> None: ...
        def _read_vault(self, path: Path) -> Callable[[], Any]: ...
        def open_path(self, path: Path) -> None: ...
        def _auto_backup(self) -> None: ...
        def _remember(self, path: Path) -> None: ...
        def _refresh_welcome(self) -> None: ...

else:
    WindowParts = object
