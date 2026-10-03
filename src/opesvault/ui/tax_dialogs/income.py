"""Income: the nature of each income category, a payslip's detail and the operations behind a row."""

from decimal import Decimal
from typing import Any
from uuid import UUID

from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QTableWidget,
    QTableWidgetItem,
    QWidget,
)

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountType
from opesvault.tax import records
from opesvault.tax.model import (
    INCOME_KIND_LABELS,
    NATURE_LABELS,
    IncomeKind,
    IncomeNature,
    NatureSubject,
)
from opesvault.ui.common import (
    combo_value,
    fill_combo,
    fit_to_rows,
    fmt,
    fmt_date,
    money_edit,
    read_money,
    select_combo,
    set_rows,
    stretch_column,
    summary_table,
)
from opesvault.ui.components import button
from opesvault.ui.dialogs import FormDialog
from opesvault.ui.tax_dialogs.fields import caption, editable


class NatureDialog(FormDialog):
    """How each income category and each investment goes in the return; the choice is the user's."""

    def __init__(self, parent: QWidget | None, ledger: Ledger, focus: tuple[NatureSubject, UUID] | None = None) -> None:
        from opesvault.investments.service import assets, positions

        super().__init__(parent, "Natureza dos rendimentos", "Salvar")
        self.ledger = ledger
        self.combos: list[tuple[NatureSubject, UUID, QComboBox]] = []
        self.table = QTableWidget(0, 2)
        self.table.setHorizontalHeaderLabels(["Receita ou investimento", "Como declarar"])
        self.table.verticalHeader().setVisible(False)
        self.table.setAccessibleName("Natureza de cada receita")
        stretch_column(self.table, 0)
        entries: list[tuple[str, NatureSubject, UUID]] = [
            (a.name, NatureSubject.CATEGORY, a.id)
            for a in sorted(ledger.categories(AccountType.INCOME), key=lambda a: a.name.casefold())
            if not a.archived
        ]
        entries += [
            (f"Investimento: {assets(ledger)[p.asset_id].name}", NatureSubject.POSITION, p.id)
            for p in positions(ledger).values()
            if not p.closed
        ]
        self.table.setRowCount(len(entries))
        for row, (name, subject, ref) in enumerate(entries):
            self.table.setItem(row, 0, QTableWidgetItem(name))
            combo = QComboBox()
            combo.setAccessibleName(f"Natureza: {name}")
            fill_combo(combo, [(label, nature) for nature, label in NATURE_LABELS.items()], empty="A definir")
            select_combo(combo, records.nature_of(ledger, subject, ref))
            self.table.setCellWidget(row, 1, combo)
            self.combos.append((subject, ref, combo))
            if focus == (subject, ref):
                self.table.setCurrentCell(row, 1)
        self.table.resizeColumnToContents(1)
        self.table.setMinimumHeight(320)
        caption(
            self,
            "Rendimentos de investimento (proventos e ganhos em resgates) seguem a natureza do investimento. "
            "Vendas de ações, ETF e fundos imobiliários ficam em Renda variável. Nada é classificado sozinho.",
        )
        self.form.addRow(self.table)
        self.setMinimumWidth(720)

    def apply(self) -> None:
        for subject, ref, combo in self.combos:
            value = combo_value(combo)
            nature = IncomeNature(value) if value is not None else None
            if records.nature_of(self.ledger, subject, ref) is not nature:
                records.classify(self.ledger, subject, ref, nature)


# ── payslips and receipts ──────────


