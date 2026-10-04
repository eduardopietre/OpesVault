"""Optional local AI (Ollama): category suggestions for items still without one (docs/05 §5).

The model is asked in the background with descriptions only; the answer fills only items still
without a category when it arrives, so a choice made meanwhile always wins. Nothing is approved.
Progress, cancellation and the client are shared with the other pages (`ui/local_ai.py`).
"""

import threading
from collections.abc import Callable
from typing import TYPE_CHECKING
from uuid import UUID

from PySide6.QtWidgets import QMessageBox

from opesvault.importing import pipeline
from opesvault.importing.model import ImportBatch
from opesvault.ui.local_ai import OFF, client_for, failure_text

if TYPE_CHECKING:
    from PySide6.QtWidgets import QPushButton

    from opesvault.ai.ollama import OllamaClient
    from opesvault.ui.local_ai import AiRunRow
    from opesvault.ui.pages.base import Page
    from opesvault.ui.pages.imports.queue import ImportJob

    class _Parts(Page):
        ai_button: QPushButton
        ai_row: AiRunRow
        _jobs: set[ImportJob]

        def _batch(self) -> ImportBatch | None: ...
        def _next_import(self) -> None: ...

else:
    _Parts = object


class AiAssist(_Parts):
    def _ai_client(self) -> "OllamaClient | None":
        return client_for(self.session.ledger if self.session is not None else None)

    def _update_ai_button(self, batch: ImportBatch | None) -> None:
        from opesvault.importing.ai_suggestions import pending_count

        client = self._ai_client()
        self.ai_button.setVisible(client is not None)
        if client is None or batch is None or self.session is None:
            return
        count = pending_count(self.session.ledger, batch.id)
        self.ai_button.setEnabled(bool(count) and not self.ai_row.running and not self._jobs)
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
        if batch is None or self.session is None or self._jobs or self.ai_row.running:
            return
        if self._ai_client() is None:
            self.notify(OFF)
            return
        self._start_ai([batch.id], quiet=False)

    def cancel_ai(self) -> None:
        self.ai_row.cancel()

    def _start_ai(self, batch_ids: list[UUID], *, quiet: bool) -> None:
        """Asks the model in the background. The page stays usable: only items still without a
        category when the answer arrives are filled, so a choice made meanwhile always wins.

        `quiet` (after an import): problems go to the status bar instead of a dialog.
        """
        from opesvault.importing.ai_suggestions import AiOutcome, apply_suggestions, ask, plan_requests

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

        def work(report: Callable[[int, int], None], cancel: threading.Event) -> object:
            return ask(client, requests, on_progress=report, cancel=cancel)

        def done(result: object) -> None:
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
                reason = failure_text(result)
                if quiet:
                    self.notify(f"IA local: {reason}")
                else:
                    QMessageBox.information(self, "IA local", f"{reason} A revisão manual continua disponível.")
                self.refresh()
            self._update_ai_button(self._batch())
            self._next_import()

        total = sum(len(r.descriptions) for r in requests)
        self.ai_row.start(client, work, total, "descrição(ões)", done)
        self._update_ai_button(self._batch())
