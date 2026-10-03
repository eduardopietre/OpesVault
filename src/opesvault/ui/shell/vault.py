"""Vault lifecycle commands: create, open, save, close, change password and export.

Every vault operation runs in the transient worker (it asks the password) through `_run`, off
the UI thread; the window never sees the password (docs/03).
"""

import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from PySide6.QtCore import QThreadPool, QTimer
from PySide6.QtWidgets import QFileDialog, QInputDialog, QMessageBox

from opesvault.domain.ledger import DomainError
from opesvault.session import FrozenSnapshot, Session
from opesvault.ui.common import run_guarded
from opesvault.ui.components import confirm, decide
from opesvault.ui.shell.contract import WindowParts
from opesvault.ui.shell.errors import show_error
from opesvault.ui.shell.jobs import VaultJob
from opesvault.vault.errors import ErrorCode, VaultError
from opesvault.vault.lock import VaultLock

VAULT_FILTER = "Cofre OpesVault (*.opesvault)"


class VaultCommands(WindowParts):
    # ── running vault work ──────────────────────────

    def _run(
        self,
        fn: Callable[[], Any],
        on_done: Callable[[Any], None],
        on_failed: Callable[[ErrorCode], None] | None = None,
    ) -> None:
        """Runs `fn` in the thread pool; the window is busy (no save, no edits) until it ends."""
        self._vault_busy = True
        self.status.setText("Aguardando o cofre…")
        job = VaultJob(fn)
        self._jobs.add(job)

        def finish(handler: Callable[[Any], None], value: Any) -> None:
            self._jobs.discard(job)
            self._vault_busy = False
            handler(value)
            self._refresh()

        job.signals.done.connect(lambda v: finish(on_done, v))
        job.signals.failed.connect(lambda code: finish(on_failed or self._show_error, code))
        QThreadPool.globalInstance().start(job)

    def _read_vault(self, path: Path) -> Callable[[], Session | DomainError]:
        """Decrypting (worker) and parsing (domain) both stay off the UI thread (RNF-05)."""

        def load() -> Session | DomainError:
            opened = self.client.open_raw(path)
            try:
                return Session.from_opened(path, opened)
            except DomainError as exc:
                return exc

        return load

    def _show_error(self, code: ErrorCode) -> None:
        show_error(self, code)

    def _take_lock(self, path: Path) -> bool:
        lock = VaultLock(path)
        try:
            lock.acquire()
        except VaultError as exc:
            self._show_error(exc.code)
            return False
        self.lock = lock
        return True

    def _drop_session(self, *, exiting: bool = False) -> None:
        from opesvault.importing.ai_suggestions import release_models

        self.session = None
        release_models(wait=exiting)  # Ollama also drops the descriptions it still caches
        if self.lock is not None:
            self.lock.release()
            self.lock = None

    def _flush_pages(self) -> None:
        """Edits a page is still gathering (a setting being typed) enter the session first."""
        if self.session is not None and not self.busy:
            for page in self.pages:
                page.flush()

    def _confirm_discard(self, action: str = "sair", then: Callable[[], object] | None = None) -> bool:
        """Returns True when it is fine to drop the current session.

        `action` completes "Salvar alterações antes de …?" with what the user is doing. When
        the user chooses to save, `then` repeats that action once the vault is written, so
        "Salvar…" really means "save and carry on".
        """
        self._flush_pages()
        if self.session is None or not self.session.dirty:
            return True
        choice = decide(
            self,
            f"Salvar alterações antes de {action}?",
            "Há alterações não salvas neste cofre. Para salvá-las, você precisará informar a senha.",
            [
                ("save", "Salvar…", "accept"),
                ("discard", "Descartar alterações", "destructive"),
                ("cancel", "Cancelar", "reject"),
            ],
        )
        if choice == "save":
            self.save_vault(then)
            return False  # Saving is asynchronous; `then` resumes the action after it.
        return choice == "discard"

    # ── commands ────────────────────────────────────

    def new_vault(self) -> None:
        if self.busy or not self._confirm_discard("criar outro cofre", self.new_vault):
            return
        name, _ = QFileDialog.getSaveFileName(self, "Novo cofre", "", VAULT_FILTER)
        if not name:
            return
        family, ok = QInputDialog.getText(self, "Novo cofre", "Nome do projeto:")
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
        wizard.deleteLater()

    def open_vault(self) -> None:
        if self.busy or not self._confirm_discard("abrir outro cofre", self.open_vault):
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
            if isinstance(result, DomainError):
                self._drop_session()
                QMessageBox.warning(self, "OpesVault", str(result))
                return
            self.session = result
            self._after_open(path)

        def failed(code: ErrorCode) -> None:
            self._drop_session()
            self._show_error(code)

        self._run(self._read_vault(path), opened, failed)

    def _after_open(self, path: Path) -> None:
        from datetime import datetime

        from opesvault.vault.backup import create_backup, remove_candidates, stale_candidates

        assert self.session is not None
        self._remember(path)
        leftovers = stale_candidates(path)
        if leftovers and confirm(
            self,
            "Remover arquivos de um salvamento interrompido?",
            f"Há {len(leftovers)} arquivo(s) cifrado(s) de um salvamento interrompido ao lado do cofre. "
            "O cofre aberto é a última versão válida.",
            "Remover arquivos",
        ):
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
        self.show_alerts_on_open()

    def save_vault(self, then: Callable[[], object] | None = None) -> None:
        """Saves through the worker (it asks the password). `then` runs only after a good save."""
        self._flush_pages()
        if self.busy or self.session is None:
            return
        session = self.session
        steps = session.undo_stack().checkpoint()
        frozen: FrozenSnapshot = session.freeze()

        def saved(revision: Any) -> None:
            session.mark_saved(frozen, revision)
            session.undo_stack().saved(steps)
            self._after_save()
            if then is not None:
                QTimer.singleShot(0, then)  # after the shell refreshed its saved state

        self._run(lambda: self.client.save_frozen(frozen), saved)

    def _after_save(self) -> None:
        session = self.session
        if session is None or session.revision is None:
            return
        self._remember(session.path)
        self._auto_backup()

    def close_vault(self) -> None:
        if self.busy or not self._confirm_discard("fechar o cofre", self.close_vault):
            return
        self._drop_session()
        self._refresh()

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

    def _remind(self) -> None:
        """Contextual, non-modal: unsaved work is lost if the computer crashes."""
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
            self.statusBar().showMessage(
                f"Alterações não salvas há {elapsed} min. Use Ctrl+S; sem salvar, um travamento perde o trabalho.",
                30_000,
            )

    # ── files outside the vault ─────────────────────

    def export(self, kind: str) -> None:
        if self.session is None:
            return
        from opesvault.exports import interchange_json, ledger_csv

        if not confirm(
            self,
            "Exportar sem criptografia?",
            "O arquivo exportado fica fora do cofre, sem criptografia, e contém dados financeiros.",
            "Exportar…",
        ):
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

    def export_month_report(self) -> None:
        from opesvault.ui.pages.overview_page import OverviewPage

        overview = next((p for p in self.pages if isinstance(p, OverviewPage)), None)
        if self.session is not None and overview is not None:
            overview.export_report()

    def export_year_report(self) -> None:
        if self.session is None:
            return
        from datetime import date

        from opesvault.exports import annual_report_html
        from opesvault.ui.pdf_export import save_pdf

        year, ok = QInputDialog.getInt(self, "Fechamento do ano", "Ano:", date.today().year - 1, 1990, 2999)
        if ok:
            ledger = self.session.ledger
            save_pdf(self, f"fechamento-{year}.pdf", lambda: annual_report_html(ledger, year))
