"""Application shell: sidebar navigation, vault lifecycle and save state (docs/07 §1, §7)."""

from collections.abc import Callable
from pathlib import Path
from typing import Any

from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal
from PySide6.QtGui import QAction, QCloseEvent, QKeySequence
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QListWidget,
    QMainWindow,
    QMessageBox,
    QStackedWidget,
    QWidget,
)

from opesvault.domain.ledger import DomainError
from opesvault.session import FrozenSnapshot, Session
from opesvault.ui.pages.accounts_page import AccountsPage
from opesvault.ui.pages.base import Page
from opesvault.ui.pages.documents_page import DocumentsPage
from opesvault.ui.pages.import_page import ImportPage
from opesvault.ui.pages.investments_page import InvestmentsPage
from opesvault.ui.pages.ledger_page import LedgerPage
from opesvault.ui.pages.overview_page import OverviewPage
from opesvault.ui.pages.recurrences_page import RecurrencesPage
from opesvault.ui.pages.reports_page import ReportsPage
from opesvault.ui.pages.settings_page import SettingsPage
from opesvault.vault.client import VaultClient
from opesvault.vault.errors import ErrorCode, VaultError
from opesvault.vault.lock import VaultLock

VAULT_FILTER = "Cofre OpesVault (*.opesvault)"

ERROR_MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.CANCELLED: "Operação cancelada. Nada foi alterado.",
    ErrorCode.WRONG_PASSWORD: "Senha incorreta. O arquivo não foi alterado.",
    ErrorCode.NOT_FOUND: "Arquivo do cofre não encontrado.",
    ErrorCode.ALREADY_EXISTS: "Já existe um arquivo com esse nome.",
    ErrorCode.NOT_A_VAULT: "O arquivo não é um cofre OpesVault válido.",
    ErrorCode.INCOMPATIBLE_FORMAT: "Este cofre foi criado por uma versão mais nova do OpesVault.",
    ErrorCode.REVISION_MISMATCH: "O cofre foi alterado fora desta sessão. Nada foi sobrescrito.",
    ErrorCode.VERIFY_FAILED: "A verificação da nova versão falhou. O cofre anterior foi mantido.",
    ErrorCode.REPLACE_FAILED: (
        "Não foi possível substituir o arquivo (antivírus ou permissão?). O cofre anterior foi mantido."
    ),
    ErrorCode.LOCKED: "Este cofre já está aberto em outra janela do OpesVault.",
    ErrorCode.IO_ERROR: "Erro de leitura ou gravação (disco cheio ou removido?).",
    ErrorCode.UNCERTAIN: (
        "Não foi possível confirmar o salvamento. Reabra o cofre para conferir antes de tentar de novo."
    ),
}


class _Signals(QObject):
    done = Signal(object)
    failed = Signal(object)


