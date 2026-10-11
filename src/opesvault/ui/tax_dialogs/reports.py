"""Informes de rendimentos: reviewing one line by line and where it came from."""

from typing import Any
from uuid import UUID

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox,
    QLineEdit,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QWidget,
)

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountType
from opesvault.domain.money import MoneyError, parse_brl
from opesvault.tax import ids, records
from opesvault.tax.model import (
    FIELD_LABELS,
    ReportField,
    ReportLine,
    ReportSource,
    TaxSubject,
)
from opesvault.ui.common import (
    combo_value,
    fill_combo,
    select_combo,
    stretch_column,
)
from opesvault.ui.components import button
from opesvault.ui.dialogs import FormDialog
from opesvault.ui.tax_dialogs.fields import caption, editable


class ReportDialog(FormDialog):
    """An informe to review before saving: who issued it, the year and each line read (editable)."""

    def __init__(
        self,
        parent: QWidget | None,
        ledger: Ledger,
        *,
        year: int,
        lines: list[ReportLine],
        payer_tax_id: str | None = None,
        payer_name: str | None = None,
        source: tuple[ReportSource, UUID] | None = None,
        report_id: UUID | None = None,
        skipped: list[str] | None = None,
    ) -> None:
        super().__init__(parent, "Informe de rendimentos", "Salvar informe")
        self.ledger, self.report_id = ledger, report_id
        self.document_id: UUID | None = None
        self.source = QComboBox()
        self.source.setAccessibleName("De quem é o informe")
        options = [
            (f"Conta: {a.name}", (ReportSource.ACCOUNT, a.id))
            for a in sorted(ledger.accounts.values(), key=lambda a: a.name.casefold())
            if a.type in (AccountType.ASSET, AccountType.LIABILITY) and not a.archived
        ]
        options += [
            (f"Fonte pagadora: {a.name}", (ReportSource.CATEGORY, a.id))
            for a in sorted(ledger.categories(AccountType.INCOME), key=lambda a: a.name.casefold())
            if not a.archived
        ]
        fill_combo(self.source, options, empty="Escolha…")
        select_combo(self.source, source or _guess_source(ledger, payer_tax_id))
        self.year = QSpinBox()
        self.year.setRange(1990, 2999)
        self.year.setValue(year)
        self.year.setAccessibleName("Ano-calendário")
        self.payer = QLineEdit(ids.display(payer_tax_id) if payer_tax_id else "")
        self.payer.setPlaceholderText("CNPJ de quem emitiu")
        self.payer.setAccessibleName("CNPJ")
        self.payer_name = payer_name
        self.table = QTableWidget(0, 3)
        self.table.setHorizontalHeaderLabels(["Campo", "Linha do informe", "Valor"])
        self.table.verticalHeader().setVisible(False)
        self.table.setAccessibleName("Linhas do informe")
        stretch_column(self.table, 1)
        self.table.setMinimumHeight(240)
        for line in lines:
            self._add_row(line)
        add = button("Adicionar linha", lambda: self._add_row(None), role="plain")
        remove = button("Remover linha", self._remove_row, role="plain")
        self.form.addRow("Fonte:", self.source)
        self.form.addRow("Ano:", self.year)
        self.form.addRow("CNPJ:", self.payer)
        self.form.addRow(self.table)
        from opesvault.ui.components import hbox_widget

        self.form.addRow("", hbox_widget(add, remove, None))
        if skipped:
            shown = "; ".join(skipped[:6]) + ("…" if len(skipped) > 6 else "")
            caption(self, f"Linhas com valor que não foram reconhecidas: {shown}")
        caption(
            self,
            "Confira cada linha com o documento: a leitura é genérica e ainda não foi validada com "
            "informes reais. O original fica guardado e cifrado no cofre.",
        )
        self.setMinimumWidth(760)

    def _add_row(self, line: ReportLine | None) -> None:
        row = self.table.rowCount()
        self.table.insertRow(row)
        combo = QComboBox()
        combo.setAccessibleName("Campo")
        fill_combo(combo, [(label, kind) for kind, label in FIELD_LABELS.items()])
        select_combo(combo, line.field if line else ReportField.TAXABLE)
        self.table.setCellWidget(row, 0, combo)
        self.table.setItem(row, 1, QTableWidgetItem(line.label if line else ""))
        value = QTableWidgetItem(editable(line.amount) if line else "")
        value.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self.table.setItem(row, 2, value)
        self.table.resizeColumnToContents(0)

    def _remove_row(self) -> None:
        row = self.table.currentRow()
        if row >= 0:
            self.table.removeRow(row)

    def lines(self) -> list[ReportLine]:
        out = []
        for row in range(self.table.rowCount()):
            combo = self.table.cellWidget(row, 0)
            label = self.table.item(row, 1)
            value = self.table.item(row, 2)
            raw = value.text().strip() if value else ""
            if not raw:
                continue
            try:
                amount = parse_brl(raw)
            except MoneyError:
                raise DomainError(f"Valor inválido na linha {row + 1}. Use o formato 1.234,56.") from None
            assert isinstance(combo, QComboBox)
            out.append(
                ReportLine(
                    field=ReportField(combo_value(combo)),
                    amount=abs(amount),
                    label=(label.text() if label else "")[:200],
                )
            )
        return out

    def validate(self) -> None:
        if combo_value(self.source) is None:
            raise DomainError("Escolha de quem é o informe.")
        if self.payer.text().strip():
            ids.normalize(self.payer.text())
        self.lines()

    def apply(self) -> Any:
        source, source_id = combo_value(self.source)
        report = records.save_report(
            self.ledger,
            self.year.value(),
            source,
            source_id,
            self.lines(),
            payer_tax_id=self.payer.text().strip() or None,
            payer_name=self.payer_name,
            document_id=self.document_id,
            report_id=self.report_id,
        )
        subject = TaxSubject.ACCOUNT if source is ReportSource.ACCOUNT else TaxSubject.CATEGORY
        if report.payer_tax_id and records.identity(self.ledger, subject, source_id) is None:
            records.set_identity(self.ledger, subject, source_id, report.payer_tax_id, report.payer_name)
        return report


def _guess_source(ledger: Ledger, tax_id: str | None) -> tuple[ReportSource, UUID] | None:
    """The account or payer already known by this CNPJ."""
    if not tax_id:
        return None
    for found in records.identities(ledger).values():
        if found.tax_id != tax_id:
            continue
        if found.subject is TaxSubject.ACCOUNT:
            return (ReportSource.ACCOUNT, UUID(found.ref))
        if found.subject is TaxSubject.CATEGORY:
            return (ReportSource.CATEGORY, UUID(found.ref))
    return None


# ── parameters typed by the user ──────────
