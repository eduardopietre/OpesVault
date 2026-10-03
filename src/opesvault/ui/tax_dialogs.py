"""Dialogs of the Imposto de renda page: tax ids, people, natures, payslips, assets, informes,
the year's table, variable income rules and DARF payments."""

from datetime import date
from decimal import Decimal
from typing import Any, ClassVar
from uuid import UUID

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QLineEdit,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QWidget,
)

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountType, YearMonth
from opesvault.domain.money import MoneyError, format_brl, format_decimal_br, parse_brl
from opesvault.tax import ids, records
from opesvault.tax.model import (
    BUCKET_LABELS,
    FIELD_LABELS,
    INCOME_KIND_LABELS,
    NATURE_LABELS,
    Bracket,
    Bucket,
    BucketRule,
    DeclaredAsset,
    FilingSubject,
    IncomeKind,
    IncomeNature,
    NatureSubject,
    PaymentPurpose,
    ReportField,
    ReportLine,
    ReportSource,
    TaxParameters,
    TaxSubject,
)
from opesvault.ui.catalog_widgets import asset_code_combo
from opesvault.ui.common import (
    combo_value,
    date_edit,
    fill_combo,
    fit_to_rows,
    fmt,
    fmt_date,
    from_qdate,
    money_edit,
    read_money,
    select_combo,
    set_rows,
    stretch_column,
    summary_table,
)
from opesvault.ui.components import button, text
from opesvault.ui.dialogs import FormDialog, liquid_accounts


def _editable(value: Decimal | None) -> str:
    return "" if value is None else format_brl(value).replace("R$", "").strip()


def _percent_text(rate: Decimal | None) -> str:
    return "" if rate is None else format_decimal_br(rate * 100)


def read_percent(edit: QLineEdit, label: str) -> Decimal | None:
    """'15' or '27,5' (percent) to 0.15 or 0.275; empty stays unknown."""
    raw = edit.text().strip().replace("%", "")
    if not raw:
        return None
    try:
        value = parse_brl(raw)
    except MoneyError:
        raise DomainError(f"{label}: use um percentual como 15 ou 27,5.") from None
    if not Decimal(0) <= value <= 100:
        raise DomainError(f"{label}: informe entre 0 e 100.")
    return value / 100


def _cell(table: QTableWidget, row: int, column: int) -> str:
    item = table.item(row, column)
    return item.text().strip() if item is not None else ""


def _caption(form: FormDialog, message: str) -> None:
    form.form.addRow("", text(message, "caption", wrap=True))


# ── CPF / CNPJ ──────────


class TaxIdDialog(FormDialog):
    """CPF or CNPJ of a payee, an institution or a payer, with the name used in the return."""

    TITLES: ClassVar[dict[TaxSubject, str]] = {
        TaxSubject.MERCHANT: "Quem recebeu o pagamento",
        TaxSubject.ACCOUNT: "Instituição da conta",
        TaxSubject.CATEGORY: "Fonte pagadora",
    }

    def __init__(self, parent: QWidget | None, ledger: Ledger, subject: TaxSubject, ref: object, label: str) -> None:
        super().__init__(parent, "CPF ou CNPJ", "Salvar")
        self.ledger, self.subject, self.ref = ledger, subject, ref
        current = records.identity(ledger, subject, ref)
        self.number = QLineEdit(ids.display(current.tax_id) if current else "")
        self.number.setPlaceholderText("000.000.000-00 ou 00.000.000/0000-00")
        self.number.setAccessibleName("CPF ou CNPJ")
        self.name = QLineEdit(current.name or "" if current else label)
        self.name.setAccessibleName("Nome na declaração")
        self.name.setMaxLength(150)
        _caption(
            self,
            f"{self.TITLES[subject]}: {label}. O número fica só dentro do cofre; "
            "os dígitos verificadores são conferidos.",
        )
        self.form.addRow("CPF ou CNPJ:", self.number)
        self.form.addRow("Nome:", self.name)

    def validate(self) -> None:
        ids.normalize(self.number.text())

    def apply(self) -> None:
        records.set_identity(self.ledger, self.subject, self.ref, self.number.text(), self.name.text())


# ── people ──────────


