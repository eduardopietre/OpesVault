"""Bens e direitos: how an account or investment is filed, and assets declared by hand."""

from uuid import UUID

from PySide6.QtWidgets import (
    QComboBox,
    QLineEdit,
    QWidget,
)

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.tax import records
from opesvault.tax.model import (
    DeclaredAsset,
    FilingSubject,
)
from opesvault.ui.catalog_widgets import asset_code_combo
from opesvault.ui.common import (
    combo_value,
    date_edit,
    fill_combo,
    from_qdate,
    money_edit,
    read_money,
    select_combo,
)
from opesvault.ui.dialogs import FormDialog
from opesvault.ui.tax_dialogs.fields import caption, editable


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
        caption(
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
        self.cost.setText(editable(asset.cost) if asset else "")
        self.cost.setAccessibleName("Custo de aquisição")
        self.sold = OptionalDate(asset.sold_on if asset else None)
        self.sold.setAccessibleName("Data de venda")
        self.sale = money_edit()
        self.sale.setText(editable(asset.sale_value) if asset else "")
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
        caption(
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
