"""The import queue: files chosen or dropped are read one at a time, off the UI thread (RNF-05).

Two imports must never mutate the session at once; the page is busy (no save, no edits)
while a document is read. A protected PDF asks its password, used once and never kept.
"""

from pathlib import Path
from typing import TYPE_CHECKING, Any
from uuid import UUID

from PySide6.QtCore import QMimeData, QObject, QRunnable, QThreadPool, Signal
from PySide6.QtGui import QDragEnterEvent, QDropEvent
from PySide6.QtWidgets import QFileDialog, QInputDialog, QLineEdit, QMessageBox

from opesvault.domain.ledger import DomainError
from opesvault.importing import pipeline
from opesvault.importing.model import ImportBatch
from opesvault.importing.pipeline import ImportRequest
from opesvault.importing.source import PROBLEM_MESSAGES, SourceError, SourceProblem
from opesvault.ui.background import while_alive

if TYPE_CHECKING:
    from opesvault.ui.background import BackgroundJob
    from opesvault.ui.pages.base import Page

    class _Parts(Page):
        batch_id: UUID | None
        _jobs: set["ImportJob"]
        _queue: list[Path]
        _ai_job: BackgroundJob | None
        _ai_waiting: list[UUID]

        def _warm_up_ai(self) -> None: ...
        def _start_ai(self, batch_ids: list[UUID], *, quiet: bool) -> None: ...

else:
    _Parts = object

DOCUMENT_SUFFIXES = {".pdf", ".csv", ".ofx", ".txt"}


class _ImportSignals(QObject):
    done = Signal(object)


class ImportJob(QRunnable):
    """Extraction runs off the UI thread (RNF-05); the page stays disabled meanwhile."""

    def __init__(self, fn: Any) -> None:
        super().__init__()
        self.fn = fn
        self.signals = _ImportSignals()

    def run(self) -> None:
        try:
            result: object = self.fn()
        except (SourceError, DomainError) as exc:  # classified: shown to the user as such
            result = exc
        except Exception as exc:  # reported per file; one failure never affects the others
            from opesvault.diagnostics import record

            record("IMPORT_FAILED", exc)
            result = exc
        self.signals.done.emit(result)


class ImportQueue(_Parts):
    def dragEnterEvent(self, event: QDragEnterEvent) -> None:  # noqa: N802 - Qt override
        if self.session is not None and self._dropped_paths(event.mimeData()):
            event.acceptProposedAction()

    def dropEvent(self, event: QDropEvent) -> None:  # noqa: N802 - Qt override
        paths = self._dropped_paths(event.mimeData())
        if self.session is None or not paths:
            return
        event.acceptProposedAction()
        self.import_paths(paths)

    def import_paths(self, paths: list[Path]) -> None:
        """Files dropped here or anywhere on the window: the same queue as "Importar arquivos…"."""
        self._queue.extend(paths)
        self._next_import()

    @staticmethod
    def _dropped_paths(mime: QMimeData) -> list[Path]:
        return [
            Path(url.toLocalFile())
            for url in mime.urls()
            if url.isLocalFile() and Path(url.toLocalFile()).suffix.lower() in DOCUMENT_SUFFIXES
        ]

    def import_files(self) -> None:
        if self.session is None:
            return
        names, _ = QFileDialog.getOpenFileNames(self, "Importar documentos", "", "Documentos (*.pdf *.csv *.ofx *.txt)")
        # One at a time: two imports must never mutate the same session concurrently.
        self._queue.extend(Path(name) for name in names)
        self._next_import()

    def _next_import(self) -> None:
        if self._jobs or self._ai_job is not None or self.session is None:
            return
        if self._queue:
            self._import_one(self._queue.pop(0), None)
        elif self._ai_waiting:
            waiting, self._ai_waiting = self._ai_waiting, []
            self._start_ai(waiting, quiet=True)

    def _import_one(self, path: Path, password: str | None) -> None:
        assert self.session is not None
        session = self.session
        try:
            data = path.read_bytes()
        except OSError:  # moved, deleted or locked since it was chosen
            self.notify(f"{path.name}: não foi possível ler o arquivo.")
            self._next_import()
            return
        request = ImportRequest(name=path.name, data=data, password=password)
        job = ImportJob(lambda: pipeline.import_document(session, request))
        self._jobs.add(job)
        self.setEnabled(False)
        self.set_busy(True)
        self._warm_up_ai()  # the model loads while the document is read

        def done(result: object) -> None:
            self._jobs.discard(job)
            self.setEnabled(True)
            self.set_busy(False)
            if isinstance(result, SourceError) and result.problem in (
                SourceProblem.PASSWORD_REQUIRED,
                SourceProblem.WRONG_PASSWORD,
            ):
                label = PROBLEM_MESSAGES[result.problem] + f"\n{path.name}\nSenha do PDF (não será guardada):"
                pdf_password, ok = QInputDialog.getText(self, "PDF protegido", label, QLineEdit.EchoMode.Password)
                if ok and pdf_password:
                    self._import_one(path, pdf_password)
                else:
                    self._next_import()
                return
            if isinstance(result, DomainError):
                QMessageBox.information(self, "Importação", f"{path.name}: {result}")
            elif isinstance(result, Exception):
                QMessageBox.warning(self, "Importação", f"{path.name}: falha ao processar o arquivo.")
            elif isinstance(result, ImportBatch):
                self.batch_id = result.id
                self._ai_waiting.append(result.id)
            self.changed()
            self._next_import()

        while_alive(job.signals.done, self, done)
        QThreadPool.globalInstance().start(job)
