"""Phase 0 harness window: exercises create/open/save, documents in RAM and rendering.

Deliberately minimal (docs/09 §1): it exists to validate the vault architecture,
not as the product UI of docs/07.
"""

from collections.abc import Callable
from pathlib import Path
from typing import Any

from PySide6.QtCore import QObject, QRunnable, Qt, QThreadPool, Signal
from PySide6.QtGui import QAction, QCloseEvent, QKeySequence, QPixmap
from PySide6.QtWidgets import (
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QMainWindow,
    QMessageBox,
    QScrollArea,
    QWidget,
)

from opesvault.pdf_render import render_page
from opesvault.session import FrozenSnapshot, Session
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

        self.documents = QListWidget()
        self.documents.currentRowChanged.connect(self._show_document)
        self.preview = QLabel("Nenhum documento selecionado")
        self.preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        scroll = QScrollArea()
        scroll.setWidget(self.preview)
        scroll.setWidgetResizable(True)
        central = QWidget()
        layout = QHBoxLayout(central)
        layout.addWidget(self.documents, 1)
        layout.addWidget(scroll, 3)
        self.setCentralWidget(central)

        menu = self.menuBar().addMenu("&Cofre")
        self._action(menu, "&Novo cofre…", QKeySequence.StandardKey.New, self.new_vault)
        self._action(menu, "&Abrir cofre…", QKeySequence.StandardKey.Open, self.open_vault)
        self._action(menu, "&Salvar", QKeySequence.StandardKey.Save, self.save_vault)
        self._action(menu, "Adicionar &PDFs…", None, self.add_pdfs)
        self._action(menu, "&Fechar cofre", None, self.close_vault)
        self.status = QLabel()
        self.statusBar().addPermanentWidget(self.status)
        self.resize(1100, 750)
        self._refresh()

    def _action(self, menu: Any, text: str, shortcut: Any, slot: Callable[[], None]) -> None:
        action = QAction(text, self)
        if shortcut is not None:
            action.setShortcut(shortcut)
        action.triggered.connect(slot)
        menu.addAction(action)

    # ── state ───────────────────────────────────────────

    def _refresh(self) -> None:
        if self.session is None:
            self.setWindowTitle("OpesVault")
            self.status.setText("Nenhum cofre aberto")
            self.documents.clear()
            self.preview.setText("Nenhum documento selecionado")
            return
        state = "Não salvo" if self.session.dirty else "Salvo"
        rev = self.session.revision.revision if self.session.revision else "—"
        self.setWindowTitle(f"OpesVault — {self.session.path.name}{' *' if self.session.dirty else ''}")
        self.status.setText(f"{state} · revisão {rev}")
        if self.documents.count() != len(self.session.documents):
            self.documents.clear()
            for doc in self.session.documents:
                self.documents.addItem(doc.meta.original_name)

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
        path = Path(name).with_suffix(".opesvault")
        if path.exists():
            self._show_error(ErrorCode.ALREADY_EXISTS)
            return
        self._drop_session()
        if self._take_lock(path):
            self.session = Session.new(path)
            self._refresh()
            self.save_vault()

    def open_vault(self) -> None:
        if self.busy or not self._confirm_discard():
            return
        name, _ = QFileDialog.getOpenFileName(self, "Abrir cofre", "", VAULT_FILTER)
        if not name:
            return
        path = Path(name)
        self._drop_session()
        self._refresh()
        if not self._take_lock(path):
            return

        def opened(result: Any) -> None:
            revision, snapshot = result
            self.session = Session.from_snapshot(path, revision, snapshot)

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

    def add_pdfs(self) -> None:
        if self.busy or self.session is None:
            return
        names, _ = QFileDialog.getOpenFileNames(self, "Adicionar PDFs", "", "PDF (*.pdf)")
        for name in names:
            path = Path(name)
            self.session.add_document(path.name, path.read_bytes())
        self._refresh()

    def close_vault(self) -> None:
        if self.busy or not self._confirm_discard():
            return
        self._drop_session()
        self._refresh()

    def _show_document(self, row: int) -> None:
        if self.session is None or not 0 <= row < len(self.session.documents):
            return
        try:
            image = render_page(self.session.documents[row].data)
        except Exception:
            self.preview.setText("Não foi possível renderizar este PDF.")
            return
        self.preview.setPixmap(QPixmap.fromImage(image))

    def closeEvent(self, event: QCloseEvent) -> None:  # noqa: N802 - Qt override
        if self.busy or not self._confirm_discard():
            event.ignore()
            return
        self._drop_session()
        event.accept()
