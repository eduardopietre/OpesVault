"""The local AI on screen: one client, one progress row and one review dialog for every page.

Each page that asks the model (Importar, Livro, Novo lançamento) follows the same contract
(docs/05 §5, docs/16):

- `client_for` reads the vault's choice (Configurações › IA local) and this computer's
  Ollama port; None means the AI is off and the page works as if it did not exist;
- `AiRunRow` asks in the background with progress and Cancelar; the page stays usable, and
  an answer that arrives after the vault closed is dropped;
- what the model proposes for data already in the ledger goes through `AiReviewDialog`,
  where each change is checked, unchecked or edited before anything is written.
"""

import threading
from collections.abc import Callable

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QAbstractItemView,
    QDialogButtonBox,
    QHeaderView,
    QProgressBar,
    QTableWidgetItem,
    QWidget,
)

from opesvault.ai.ollama import AiUnavailable, OllamaClient, local_url
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.ui import preferences
from opesvault.ui.background import BackgroundJob, while_alive
from opesvault.ui.common import make_table
from opesvault.ui.components import button, hbox, hbox_widget, text
from opesvault.ui.dialogs import FormDialog

OFF = "A IA local está desligada ou sem modelo escolhido (Configurações › IA local)."


def client_for(ledger: Ledger | None) -> OllamaClient | None:
    """The model this vault asks, on this computer's Ollama port; None when the AI is off."""
    from opesvault.importing.ai_suggestions import client_from_settings

    if ledger is None:
        return None
    try:
        return client_from_settings(ledger, local_url(preferences.ollama_port()))
    except AiUnavailable:
        return None


def label(source: str | None) -> str:
    """'ollama:gemma4:12b:p4@…' → 'gemma4:12b'."""
    if not source or not source.startswith("ollama:"):
        return ""
    parts = source.split("@", 1)[0].split(":")
    return ":".join(parts[1:-1]) or parts[-1]


class AiRunRow(QWidget):
    """'IA local (modelo): 3 de 40 descrições', a progress bar and Cancelar, while the model works.

    One run at a time. `start` checks the model first (Ollama off or the model missing fail
    at once, saying what to do) and hands `done` the work's result or the AiUnavailable.
    """

    def __init__(self, owner: QWidget) -> None:
        super().__init__(owner)
        self._owner = owner
        self._job: BackgroundJob | None = None
        self._cancel = threading.Event()
        self.label = text("", "caption")
        self.progress = QProgressBar()
        self.progress.setTextVisible(False)
        self.progress.setAccessibleName("Progresso da IA local")
        self.cancel_button = button("Cancelar", self.cancel, role="plain", tip="Para ao fim do lote atual")
        self.setLayout(hbox(self.label, self.progress, self.cancel_button))
        self.hide()

    @property
    def running(self) -> bool:
        return self._job is not None

    def cancel(self) -> None:
        if self._job is not None:
            self._cancel.set()
            self.label.setText("Cancelando ao fim do lote atual…")

    @property
    def cancelled(self) -> bool:
        """Cancelar was pressed during the last run (a conversation checks it between steps)."""
        return self._cancel.is_set()

    def stop(self) -> None:
        """The vault closed: what is still being asked is no longer wanted."""
        self._cancel.set()

    def start(
        self,
        client: OllamaClient,
        work: Callable[[Callable[[int, int], None], threading.Event], object],
        total: int,
        unit: str,
        done: Callable[[object], None],
        *,
        check: bool = True,
    ) -> bool:
        """Runs `work(report, cancel)` in the background after checking the model. False if busy.

        `total` 0 shows a busy bar and `unit` alone ("pensando…"); `check` False skips the model
        check (the next step of a conversation already made it).
        """
        from opesvault.importing.ai_suggestions import remember_used

        if self._job is not None:
            return False
        cancel = self._cancel = threading.Event()
        remember_used(client)

        def run(report: Callable[[int, int], None]) -> object:
            try:
                if check:
                    client.check_model()  # fails fast, saying what to install, before any batch
                return work(report, cancel)
            except AiUnavailable as exc:  # expected: Ollama off, model missing, odd answers
                return exc

        prefix = f"IA local ({client.model})"
        job = BackgroundJob(run)
        self._job = job
        self.progress.setRange(0, total if total > 0 else 0)
        self.progress.setValue(0)
        self.label.setText(f"{prefix}: 0 de {total} {unit}" if total > 0 else f"{prefix}: {unit}")
        self.show()

        def progress(handled: int, of: int) -> None:
            self.progress.setValue(handled)
            if not cancel.is_set():
                self.label.setText(f"{prefix}: {handled} de {of} {unit}")

        def finished(result: object) -> None:
            self._job = None
            self.hide()
            done(result)

        while_alive(job.signals.progress, self._owner, progress)
        while_alive(job.signals.done, self._owner, finished)
        job.start()
        return True