class MemberTaxDialog(FormDialog):
    """CPF, birth date and who declares the member (a dependent goes in someone's return)."""

    def __init__(self, parent: QWidget | None, ledger: Ledger, member_id: UUID) -> None:
        from opesvault.ui.operation_edit import OptionalDate

        member = ledger.members[member_id]
        super().__init__(parent, f"Dados fiscais — {member.name}", "Salvar")
        self.ledger, self.member_id = ledger, member_id
        info = records.member_info(ledger, member_id)
        self.cpf = QLineEdit(ids.display(info.cpf) if info and info.cpf else "")
        self.cpf.setPlaceholderText("000.000.000-00")
        self.cpf.setAccessibleName("CPF")
        self.birth = OptionalDate(info.birth_date if info else None)
        self.birth.setAccessibleName("Data de nascimento")
        self.declared_by = QComboBox()
        self.declared_by.setAccessibleName("Quem declara")
        fill_combo(
            self.declared_by,
            [(f"Dependente de {m.name}", m.id) for m in ledger.members.values() if m.id != member_id and m.active],
            empty="Faz a própria declaração",
        )
        select_combo(self.declared_by, info.declared_by if info else None)
        self.relation = QLineEdit(info.relation or "" if info else "")
        self.relation.setPlaceholderText("ex.: Filho(a), Cônjuge")
        self.relation.setAccessibleName("Relação de dependência")
        _caption(
            self,
            "Cada declaração é de um CPF. Dependentes entram na declaração de quem os declara, com as "
            "próprias receitas e despesas. O CPF fica só dentro do cofre.",
        )
        self.form.addRow("CPF:", self.cpf)
        self.form.addRow("Nascimento:", self.birth)
        self.form.addRow("Declaração:", self.declared_by)
        self.form.addRow("Relação:", self.relation)

    def validate(self) -> None:
        if self.cpf.text().strip():
            ids.normalize(self.cpf.text(), (ids.TaxIdKind.CPF,))

    def apply(self) -> None:
        records.set_member_info(
            self.ledger,
            self.member_id,
            cpf=self.cpf.text(),
            birth_date=self.birth.value(),
            declared_by=combo_value(self.declared_by),
            relation=self.relation.text(),
        )


class PeopleDialog(FormDialog):
    """Who files a return and who is a dependent: one line per member, edited one at a time."""

    def __init__(self, parent: QWidget | None, ledger: Ledger) -> None:
        super().__init__(parent, "Declarantes e dependentes", "Fechar", close_only=True)
        self.ledger = ledger
        self.edited = False
        self.table = summary_table(["Integrante", "CPF", "Nascimento", "Declaração"], max_rows=12)
        self.table.setAccessibleName("Integrantes")
        stretch_column(self.table, 3)
        self.table.doubleClicked.connect(lambda _: self.edit())
        self.form.addRow(self.table)
        self.form.addRow("", button("Editar…", self.edit))
        self.setMinimumWidth(640)
        self.fill()

    def fill(self) -> None:
        rows = []
        for member in sorted(self.ledger.members.values(), key=lambda m: m.name.casefold()):
            info = records.member_info(self.ledger, member.id)
            boss = self.ledger.members.get(info.declared_by) if info and info.declared_by else None
            rows.append(
                (
                    [
                        member.name,
                        ids.display(info.cpf) if info and info.cpf else "—",
                        fmt_date(info.birth_date) if info else "—",
                        f"Dependente de {boss.name}" if boss else "Própria",
                    ],
                    member.id,
                )
            )
        set_rows(self.table, rows)
        fit_to_rows(self.table)

    def edit(self) -> None:
        from opesvault.ui.common import run_guarded, selected_id

        member_id = selected_id(self.table)
        if member_id is None:
            return
        dialog = MemberTaxDialog(self, self.ledger, member_id)
        if dialog.exec() and run_guarded(self, lambda: dialog.apply() or True):
            self.edited = True
            self.fill()


