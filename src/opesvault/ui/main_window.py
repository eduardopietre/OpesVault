"""Application shell: sidebar navigation, vault lifecycle and save state (docs/07 §1, §7)."""

from collections.abc import Callable
from pathlib import Path
from typing import Any

from PySide6.QtCore import QObject, QRunnable, QSettings, Qt, QThreadPool, QTimer, Signal
from PySide6.QtGui import QAction, QCloseEvent, QKeySequence
from PySide6.QtWidgets import (
    QApplication,
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
from opesvault.ui.common import run_guarded
from opesvault.ui.idle_lock import IdleWatcher, LockPanel, lock_minutes, set_lock_minutes
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
        except Exception as exc:
            from opesvault.diagnostics import record

            record("JOB_FAILED", exc)
            self.signals.failed.emit(ErrorCode.INTERNAL)
        else:
            self.signals.done.emit(result)


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.client = VaultClient()
        self.session: Session | None = None
        self.lock: VaultLock | None = None
        self._vault_busy = False
        self._page_busy_flag = False
        self._jobs: set[_Job] = set()

        self.pages: list[Page] = self.build_pages()
        self.nav = QListWidget()
        self.nav.setMaximumWidth(220)
        self.stack = QStackedWidget()
        for page in self.pages:
            page.set_busy_hook(self._page_busy)
            self.nav.addItem(page.title)
            self.stack.addWidget(page)
        self.nav.currentRowChanged.connect(self._show_page)
        # Ctrl+1..9 jump between sections (keyboard navigation, RNF-08).
        for index in range(min(len(self.pages), 9)):
            shortcut = QAction(self)
            shortcut.setShortcut(QKeySequence(f"Ctrl+{index + 1}"))
            shortcut.triggered.connect(lambda _=False, i=index: self.nav.setCurrentRow(i))
            self.addAction(shortcut)
        self.content = QWidget()
        layout = QHBoxLayout(self.content)
        layout.addWidget(self.nav)
        layout.addWidget(self.stack, 1)
        self.lock_panel = LockPanel()
        self.lock_panel.unlock_requested.connect(self.unlock_screen)
        self.shell = QStackedWidget()
        self.shell.addWidget(self.content)
        self.shell.addWidget(self.lock_panel)
        self.setCentralWidget(self.shell)
        self.locked = False
        self._disabled_actions: list[QAction] = []

        menu = self.menuBar().addMenu("&Cofre")
        self.vault_menu = menu
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
        self.idle = IdleWatcher(self, lock_minutes())
        self.idle.idle.connect(self._on_idle)
        app = QApplication.instance()
        if app is not None:
            app.installEventFilter(self.idle)
        self._refresh()

    @property
    def busy(self) -> bool:
        """A vault operation (open/save/backup) or a page job (import) is running."""
        return self._vault_busy or self._page_busy_flag

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
        menu = self.vault_menu
        menu.addSeparator()
        self._action(menu, "Assistente de configuração…", None, self.run_setup_wizard)
        self._action(menu, "Trocar senha…", None, self.change_password)
        self._action(menu, "Fazer backup agora", None, self.backup_now)
        self._action(menu, "Restaurar backup…", None, self.restore_backup)
        menu.addSeparator()
        self._action(menu, "Exportar livro financeiro (CSV)…", None, lambda: self.export("csv"))
        self._action(menu, "Exportar dados para intercâmbio (JSON)…", None, lambda: self.export("json"))
        menu.addSeparator()
        view = self.menuBar().addMenu("E&xibir")
        self._action(view, "Ocultar conteúdo agora", QKeySequence("Ctrl+L"), self.lock_screen)
        self._action(view, "Bloqueio por inatividade…", None, self.configure_lock)
        help_menu = self.menuBar().addMenu("A&juda")
        self._action(help_menu, "Ajuda desta tela", QKeySequence.StandardKey.HelpContents, self.show_help)
        self._action(help_menu, "Sobre o OpesVault", None, self.show_about)
        self.recent_menu = menu.addMenu("Recentes")
        self.recent_menu.aboutToShow.connect(self._fill_recents)
        self.reminder = QTimer(self)
        self.reminder.timeout.connect(self._remind)
        self.reminder.start(60_000)
        self._dirty_since: float | None = None

    # ── phase 6: lifecycle commands ─────────────────

    @staticmethod
    def app_settings() -> QSettings:
        """Computer-level preferences, outside the vault: never financial data."""
        return QSettings("OpesVault", "OpesVault")

    def _fill_recents(self) -> None:
        self.recent_menu.clear()
        settings = self.app_settings()
        if not settings.value("recentes/ativo", False, type=bool):
            action = self.recent_menu.addAction("Desativado (Configurações)")
            action.setEnabled(False)
            return
        for path in self._recent_paths()[:8]:
            action = self.recent_menu.addAction(str(path))
            action.triggered.connect(lambda _=False, p=str(path): self._open_recent(Path(p)))

    def _recent_paths(self) -> list[str]:
        value = self.app_settings().value("recentes/lista", [], type=list)
        return [str(item) for item in value] if isinstance(value, list) else []

    def _open_recent(self, path: Path) -> None:
        if not self.busy and self._confirm_discard():
            self.open_path(path)

    def _remember(self, path: Path) -> None:
        settings = self.app_settings()
        if not settings.value("recentes/ativo", False, type=bool):
            return
        items = [p for p in self._recent_paths() if p != str(path)]
        settings.setValue("recentes/lista", [str(path), *items][:8])

    def _remind(self) -> None:
        import time

        from opesvault.domain.settings import get_settings

        if self.session is None or not self.session.dirty:
            self._dirty_since = None
            return
        now = time.monotonic()
        if self._dirty_since is None:
            self._dirty_since = now
            return
        minutes = get_settings(self.session.ledger).save_reminder_minutes
        elapsed = int((now - self._dirty_since) // 60)
        if minutes and elapsed >= minutes:
            # Contextual, non-modal: unsaved work is lost if the computer crashes.
            self.statusBar().showMessage(
                f"Alterações não salvas há {elapsed} min. Use Ctrl+S; sem salvar, um travamento perde o trabalho.",
                30_000,
            )

    def _after_open(self, path: Path) -> None:
        from datetime import datetime

        from opesvault.vault.backup import create_backup, remove_candidates, stale_candidates

        assert self.session is not None
        self._remember(path)
        leftovers = stale_candidates(path)
        if leftovers:
            answer = QMessageBox.question(
                self,
                "Salvamento interrompido",
                f"Há {len(leftovers)} arquivo(s) cifrado(s) de um salvamento interrompido ao lado do cofre. "
                "O cofre aberto é a última versão válida. Remover esses arquivos temporários?",
            )
            if answer == QMessageBox.StandardButton.Yes:
                remove_candidates(path, leftovers)
        if self.session.ledger.migrated_from is not None and self.session.revision is not None:
            # Format migration is protected by a backup of the untouched original (RNF-07).
            backup = create_backup(
                path, self.session.revision.revision, path.parent / "backups-migracao", datetime.now()
            )
            QMessageBox.information(
                self,
                "Cofre atualizado",
                "Este cofre usava um formato anterior e foi convertido em memória. "
                f"Uma cópia do original foi guardada em {backup}. A conversão só é gravada quando você salvar.",
            )

    def _after_save(self) -> None:
        from opesvault.domain.settings import get_settings
        from opesvault.vault.backup import create_backup, prune_backups

        session = self.session
        if session is None or session.revision is None:
            return
        self._remember(session.path)
        settings = get_settings(session.ledger)
        if settings.auto_backup and settings.backup_dir:
            try:
                target = Path(settings.backup_dir)
                create_backup(session.path, session.revision.revision, target)
                prune_backups(target, session.path.stem, settings.backup_keep, set(settings.pinned_backups))
            except (OSError, VaultError):
                self.statusBar().showMessage(
                    "Salvo, mas o backup automático falhou. Verifique a pasta de backups.", 30_000
                )

    def backup_now(self) -> None:
        from opesvault.domain.settings import get_settings
        from opesvault.vault.backup import create_backup, prune_backups

        session = self.session
        if session is None or session.revision is None or self.busy:
            return
        if session.dirty:
            QMessageBox.information(
                self, "Backup", "O backup copia a última revisão salva. Salve antes para incluir as alterações."
            )
        settings = get_settings(session.ledger)
        folder = settings.backup_dir or QFileDialog.getExistingDirectory(self, "Pasta de backups")
        if not folder:
            return
        try:
            target = create_backup(session.path, session.revision.revision, Path(folder))
            prune_backups(Path(folder), session.path.stem, settings.backup_keep, set(settings.pinned_backups))
        except (OSError, VaultError):
            QMessageBox.warning(self, "Backup", "Não foi possível criar o backup.")
            return
        QMessageBox.information(self, "Backup", f"Backup da revisão {session.revision.revision} criado:\n{target}")

    def restore_backup(self) -> None:
        if self.busy or not self._confirm_discard():
            return
        name, _ = QFileDialog.getOpenFileName(self, "Backup a restaurar", "", VAULT_FILTER)
        if not name:
            return
        backup = Path(name)

        def load() -> Session | DomainError:
            opened = self.client.open_raw(backup)
            try:
                return Session.from_opened(backup, opened)
            except DomainError as exc:
                return exc

        def loaded(result: Any) -> None:
            from opesvault.vault.backup import copy_for_restore

            if isinstance(result, DomainError):
                QMessageBox.warning(self, "Restaurar", str(result))
                return
            restored: Session = result
            assert restored.revision is not None
            revision = restored.revision
            text = (
                f"Backup válido: revisão {revision.revision}, salva em {revision.saved_at:%d/%m/%Y %H:%M} (UTC).\n"
                "Escolha onde criar o cofre restaurado (um arquivo novo; nada é sobrescrito)."
            )
            QMessageBox.information(self, "Restaurar", text)
            suggested = str(backup.with_name(backup.stem.split(".rev")[0] + "-restaurado.opesvault"))
            dest, _ = QFileDialog.getSaveFileName(self, "Cofre restaurado", suggested, VAULT_FILTER)
            if not dest:
                return
            destination = Path(dest).with_suffix(".opesvault")
            try:
                copy_for_restore(backup, destination)
            except VaultError as exc:
                self._show_error(exc.code)
                return
            self._drop_session()
            if self._take_lock(destination):
                restored.path = destination
                self.session = restored
                self._after_open(destination)

        self._run(load, loaded)

    def change_password(self) -> None:
        session = self.session
        if session is None or self.busy:
            return
        if session.dirty or session.revision is None:
            QMessageBox.information(self, "Trocar senha", "Salve as alterações antes de trocar a senha.")
            return
        base = session.revision.revision_id

        def done(revision: Any) -> None:
            session.revision = revision
            QMessageBox.information(
                self,
                "Trocar senha",
                "Senha trocada. Backups anteriores continuam com a senha antiga. Não há recuperação de senha.",
            )

        self._run(lambda: self.client.change_password(session.path, base), done)

    def export(self, kind: str) -> None:
        if self.session is None:
            return
        from opesvault.exports import interchange_json, ledger_csv

        warning = QMessageBox.question(
            self,
            "Exportar",
            "O arquivo exportado fica fora do cofre, SEM criptografia, e contém dados financeiros. Continuar?",
        )
        if warning != QMessageBox.StandardButton.Yes:
            return
        suffix, label = ("csv", "CSV (*.csv)") if kind == "csv" else ("json", "JSON (*.json)")
        path, _ = QFileDialog.getSaveFileName(self, "Exportar", f"opesvault-exportacao.{suffix}", label)
        if not path:
            return
        data = ledger_csv(self.session.ledger) if kind == "csv" else interchange_json(self.session.ledger)
        try:
            Path(path).write_bytes(data)
        except OSError:
            self._show_error(ErrorCode.IO_ERROR)

    def _action(self, menu: Any, text: str, shortcut: Any, slot: Callable[[], None]) -> QAction:
        action = QAction(text, self)
        if shortcut is not None:
            action.setShortcut(shortcut)
        action.triggered.connect(slot)
        menu.addAction(action)
        return action

    # ── help and visual lock ────────────────────────

    def show_help(self) -> None:
        from opesvault.ui.help import help_for

        page = self.stack.currentWidget()
        title = page.title if isinstance(page, Page) and not self.locked else ""
        box = QMessageBox(self)
        box.setWindowTitle("Ajuda")
        box.setTextFormat(Qt.TextFormat.RichText)
        box.setText(help_for(title))
        box.exec()

    def show_about(self) -> None:
        from opesvault import __version__

        QMessageBox.about(
            self,
            "Sobre o OpesVault",
            f"OpesVault {__version__}\nFinanças familiares offline, com cofre cifrado.\n"
            "Licenças de terceiros: arquivo THIRD_PARTY_LICENSES na pasta de instalação.",
        )

    def configure_lock(self) -> None:
        minutes, ok = QInputDialog.getInt(
            self,
            "Bloqueio por inatividade",
            "Ocultar o conteúdo após quantos minutos sem uso? (0 desliga)\nVale para este computador.",
            self.idle.minutes,
            0,
            240,
        )
        if ok:
            set_lock_minutes(minutes)
            self.idle.minutes = minutes

    def _on_idle(self) -> None:
        if self.session is not None and not self.locked:
            self.lock_screen()

    def lock_screen(self) -> None:
        """Visual lock only (docs/03 §4): the session stays in RAM."""
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
        self.setWindowTitle("OpesVault — bloqueado")
        self.lock_panel.button.setFocus()

    def unlock_screen(self) -> None:
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
        self.shell.setCurrentWidget(self.content)
        self.idle.last_input = self.idle._now()
        self._refresh()

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
        if self.locked:
            return
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
        self._vault_busy = True
        self.status.setText("Aguardando operação do cofre…")
        job = _Job(fn)
        self._jobs.add(job)

        def finish(handler: Callable[[Any], None], value: Any) -> None:
            self._jobs.discard(job)
            self._vault_busy = False
            handler(value)
            self._refresh()

        job.signals.done.connect(lambda v: finish(on_done, v))
        job.signals.failed.connect(lambda code: finish(on_failed or self._show_error, code))
        QThreadPool.globalInstance().start(job)

    def _page_busy(self, busy: bool) -> None:
        """A page is mutating the session off the UI thread (import): no save, no edits."""
        self._page_busy_flag = busy
        self.content.setEnabled(not busy)
        if busy:
            self.status.setText("Processando documento…")
        else:
            self._refresh()

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
            self.run_setup_wizard()
            self.save_vault()

    def run_setup_wizard(self) -> None:
        """First-use wizard; also reachable later to add members, accounts and cards."""
        from opesvault.domain.onboarding import apply_setup
        from opesvault.ui.setup_wizard import SetupWizard

        if self.session is None or self.busy:
            return
        ledger = self.session.ledger
        wizard = SetupWizard(self, ledger)
        if wizard.exec() and run_guarded(self, lambda: apply_setup(ledger, wizard.plan())):
            self.on_changed()

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

        def load() -> Session | DomainError:
            # Decrypting (worker) and parsing (domain) both stay off the UI thread (RNF-05).
            opened = self.client.open_raw(path)
            try:
                return Session.from_opened(path, opened)
            except DomainError as exc:
                return exc

        def opened(result: Any) -> None:
            if isinstance(result, DomainError):
                self._drop_session()
                QMessageBox.warning(self, "OpesVault", str(result))
                return
            self.session = result
            self._after_open(path)

        def failed(code: ErrorCode) -> None:
            self._drop_session()
            self._show_error(code)

        self._run(load, opened, failed)

    def save_vault(self) -> None:
        if self.busy or self.session is None:
            return
        session = self.session
        frozen: FrozenSnapshot = session.freeze()

        def saved(revision: Any) -> None:
            session.mark_saved(frozen, revision)
            self._after_save()

        self._run(lambda: self.client.save_frozen(frozen), saved)

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