def failure_text(result: object) -> str:
    return str(result) if isinstance(result, AiUnavailable) else "A consulta à IA local falhou."


class AiReviewDialog(FormDialog):
    """What the local AI proposes, one line per change, all checked; nothing is written before Aplicar.

    `editable`: the column (of `headers`) the user may retype, such as a suggested name.
    """

    def __init__(
        self,
        parent: QWidget | None,
        title: str,
        intro: str,
        headers: list[str],
        rows: list[list[str]],
        *,
        editable: int | None = None,
        confirm: str = "Aplicar marcadas",
    ) -> None:
        super().__init__(parent, title, confirm)
        self.setMinimumWidth(760)
        self.editable = editable
        self.form.addRow(text(intro, "secondary", wrap=True))
        self.table = make_table(headers)
        self.table.setSortingEnabled(False)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setAccessibleName("Sugestões da IA local")
        if editable is not None:
            self.table.setEditTriggers(
                QAbstractItemView.EditTrigger.DoubleClicked
                | QAbstractItemView.EditTrigger.EditKeyPressed
                | QAbstractItemView.EditTrigger.AnyKeyPressed
            )
        self.table.setRowCount(len(rows))
        for r, cells in enumerate(rows):
            for c, value in enumerate(cells):
                item = QTableWidgetItem(value)
                flags = Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable
                if c == 0:
                    flags |= Qt.ItemFlag.ItemIsUserCheckable
                    item.setCheckState(Qt.CheckState.Checked)
                if c == editable:
                    flags |= Qt.ItemFlag.ItemIsEditable
                    item.setToolTip("Clique duas vezes para ajustar o nome antes de aplicar")
                item.setFlags(flags)
                self.table.setItem(r, c, item)
        self.table.resizeColumnsToContents()
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.table.setMinimumHeight(280)
        self.form.addRow(self.table)
        self.count = text("", "caption")
        marks = hbox_widget(
            button("Marcar todas", lambda: self._mark(True), role="plain"),
            button("Desmarcar todas", lambda: self._mark(False), role="plain"),
            None,
            self.count,
        )
        self.form.addRow(marks)
        self.table.itemChanged.connect(lambda *_: self._count())
        self._count()

    def _mark(self, checked: bool) -> None:
        state = Qt.CheckState.Checked if checked else Qt.CheckState.Unchecked
        for r in range(self.table.rowCount()):
            item = self.table.item(r, 0)
            if item is not None:
                item.setCheckState(state)

    def _count(self) -> None:
        self.count.setText(f"{len(self.chosen())} de {self.table.rowCount()} marcada(s)")

    def set_checked(self, row: int, checked: bool) -> None:
        item = self.table.item(row, 0)
        if item is not None:
            item.setCheckState(Qt.CheckState.Checked if checked else Qt.CheckState.Unchecked)

    def set_value(self, row: int, value: str) -> None:
        if self.editable is not None:
            item = self.table.item(row, self.editable)
            if item is not None:
                item.setText(value)

    def chosen(self) -> list[tuple[int, str]]:
        """(row, text of the editable column, or '') of each checked line."""
        out: list[tuple[int, str]] = []
        for r in range(self.table.rowCount()):
            mark = self.table.item(r, 0)
            if mark is None or mark.checkState() != Qt.CheckState.Checked:
                continue
            value = self.table.item(r, self.editable) if self.editable is not None else None
            out.append((r, " ".join(value.text().split()) if value is not None else ""))
        return out

    def validate(self) -> None:
        chosen = self.chosen()
        if not chosen:
            raise DomainError("Marque ao menos uma sugestão, ou feche sem aplicar.")
        if self.editable is not None and any(not value for _, value in chosen):
            raise DomainError("Um nome marcado ficou vazio.")


def plural(count: int, one: str, many: str) -> str:
    return f"{count} {one if count == 1 else many}"


class ApprovalDialog(FormDialog):
    """One change the assistant wants to make. Aprovar runs it; Recusar tells the model it was refused."""

    def __init__(self, parent: QWidget | None, summary: str, details: tuple[str, ...], model: str) -> None:
        super().__init__(parent, "Aprovar alteração", "Aprovar")
        self.setMinimumWidth(560)
        self.form.addRow(text(summary, "strong", wrap=True))
        for line in details:
            self.form.addRow(text(line, "secondary", wrap=True))
        self.form.addRow(
            text(
                f"Proposta pelo assistente (IA local, {model}). Nada muda se você recusar; "
                "ao aprovar, a alteração pode ser desfeita com Ctrl+Z.",
                "caption",
                wrap=True,
            )
        )
        self.refuse_button = self.findChildren(QDialogButtonBox)[0].button(QDialogButtonBox.StandardButton.Cancel)
        if self.refuse_button is not None:
            self.refuse_button.setText("Recusar")
