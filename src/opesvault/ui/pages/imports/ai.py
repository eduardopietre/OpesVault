"""Optional local AI (Ollama): category suggestions for items still without one (docs/05 §5).

The model is asked in the background with descriptions only; the answer fills only items still
without a category when it arrives, so a choice made meanwhile always wins. Nothing is approved.
"""

import threading
from collections.abc import Callable
from typing import TYPE_CHECKING
from uuid import UUID

from PySide6.QtWidgets import QMessageBox

from opesvault.importing import pipeline
from opesvault.importing.model import ImportBatch
from opesvault.ui.background import BackgroundJob, while_alive

if TYPE_CHECKING:
    from PySide6.QtWidgets import QLabel, QProgressBar, QPushButton, QWidget

    from opesvault.ai.ollama import OllamaClient
    from opesvault.ui.pages.base import Page
    from opesvault.ui.pages.imports.queue import ImportJob

    class _Parts(Page):
        ai_button: QPushButton
        ai_label: QLabel
        ai_progress: QProgressBar
        ai_row: QWidget
        _jobs: set[ImportJob]
        _ai_job: BackgroundJob | None
        _ai_cancel: threading.Event

        def _batch(self) -> ImportBatch | None: ...
        def _next_import(self) -> None: ...

else:
    _Parts = object


class AiAssist(_Parts):
    def _ai_client(self) -> "OllamaClient | None":
        from opesvault.ai.ollama import AiUnavailable
        from opesvault.importing.ai_suggestions import client_from_settings

        if self.session is None:
            return None
        try:
            return client_from_settings(self.session.ledger)
        except AiUnavailable:
            return None

    def _update_ai_button(self, batch: ImportBatch | None) -> None:
        from opesvault.importing.ai_suggestions import pending_count

        client = self._ai_client()
        self.ai_button.setVisible(client is not None)
        if client is None or batch is None or self.session is None:
            return
        count = pending_count(self.session.ledger, batch.id)
        running = self._ai_job is not None
        self.ai_button.setEnabled(bool(count) and not running and not self._jobs)
        self.ai_button.setText(f"Sugerir com IA ({count})" if count else "Sugerir com IA")
        self.ai_button.setToolTip(
            f"{client.model} no Ollama local: sugere categorias para os itens sem categoria; nada é aprovado sozinho"
            if count
            else "Todos os itens deste documento já têm categoria"
        )

    def _warm_up_ai(self) -> None:
        client = self._ai_client()
        if client is not None:
            threading.Thread(target=client.warm_up, name="ollama-warm-up", daemon=True).start()

    def suggest_ai(self) -> None:
        """The button: asks about the open document and says plainly when the AI cannot help."""
        batch = self._batch()
        if batch is None or self.session is None or self._jobs or self._ai_job is not None:
            return
        if self._ai_client() is None:
            self.notify("A assistência por IA está desligada ou sem modelo escolhido (Configurações).")
            return
        self._start_ai([batch.id], quiet=False)

    def cancel_ai(self) -> None:
        if self._ai_job is not None:
            self._ai_cancel.set()
            self.ai_label.setText("Cancelando ao fim do lote atual…")

    def _start_ai(self, batch_ids: list[UUID], *, quiet: bool) -> None:
        """Asks the model in the background. The page stays usable: only items still without a
        category when the answer arrives are filled, so a choice made meanwhile always wins.

        `quiet` (after an import): problems go to the status bar instead of a dialog.
        """
        from opesvault.ai.ollama import AiUnavailable
        from opesvault.importing.ai_suggestions import AiOutcome, apply_suggestions, ask, plan_requests, remember_used

        client = self._ai_client()
        session = self.session
        if client is None or session is None:
            return
        ledger = session.ledger
        known = pipeline.batches(ledger)
        requests = [r for b in batch_ids if b in known for r in plan_requests(ledger, b)]
        if not requests:
            if not quiet:
                self.notify("IA local: nenhum item sem categoria neste documento.")
            return
        cancel = self._ai_cancel = threading.Event()
        remember_used(client)

        def work(report: Callable[[int, int], None]) -> object:
            try:
                client.check_model()  # fails fast, saying what to install, before any batch
                return ask(client, requests, on_progress=report, cancel=cancel)
            except AiUnavailable as exc:  # expected: Ollama off, model missing, odd answers
                return exc

        total = sum(len(r.descriptions) for r in requests)
        job = BackgroundJob(work)
        self._ai_job = job
        self.ai_progress.setRange(0, total)
        self.ai_progress.setValue(0)
        self.ai_label.setText(f"IA local ({client.model}): 0 de {total} descrição(ões)")
        self.ai_row.show()
        self._update_ai_button(self._batch())

        def progress(done: int, of: int) -> None:
            self.ai_progress.setValue(done)
            if not cancel.is_set():
                self.ai_label.setText(f"IA local ({client.model}): {done} de {of} descrição(ões)")

        def done(result: object) -> None:
            self._ai_job = None
            self.ai_row.hide()
            if self.session is not session:  # the vault was closed meanwhile
                return
            if isinstance(result, AiOutcome):
                count = apply_suggestions(ledger, result.planned)
                message = f"IA local: {count} categoria(s) sugerida(s)"
                if result.cancelled:
                    message += ", consulta cancelada"
                elif result.failed:
                    message += f"; {result.failed} item(ns) sem resposta válida"
                self.notify(message + (". Revise antes de aprovar." if count else "."))
                if count:
                    self.changed()  # one undo step for the whole answer
                else:
                    self.refresh()
            else:
                reason = str(result) if isinstance(result, AiUnavailable) else "A consulta falhou."
                if quiet:
                    self.notify(f"IA local: {reason}")
                else:
                    QMessageBox.information(self, "IA local", f"{reason} A revisão manual continua disponível.")
                self.refresh()
            self._update_ai_button(self._batch())
            self._next_import()

        while_alive(job.signals.progress, self, progress)
        while_alive(job.signals.done, self, done)
        job.start()
