"""Informes de rendimentos: read a PDF off the UI thread, review it, keep it and compare it."""

import hashlib
from typing import TYPE_CHECKING, Any
from uuid import UUID

from PySide6.QtWidgets import QFileDialog, QInputDialog, QLineEdit

from opesvault.tax import records, statements
from opesvault.tax.model import ReportSource
from opesvault.ui.common import run_guarded, selected_id
from opesvault.ui.components import confirm

if TYPE_CHECKING:
    from PySide6.QtWidgets import QPushButton, QTableWidget

    from opesvault.ui.pages.base import Page

    class _Parts(Page):
        reports: QTableWidget
        import_button: QPushButton
        _job: Any

        def _year(self) -> int: ...
        def _declarant(self) -> UUID | None: ...
        def _run(self, dialog: Any, message: str) -> bool: ...

else:
    _Parts = object


class ReportCommands(_Parts):
    def import_report(self, source: object = None) -> None:
        if self.session is None or self._job is not None:
            return
        name, _ = QFileDialog.getOpenFileName(self, "Importar informe", "", "Informes (*.pdf *.csv *.txt)")
        if not name:
            return
        from pathlib import Path

        try:
            data = Path(name).read_bytes()
        except OSError:
            self.notify("Não foi possível ler o arquivo.")
            return
        self._read_report(Path(name).name, data, source if isinstance(source, tuple) else None, None)

    def _read_report(
        self, name: str, data: bytes, source: tuple[ReportSource, UUID] | None, password: str | None
    ) -> None:
        from opesvault.ui.background import BackgroundJob

        self.import_button.setEnabled(False)
        job = BackgroundJob(lambda _report: statements.read(data, password))  # PDF text off the UI thread
        job.signals.done.connect(lambda result: self._report_read(name, data, source, result))
        self._job = job
        job.start()

    def _report_read(self, name: str, data: bytes, source: tuple[ReportSource, UUID] | None, result: object) -> None:
        from opesvault.importing.source import SourceError, SourceProblem
        from opesvault.ui.tax_dialogs import ReportDialog

        self._job = None
        self.import_button.setEnabled(True)
        if self.session is None:
            return
        if isinstance(result, SourceError) and result.problem in (
            SourceProblem.PASSWORD_REQUIRED,
            SourceProblem.WRONG_PASSWORD,
        ):
            password, ok = QInputDialog.getText(
                self, "Informe protegido", "Senha do PDF (não será guardada):", QLineEdit.EchoMode.Password
            )
            if ok and password:
                self._read_report(name, data, source, password)
            return
        if not isinstance(result, statements.ParsedReport):
            self.notify("Não foi possível ler este arquivo. Use Mais › Novo informe sem arquivo.")
            return
        dialog = ReportDialog(
            self,
            self.session.ledger,
            year=result.year or self._year(),
            lines=result.lines,
            payer_tax_id=result.payer_tax_id,
            payer_name=result.payer_name,
            source=source,
            skipped=result.skipped,
        )
        if not dialog.exec():
            return
        session = self.session

        def save() -> object:
            document = session.find_document_by_hash(hashlib.sha256(data).hexdigest()) or session.add_document(
                name, data
            )
            dialog.document_id = document.meta.id
            return dialog.apply()

        if run_guarded(self, save):
            self.notify("Informe salvo e comparado com o registrado.")
            self.changed()

    def new_report(self) -> None:
        from opesvault.ui.tax_dialogs import ReportDialog

        if self.session is not None:
            self._run(ReportDialog(self, self.session.ledger, year=self._year(), lines=[]), "Informe salvo.")

    def open_report(self) -> None:
        report_id = selected_id(self.reports)
        if report_id is not None:
            self._open_report_id(report_id)

    def _open_report_id(self, report_id: object) -> None:
        from opesvault.ui.tax_dialogs import ReportDialog

        if self.session is None:
            return
        report = records.reports(self.session.ledger).get(report_id)  # type: ignore[arg-type]
        if report is None:
            return
        dialog = ReportDialog(
            self,
            self.session.ledger,
            year=report.year,
            lines=list(report.lines),
            payer_tax_id=report.payer_tax_id,
            payer_name=report.payer_name,
            source=(report.source, report.source_id),
            report_id=report.id,
        )
        dialog.document_id = report.document_id
        self._run(dialog, "Informe corrigido.")

    def remove_report(self) -> None:
        report_id = selected_id(self.reports)
        if report_id is None or self.session is None:
            return
        if confirm(self, "Remover este informe?", "O arquivo original continua em Documentos.", "Remover"):
            records.remove_report(self.session.ledger, report_id)
            self.changed()

    def export_pdf(self) -> None:
        from opesvault.exports import tax_report_html
        from opesvault.ui.pdf_export import save_pdf

        if self.session is None:
            return
        ledger, year, declarant = self.session.ledger, self._year(), self._declarant()
        if save_pdf(self, f"declaracao-{year}.pdf", lambda: tax_report_html(ledger, year, declarant)):
            self.notify(f"Relatório de {year} gerado.")