# ── natures ──────────


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
        _caption(
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
            edit.setText(_editable(value))
            edit.setAccessibleName(name)
            edit.setPlaceholderText("não informado")
        received = records.received_amount(ledger, operation_id)
        _caption(
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


class FilingDialog(FormDialog):
    """Group, code and description of an account or investment in Bens e Direitos."""

    def __init__(
        self,
        parent: QWidget | None,
        ledger: Ledger,
        subject: FilingSubject,
        ref: UUID,
        name: str,
        suggested: str | None,
    ) -> None:
        super().__init__(parent, "Bens e Direitos", "Salvar")
        self.ledger, self.subject, self.ref = ledger, subject, ref
        current = records.filing_of(ledger, subject, ref)
        start = (current.group, current.code) if current else None
        self.kind = asset_code_combo(start)
        self.description = QLineEdit(current.description if current and current.description else name)
        self.description.setMaxLength(512)
        self.description.setAccessibleName("Discriminação")
        _caption(
            self,
            f"{name}. Grupo e código da tabela de Bens e Direitos do programa IRPF (digite para procurar)"
            + (f"; sugestão: grupo {suggested}. " if suggested and current is None else ". ")
            + "O valor declarado é o custo, calculado pelo aplicativo.",
        )
        self.form.addRow("Tipo:", self.kind)
        self.form.addRow("Discriminação:", self.description)

    def validate(self) -> None:
        if combo_value(self.kind) is None:
            raise DomainError("Escolha o grupo e o código na tabela do IRPF.")

    def apply(self) -> None:
        group, code = combo_value(self.kind)
        records.set_filing(self.ledger, self.subject, self.ref, group, code, self.description.text())


class DeclaredAssetDialog(FormDialog):
    """A good that is not an account (house, car), at acquisition cost."""

    def __init__(self, parent: QWidget | None, ledger: Ledger, asset: DeclaredAsset | None = None) -> None:
        from opesvault.ui.operation_edit import OptionalDate

        super().__init__(parent, "Bem" if asset else "Novo bem", "Salvar")
        self.ledger, self.asset = ledger, asset
        self.name = QLineEdit(asset.name if asset else "")
        self.name.setAccessibleName("Nome do bem")
        self.kind = asset_code_combo((asset.group, asset.code) if asset else None, ("01", "02", "03", "05", "99"))
        self.description = QLineEdit(asset.description if asset else "")
        self.description.setPlaceholderText("endereço, matrícula, placa, de quem foi comprado…")
        self.description.setAccessibleName("Discriminação")
        self.owner = QComboBox()
        self.owner.setAccessibleName("Dono")
        fill_combo(self.owner, [(m.name, m.id) for m in ledger.members.values() if m.active], empty="(projeto)")
        select_combo(self.owner, asset.owner_id if asset else None)
        self.acquired = date_edit(asset.acquired_on if asset else None)
        self.acquired.setAccessibleName("Data de aquisição")
        self.cost = money_edit()
        self.cost.setText(_editable(asset.cost) if asset else "")
        self.cost.setAccessibleName("Custo de aquisição")
        self.sold = OptionalDate(asset.sold_on if asset else None)
        self.sold.setAccessibleName("Data de venda")
        self.sale = money_edit()
        self.sale.setText(_editable(asset.sale_value) if asset else "")
        self.sale.setAccessibleName("Valor de venda")
        self.sale.setPlaceholderText("não vendido")
        for label, widget in (
            ("Nome:", self.name),
            ("Tipo:", self.kind),
            ("Discriminação:", self.description),
            ("Dono:", self.owner),
            ("Aquisição:", self.acquired),
            ("Custo:", self.cost),
            ("Venda:", self.sold),
            ("Valor da venda:", self.sale),
        ):
            self.form.addRow(label, widget)
        _caption(
            self, "Imóveis e veículos vão pelo custo de aquisição (com reformas somadas), não pelo valor de mercado."
        )

    def build(self) -> DeclaredAsset:
        cost = read_money(self.cost)
        assert cost is not None
        kind = combo_value(self.kind)
        if kind is None:
            raise DomainError("Escolha o grupo e o código na tabela do IRPF.")
        fields = {
            "name": self.name.text().strip(),
            "group": kind[0],
            "code": kind[1],
            "description": " ".join(self.description.text().split()),
            "owner_id": combo_value(self.owner),
            "acquired_on": from_qdate(self.acquired.date()),
            "cost": cost,
            "sold_on": self.sold.value(),
            "sale_value": read_money(self.sale, allow_empty=True),
        }
        if not fields["name"]:
            raise DomainError("Informe o nome do bem.")
        if self.asset is None:
            return DeclaredAsset(**fields)
        return self.asset.model_copy(update=fields)

    def validate(self) -> None:
        self.build()

    def apply(self) -> None:
        records.save_declared_asset(self.ledger, self.build())


# ── informes ──────────


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
            _caption(self, f"Linhas com valor que não foram reconhecidas: {shown}")
        _caption(
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
        value = QTableWidgetItem(_editable(line.amount) if line else "")
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


class ParametersDialog(FormDialog):
    """The year's progressive table and limits, copied from the official source."""

    def __init__(self, parent: QWidget | None, ledger: Ledger, year: int) -> None:
        super().__init__(parent, f"Tabela e limites de {year}", "Salvar")
        self.ledger, self.year = ledger, year
        current = records.parameters(ledger, year) or TaxParameters(year=year)
        self.table = QTableWidget(0, 3)
        self.table.setHorizontalHeaderLabels(["Base anual até (vazio: acima)", "Alíquota (%)", "Parcela a deduzir"])
        self.table.verticalHeader().setVisible(False)
        self.table.setAccessibleName("Faixas da tabela anual")
        self.table.setMinimumHeight(200)
        from PySide6.QtWidgets import QHeaderView

        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)  # three equal columns
        for bracket in current.brackets or (None,) * 5:
            self._add(bracket)
        from opesvault.ui.components import hbox_widget

        tools = hbox_widget(
            button("Adicionar faixa", lambda: self._add(None), role="plain"),
            button("Remover faixa", self._remove, role="plain"),
            None,
        )
        self.simple_rate = QLineEdit(_percent_text(current.simplified_rate))
        self.simple_cap = money_edit()
        self.simple_cap.setText(_editable(current.simplified_cap))
        self.dependent = money_edit()
        self.dependent.setText(_editable(current.dependent_deduction))
        self.education = money_edit()
        self.education.setText(_editable(current.education_cap))
        self.pension = QLineEdit(_percent_text(current.pension_cap_rate))
        self.source = QLineEdit(current.source)
        self.source.setMaxLength(300)
        for edit, name in (
            (self.simple_rate, "Desconto simplificado (%)"),
            (self.simple_cap, "Teto do desconto simplificado"),
            (self.dependent, "Dedução por dependente"),
            (self.education, "Limite de instrução por pessoa"),
            (self.pension, "Limite da previdência privada (%)"),
            (self.source, "Fonte dos valores"),
        ):
            edit.setAccessibleName(name)
        _caption(
            self,
            "Nada vem preenchido: copie os valores do ano da fonte oficial (Receita Federal). "
            "Eles valem só para a simulação deste cofre.",
        )
        self.form.addRow(self.table)
        self.form.addRow("", tools)
        self.form.addRow("Desconto simplificado (%):", self.simple_rate)
        self.form.addRow("Teto do desconto:", self.simple_cap)
        self.form.addRow("Por dependente:", self.dependent)
        self.form.addRow("Instrução por pessoa:", self.education)
        self.form.addRow("Previdência privada (%):", self.pension)
        self.form.addRow("Fonte:", self.source)
        self.setMinimumWidth(640)

    def _add(self, bracket: Bracket | None) -> None:
        row = self.table.rowCount()
        self.table.insertRow(row)
        values = (
            (
                _editable(bracket.up_to) if bracket.up_to is not None else "",
                _percent_text(bracket.rate),
                _editable(bracket.deduction),
            )
            if bracket
            else ("", "", "")
        )
        for column, value in enumerate(values):
            item = QTableWidgetItem(value)
            item.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            self.table.setItem(row, column, item)

    def _remove(self) -> None:
        row = self.table.currentRow()
        if row >= 0:
            self.table.removeRow(row)

    def build(self) -> TaxParameters:
        brackets = []
        for row in range(self.table.rowCount()):
            cells = [_cell(self.table, row, c) for c in range(3)]
            if not any(cells):
                continue
            try:
                up_to = parse_brl(cells[0]) if cells[0] else None
                rate = parse_brl(cells[1].replace("%", "")) / 100 if cells[1] else Decimal(0)
                deduction = parse_brl(cells[2]) if cells[2] else Decimal(0)
            except MoneyError:
                raise DomainError(f"Faixa {row + 1}: use valores como 2.259,20 e 7,5.") from None
            brackets.append(Bracket(up_to=up_to, rate=rate, deduction=deduction))
        return TaxParameters(
            year=self.year,
            brackets=tuple(brackets),
            simplified_rate=read_percent(self.simple_rate, "Desconto simplificado"),
            simplified_cap=read_money(self.simple_cap, allow_empty=True),
            dependent_deduction=read_money(self.dependent, allow_empty=True),
            education_cap=read_money(self.education, allow_empty=True),
            pension_cap_rate=read_percent(self.pension, "Previdência privada"),
            source=self.source.text().strip() or "informado pelo usuário",
        )

    def validate(self) -> None:
        self.build()

    def apply(self) -> None:
        records.set_parameters(self.ledger, self.build())


class VariableRulesDialog(FormDialog):
    """Rates of stock, ETF and real estate fund gains and the monthly exemption limit."""

    def __init__(self, parent: QWidget | None, ledger: Ledger) -> None:
        super().__init__(parent, "Regras de renda variável", "Salvar")
        self.ledger = ledger
        self.setMinimumWidth(600)
        current = records.variable_rules(ledger)
        self.valid_from = date_edit(current.valid_from if current else date(date.today().year, 1, 1))
        self.valid_from.setAccessibleName("Vale a partir de")
        self.rates: dict[Bucket, QLineEdit] = {}
        self.form.addRow("Vale a partir de:", self.valid_from)
        for bucket, label in BUCKET_LABELS.items():
            rule = current.rule(bucket) if current else None
            edit = QLineEdit(_percent_text(rule.rate if rule else None))
            edit.setPlaceholderText("alíquota em %")
            edit.setAccessibleName(f"Alíquota: {label}")
            self.rates[bucket] = edit
            self.form.addRow(f"{label} (%):", edit)
        common = current.rule(Bucket.COMMON) if current else None
        self.limit = money_edit("sem isenção")
        self.limit.setText(_editable(common.exempt_sales_limit if common else None))
        self.limit.setAccessibleName("Limite mensal de vendas isentas de ações")
        self.form.addRow("Vendas de ações isentas até:", self.limit)
        self.source = QLineEdit(current.source if current else "")
        self.source.setPlaceholderText("de onde vieram os valores")
        self.source.setAccessibleName("Fonte")
        self.form.addRow("Fonte:", self.source)
        _caption(
            self,
            "Nada vem preenchido: informe as alíquotas e o limite vigentes. Prejuízos são compensados nos meses "
            "seguintes dentro do mesmo tipo (comuns, day trade, fundos imobiliários). Sem alíquota, o imposto "
            "fica desconhecido.",
        )

    def build(self) -> list[BucketRule]:
        limit = read_money(self.limit, allow_empty=True)
        return [
            BucketRule(
                bucket=bucket,
                rate=read_percent(edit, BUCKET_LABELS[bucket]),
                exempt_sales_limit=limit if bucket is Bucket.COMMON else None,
            )
            for bucket, edit in self.rates.items()
        ]

    def validate(self) -> None:
        self.build()

    def apply(self) -> None:
        records.set_variable_rules(self.ledger, from_qdate(self.valid_from.date()), self.build(), self.source.text())


class PaymentDialog(FormDialog):
    """A DARF paid: money leaves the account as a tax expense and the month counts as paid."""

    def __init__(
        self,
        parent: QWidget | None,
        ledger: Ledger,
        purpose: PaymentPurpose,
        month: YearMonth,
        member_id: UUID | None,
        suggested: Decimal | None,
    ) -> None:
        from opesvault.tax.model import PURPOSE_LABELS

        super().__init__(parent, PURPOSE_LABELS[purpose], "Registrar pagamento")
        self.ledger, self.purpose, self.month, self.member_id = ledger, purpose, month, member_id
        self.amount = money_edit()
        self.amount.setText(_editable(suggested))
        self.amount.setAccessibleName("Valor pago")
        self.on = date_edit()
        self.on.setAccessibleName("Data do pagamento")
        self.account = QComboBox()
        self.account.setAccessibleName("Conta")
        fill_combo(self.account, liquid_accounts(ledger))
        member = ledger.members.get(member_id) if member_id else None
        who = member.name if member else None
        _caption(
            self,
            f"Apuração de {month.month:02d}/{month.year}"
            + (f" · {who}" if who else "")
            + ". Valor com multa e juros, se pago em atraso.",
        )
        self.form.addRow("Valor:", self.amount)
        self.form.addRow("Pago em:", self.on)
        self.form.addRow("Conta:", self.account)

    def validate(self) -> None:
        read_money(self.amount)
        if combo_value(self.account) is None:
            raise DomainError("Escolha a conta.")

    def apply(self) -> None:
        records.record_payment(
            self.ledger,
            self.purpose,
            self.month,
            read_money(self.amount),
            from_qdate(self.on.date()),
            combo_value(self.account),
            self.member_id,
        )