class IncomeDetailDialog(FormDialog):
    """Gross, IRRF and INSS of a deposit, as printed on the payslip. Empty fields stay unknown."""

    def __init__(self, parent: QWidget | None, ledger: Ledger, operation_id: UUID) -> None:
        super().__init__(parent, "Detalhar rendimento", "Salvar")
        self.ledger, self.operation_id = ledger, operation_id
        op = ledger.operations[operation_id]
        detail = records.detail_of(ledger, operation_id)
        self.kind = QComboBox()
        self.kind.setAccessibleName("Tipo de rendimento")
        fill_combo(self.kind, [(label, kind) for kind, label in INCOME_KIND_LABELS.items()])
        select_combo(self.kind, detail.kind if detail else IncomeKind.SALARY)
        self.gross, self.withheld, self.social = money_edit(), money_edit(), money_edit()
        for edit, value, name in (
            (self.gross, detail.gross if detail else None, "Valor bruto"),
            (self.withheld, detail.withheld if detail else None, "Imposto retido"),
            (self.social, detail.social_security if detail else None, "INSS"),
        ):
            edit.setText(editable(value))
            edit.setAccessibleName(name)
            edit.setPlaceholderText("não informado")
        received = records.received_amount(ledger, operation_id)
        caption(
            self,
            f"{op.description} · {fmt_date(op.cash_date)} · recebido {fmt(received)}. "
            "Copie do contracheque; o depósito no livro não muda.",
        )
        self.form.addRow("Tipo:", self.kind)
        self.form.addRow("Bruto:", self.gross)
        self.form.addRow("IR retido:", self.withheld)
        self.form.addRow("INSS:", self.social)

    def _values(self) -> tuple[Any, Any, Any]:
        return (
            read_money(self.gross, allow_empty=True),
            read_money(self.withheld, allow_empty=True),
            read_money(self.social, allow_empty=True),
        )

    def validate(self) -> None:
        self._values()

    def apply(self) -> None:
        gross, withheld, social = self._values()
        records.set_income_detail(
            self.ledger, self.operation_id, IncomeKind(combo_value(self.kind)), gross, withheld, social
        )


class OperationsDialog(FormDialog):
    """The operations behind a line: detail payslips ("detail") or attach receipts ("receipts")."""

    def __init__(self, parent: QWidget | None, session: Any, operation_ids: tuple[UUID, ...], mode: str) -> None:
        super().__init__(parent, "Contracheques" if mode == "detail" else "Comprovantes", "Fechar", close_only=True)
        self.session, self.ids, self.mode = session, operation_ids, mode
        self.edited = False
        last = "Bruto / IR / INSS" if mode == "detail" else "Comprovante"
        self.table = summary_table(["Data", "Descrição", "Valor", last], max_rows=12)
        self.table.setAccessibleName("Lançamentos")
        stretch_column(self.table, 1)
        self.table.doubleClicked.connect(lambda _: self.act())
        self.form.addRow(self.table)
        self.form.addRow("", button("Detalhar…" if mode == "detail" else "Anexar comprovante…", self.act))
        self.setMinimumWidth(680)
        self.fill()

    def fill(self) -> None:
        from opesvault.domain import attachments

        ledger = self.session.ledger
        rows = []
        for op_id in self.ids:
            op = ledger.operations.get(op_id)
            if op is None:
                continue
            value = sum((abs(p.amount) for p in op.postings if p.amount > 0), Decimal(0))
            if self.mode == "detail":
                detail = records.detail_of(ledger, op_id)
                status = (
                    " / ".join(fmt(v) for v in (detail.gross, detail.withheld, detail.social_security))
                    if detail
                    else "não detalhado"
                )
            else:
                found = attachments.of_operation(ledger, op_id)
                status = f"{len(found)} anexo(s)" if found else "falta"
            rows.append(([fmt_date(op.cash_date), op.description, fmt(value), status], op_id))
        set_rows(self.table, rows)
        fit_to_rows(self.table)

    def act(self) -> None:
        from opesvault.ui.common import run_guarded, selected_id

        op_id = selected_id(self.table)
        if op_id is None:
            return
        if self.mode == "detail":
            dialog = IncomeDetailDialog(self, self.session.ledger, op_id)
            if dialog.exec() and run_guarded(self, lambda: dialog.apply() or True):
                self.edited = True
                self.fill()
            return
        name, _ = QFileDialog.getOpenFileName(self, "Anexar comprovante", "", "Comprovantes (*.pdf *.png *.jpg *.jpeg)")
        if not name:
            return
        from pathlib import Path

        from opesvault.domain.attachments import attach

        try:
            data = Path(name).read_bytes()
        except OSError:
            self.show_error("Não foi possível ler o arquivo.")
            return
        if run_guarded(self, lambda: attach(self.session, op_id, Path(name).name, data)):
            self.edited = True
            self.fill()


# ── Bens e Direitos ──────────
