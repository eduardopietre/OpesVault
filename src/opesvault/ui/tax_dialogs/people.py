"""Who declares: CPF/CNPJ of a payer or payee, a member's tax data, declarants and dependents."""

from typing import ClassVar
from uuid import UUID

from PySide6.QtWidgets import (
    QComboBox,
    QLineEdit,
    QWidget,
)

from opesvault.domain.ledger import Ledger
from opesvault.tax import ids, records
from opesvault.tax.model import (
    TaxSubject,
)
from opesvault.ui.common import (
    combo_value,
    fill_combo,
    fit_to_rows,
    fmt_date,
    select_combo,
    set_rows,
    stretch_column,
    summary_table,
)
from opesvault.ui.components import button
from opesvault.ui.dialogs import FormDialog
from opesvault.ui.tax_dialogs.fields import caption


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
        caption(
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
        caption(
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