class _Job(QRunnable):
    def __init__(self, fn: Callable[[], Any]) -> None:
        super().__init__()
        self.fn = fn
        self.signals = _Signals()

    def run(self) -> None:
        try:
            result = self.fn()
        except VaultError as exc:
            self.signals.failed.emit(exc.code)
        except Exception:
            self.signals.failed.emit(ErrorCode.INTERNAL)
        else:
            self.signals.done.emit(result)


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.client = VaultClient()
        self.session: Session | None = None
        self.lock: VaultLock | None = None
        self.busy = False
        self._jobs: set[_Job] = set()

        self.pages: list[Page] = self.build_pages()
        self.nav = QListWidget()
        self.nav.setMaximumWidth(220)
        self.stack = QStackedWidget()
        for page in self.pages:
            self.nav.addItem(page.title)
            self.stack.addWidget(page)
        self.nav.currentRowChanged.connect(self._show_page)
        central = QWidget()
        layout = QHBoxLayout(central)
        layout.addWidget(self.nav)
        layout.addWidget(self.stack, 1)
        self.setCentralWidget(central)

        menu = self.menuBar().addMenu("&Cofre")
        self._action(menu, "&Novo cofre…", QKeySequence.StandardKey.New, self.new_vault)
        self._action(menu, "&Abrir cofre…", QKeySequence.StandardKey.Open, self.open_vault)
        self._action(menu, "&Salvar", QKeySequence.StandardKey.Save, self.save_vault)
        self._action(menu, "&Fechar cofre", None, self.close_vault)
        self.extend_menus()

        self.operator = QComboBox()
        self.operator.currentIndexChanged.connect(self._set_operator)
        self.status = QLabel()
        self.statusBar().addWidget(QLabel("Operador:"))
        self.statusBar().addWidget(self.operator)
        self.statusBar().addPermanentWidget(self.status)
        self.resize(1280, 800)
        self.nav.setCurrentRow(0)
        self._refresh()

    def build_pages(self) -> list[Page]:
        """Pages in sidebar order; later phases extend this list."""
        return [
            OverviewPage(self.on_changed),
            LedgerPage(self.on_changed),
            ImportPage(self.on_changed),
            AccountsPage(self.on_changed),
            RecurrencesPage(self.on_changed),
            InvestmentsPage(self.on_changed),
            ReportsPage(self.on_changed),
            DocumentsPage(self.on_changed),
            SettingsPage(self.on_changed),
        ]

    def extend_menus(self) -> None:
        """Hook for later phases to add commands."""

    def _action(self, menu: Any, text: str, shortcut: Any, slot: Callable[[], None]) -> QAction:
        action = QAction(text, self)
        if shortcut is not None:
            action.setShortcut(shortcut)
        action.triggered.connect(slot)
        menu.addAction(action)
        return action

    def _show_page(self, row: int) -> None:
        if 0 <= row < len(self.pages):
            self.stack.setCurrentIndex(row)
            self.pages[row].refresh()

    # ── state ───────────────────────────────────────────

    def on_changed(self) -> None:
        current = self.stack.currentWidget()
        if isinstance(current, Page):
            current.refresh()
        self._refresh()

    def _set_operator(self) -> None:
        if self.session is not None:
            self.session.ledger.operator = self.operator.currentText() or None

    def _refresh(self) -> None:
        for page in self.pages:
            if page.session is not self.session:
                page.set_session(self.session)
        if self.session is None:
            self.setWindowTitle("OpesVault")
            self.status.setText("Nenhum cofre aberto · use Cofre › Novo ou Abrir")
            self.operator.clear()
            return
        names = [m.name for m in self.session.ledger.members.values() if m.active]
        if [self.operator.itemText(i) for i in range(self.operator.count())] != names:
            current = self.session.ledger.operator
            self.operator.blockSignals(True)
            self.operator.clear()
            self.operator.addItems(names)
            if current in names:
                self.operator.setCurrentText(current)
            self.operator.blockSignals(False)
            self._set_operator()
        state = "Não salvo" if self.session.dirty else "Salvo"
        rev = self.session.revision.revision if self.session.revision else "—"
        family = self.session.ledger.meta.family_name
        self.setWindowTitle(f"OpesVault — {family} ({self.session.path.name}){' *' if self.session.dirty else ''}")
        self.status.setText(f"{state} · revisão {rev}")

    def _run(
        self,
        fn: Callable[[], Any],
        on_done: Callable[[Any], None],
        on_failed: Callable[[ErrorCode], None] | None = None,
    ) -> None:
        self.busy = True
        self.status.setText("Aguardando operação do cofre…")
        job = _Job(fn)
        self._jobs.add(job)

        def finish(handler: Callable[[Any], None], value: Any) -> None:
            self._jobs.discard(job)
            self.busy = False
            handler(value)
            self._refresh()

        job.signals.done.connect(lambda v: finish(on_done, v))
        job.signals.failed.connect(lambda code: finish(on_failed or self._show_error, code))
        QThreadPool.globalInstance().start(job)

    def _show_error(self, code: ErrorCode) -> None:
        if code is ErrorCode.CANCELLED:
            return
        QMessageBox.warning(self, "OpesVault", ERROR_MESSAGES.get(code, f"Erro inesperado ({code})."))

    def _take_lock(self, path: Path) -> bool:
        lock = VaultLock(path)
        try:
            lock.acquire()
        except VaultError as exc:
            self._show_error(exc.code)
            return False
        self.lock = lock
        return True

    def _drop_session(self) -> None:
        self.session = None
        if self.lock is not None:
            self.lock.release()
            self.lock = None

    def _confirm_discard(self) -> bool:
        """Returns True when it is fine to drop the current session."""
        if self.session is None or not self.session.dirty:
            return True
        choice = QMessageBox.question(
            self,
            "OpesVault",
            "Há alterações não salvas. Salvar exige a senha do cofre.",
            QMessageBox.StandardButton.Save | QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
        )
        if choice == QMessageBox.StandardButton.Save:
            self.save_vault()
            return False  # Saving is asynchronous; the user repeats the action afterwards.
        return choice == QMessageBox.StandardButton.Discard

    # ── commands ────────────────────────────────────────

    def new_vault(self) -> None:
        if self.busy or not self._confirm_discard():
            return
        name, _ = QFileDialog.getSaveFileName(self, "Novo cofre", "", VAULT_FILTER)
        if not name:
            return
        family, ok = QInputDialog.getText(self, "Novo cofre", "Nome da família ou pessoa:")
        if not ok or not family.strip():
            return
        path = Path(name).with_suffix(".opesvault")
        if path.exists():
            self._show_error(ErrorCode.ALREADY_EXISTS)
            return
        self._drop_session()
        if self._take_lock(path):
            self.session = Session.new(path, family.strip())
            self._refresh()
            self.save_vault()

    def open_vault(self) -> None:
        if self.busy or not self._confirm_discard():
            return
        name, _ = QFileDialog.getOpenFileName(self, "Abrir cofre", "", VAULT_FILTER)
        if name:
            self.open_path(Path(name))

    def open_path(self, path: Path) -> None:
        self._drop_session()
        self._refresh()
        if not self._take_lock(path):
            return

        def opened(result: Any) -> None:
            revision, snapshot = result
            try:
                self.session = Session.from_snapshot(path, revision, snapshot)
            except DomainError as exc:
                self._drop_session()
                QMessageBox.warning(self, "OpesVault", str(exc))

        def failed(code: ErrorCode) -> None:
            self._drop_session()
            self._show_error(code)

        self._run(lambda: self.client.open(path), opened, failed)

    def save_vault(self) -> None:
        if self.busy or self.session is None:
            return
        session = self.session
        frozen: FrozenSnapshot = session.freeze()
        self._run(
            lambda: self.client.save(session.path, frozen.snapshot, frozen.base_revision_id),
            lambda revision: session.mark_saved(frozen, revision),
        )

    def close_vault(self) -> None:
        if self.busy or not self._confirm_discard():
            return
        self._drop_session()
        self._refresh()

    def closeEvent(self, event: QCloseEvent) -> None:  # noqa: N802 - Qt override
        if self.busy or not self._confirm_discard():
            event.ignore()
            return
        self._drop_session()
        event.accept()
