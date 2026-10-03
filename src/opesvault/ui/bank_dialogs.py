"""Dialogs of bank accounts (domain.banking) and investment characteristics (investments.profile)."""

from datetime import date
from decimal import Decimal
from typing import Any
from uuid import UUID

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QLineEdit,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QWidget,
)

from opesvault.catalogs.irpf import EXCLUSIVE_CODES, EXEMPT_CODES
from opesvault.domain import banking
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import OperationKind
from opesvault.domain.money import MoneyError, format_brl, format_decimal_br, parse_brl
from opesvault.investments import profile as prof
from opesvault.investments.model import ASSET_CLASS_LABELS, AssetClass
from opesvault.tax import ids
from opesvault.ui.catalog_widgets import OTHER_BANK, bank_combo, investment_code_combo
from opesvault.ui.common import (
    combo_value,
    date_edit,
    fill_combo,
    fmt,
    from_qdate,
    money_edit,
    read_money,
    select_combo,
    stretch_column,
)
from opesvault.ui.components import hbox_widget, text
from opesvault.ui.dialogs import FormDialog


def _editable(value: Decimal | None) -> str:
    return "" if value is None else format_brl(value).replace("R$", "").strip()


def _caption(form: FormDialog, message: str) -> None:
    form.form.addRow("", text(message, "caption", wrap=True))


def _members(ledger: Ledger) -> list[tuple[str, UUID]]:
    return [(m.name, m.id) for m in sorted(ledger.members.values(), key=lambda m: m.name.casefold()) if m.active]


class _Part:
    """One part of a bank account in the form: include it, new or existing, and its opening balance."""

    def __init__(self, ledger: Ledger, part: banking.Part, current: UUID | None, bank_id: UUID | None) -> None:
        self.part = part
        self.current = current
        label = banking.PART_LABELS[part]
        self.label = label
        self.include = QCheckBox("incluir")
        self.include.setAccessibleName(f"Incluir {label.lower()}")
        self.include.setChecked(current is not None)
        self.include.setEnabled(current is None)  # a part is added, never removed here
        self.source = QComboBox()
        self.source.setAccessibleName(f"{label}: nova ou existente")
        subtype = banking.PART_SUBTYPES[part]
        free = [
            (f"Usar {a.name}", a.id)
            for a in sorted(ledger.accounts.values(), key=lambda a: a.name.casefold())
            if a.subtype is subtype and not a.archived and (banking.of_account(ledger, a.id) is None)
        ]
        fill_combo(self.source, [("Criar nova", None), *free])
        self.opening = money_edit("saldo inicial (opcional)")
        self.opening.setAccessibleName(f"{label}: saldo inicial")
        self.widgets: list[QWidget] = [self.source, self.opening]
        if current is not None:
            self.source.clear()
            self.source.addItem(ledger.account(current).name, current)
            for widget in self.widgets:
                widget.setEnabled(False)
        else:
            self.include.toggled.connect(self._toggle)
            self.source.currentIndexChanged.connect(self._toggle)
            self._toggle()

    def _toggle(self) -> None:
        on = self.include.isChecked()
        self.source.setEnabled(on)
        self.opening.setEnabled(on and combo_value(self.source) is None)

    def row(self) -> QWidget:
        from PySide6.QtWidgets import QSizePolicy

        self.source.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.opening.setMinimumWidth(170)
        return hbox_widget(self.include, self.source, self.opening)

    def wanted(self) -> bool | UUID:
        if self.current is not None or not self.include.isChecked():
            return False
        chosen = combo_value(self.source)
        return chosen if isinstance(chosen, UUID) else True


class BankAccountDialog(FormDialog):
    """Bank (COMPE list), branch, number, holder or joint holders, and the parts inside."""

    def __init__(self, parent: QWidget | None, ledger: Ledger, item: banking.BankAccount | None = None) -> None:
        super().__init__(parent, "Conta bancária" if item else "Nova conta bancária", "Salvar")
        self.ledger, self.item = ledger, item
        self.name = QLineEdit(item.name if item else "")
        self.name.setPlaceholderText("ex.: Itaú da Ana (vazio: nome do banco)")
        self.name.setAccessibleName("Nome da conta")
        self.bank = bank_combo(item.bank_code if item else None)
        if item is not None and item.bank_code is None:
            select_combo(self.bank, OTHER_BANK)
        self.other_bank = QLineEdit(item.bank_name if item and item.bank_code is None else "")
        self.other_bank.setPlaceholderText("nome da instituição")
        self.other_bank.setAccessibleName("Nome da instituição")
        self.bank.currentIndexChanged.connect(self._bank_changed)
        self.branch = QLineEdit(item.branch or "" if item else "")
        self.branch.setPlaceholderText("ex.: 0123-4")
        self.branch.setAccessibleName("Agência")
        self.number = QLineEdit(item.number or "" if item else "")
        self.number.setPlaceholderText("ex.: 12345-6")
        self.number.setAccessibleName("Número da conta")
        for edit in (self.branch, self.number):
            edit.setMaxLength(30)
        self.holder = QComboBox()
        self.holder.setAccessibleName("Titular")
        fill_combo(self.holder, _members(ledger))
        select_combo(self.holder, item.holder_id if item else None)
        self.joint = QCheckBox("Conta conjunta")
        self.co_holder = QComboBox()
        self.co_holder.setAccessibleName("Segundo titular")
        fill_combo(self.co_holder, _members(ledger))
        if item and item.co_holder_id:
            self.joint.setChecked(True)
            select_combo(self.co_holder, item.co_holder_id)
        self.joint.toggled.connect(self.co_holder.setEnabled)
        self.co_holder.setEnabled(self.joint.isChecked())
        self.parts = [
            _Part(ledger, banking.Part.CHECKING, item.checking_id if item else None, item.id if item else None),
            _Part(ledger, banking.Part.SAVINGS, item.savings_id if item else None, item.id if item else None),
        ]
        self.opening_date = date_edit(date(date.today().year, 1, 1))
        self.opening_date.setAccessibleName("Data do saldo inicial")
        self.form.addRow("Nome:", self.name)
        self.form.addRow("Banco:", self.bank)
        self.form.addRow("Instituição:", self.other_bank)
        self.form.addRow("Agência:", self.branch)
        self.form.addRow("Conta:", self.number)
        self.form.addRow("Titular:", self.holder)
        from PySide6.QtWidgets import QSizePolicy

        self.co_holder.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.form.addRow("Segundo titular:", hbox_widget(self.joint, self.co_holder))
        for part in self.parts:
            self.form.addRow(f"{part.label}:", part.row())
        self.form.addRow("Saldo inicial em:", self.opening_date)
        _caption(
            self,
            "Banco pela lista de códigos COMPE (digite o código ou parte do nome). Agência e conta aceitam letras, "
            "números e símbolos, sem espaços. Uma conta pode ter só corrente, só poupança, as duas ou nenhuma "
            "(só investimentos); os investimentos entram por Novo investimento.",
        )
        self._bank_changed()
        self.setMinimumWidth(640)

    def _bank_changed(self) -> None:
        self.other_bank.setEnabled(combo_value(self.bank) == OTHER_BANK)

    def build(self) -> banking.BankAccount:
        code = combo_value(self.bank)
        if code is None:
            raise DomainError("Escolha o banco na lista ou Outra instituição.")
        holder = combo_value(self.holder)
        if holder is None:
            raise DomainError("Cadastre o titular em Integrantes antes.")
        built = banking.build(
            name=self.name.text(),
            bank_code=None if code == OTHER_BANK else code,
            bank_name=self.other_bank.text() if code == OTHER_BANK else None,
            branch=self.branch.text(),
            number=self.number.text(),
            holder_id=holder,
            co_holder_id=combo_value(self.co_holder) if self.joint.isChecked() else None,
        )
        if self.item is None:
            return built
        return self.item.model_copy(
            update={
                k: getattr(built, k)
                for k in ("name", "bank_code", "bank_name", "branch", "number", "holder_id", "co_holder_id")
            }
        )

    def _openings(self) -> dict[banking.Part, tuple[Decimal, date]]:
        on = from_qdate(self.opening_date.date())
        out = {}
        for part in self.parts:
            value = read_money(part.opening, allow_empty=True) if part.opening.isEnabled() else None
            if value:
                out[part.part] = (value, on)
        return out

    def validate(self) -> None:
        self.build()
        self._openings()

    def apply(self) -> banking.BankAccount:
        item = self.build()
        if self.item is None:
            wanted = {p.part: p.wanted() for p in self.parts}
            return banking.create(
                self.ledger,
                item,
                checking=wanted[banking.Part.CHECKING],
                savings=wanted[banking.Part.SAVINGS],
                opening=self._openings(),
            )
        add = tuple(p.part for p in self.parts if p.wanted() is True)
        for p in self.parts:
            chosen = p.wanted()
            if isinstance(chosen, UUID):
                field = "checking_id" if p.part is banking.Part.CHECKING else "savings_id"
                item = item.model_copy(update={field: chosen})
        saved = banking.update(self.ledger, item, add=add)
        for part, (value, on) in self._openings().items():
            account_id = dict(saved.components()).get(part)
            if account_id is not None:
                self.ledger.record_opening_balance(account_id, value, on)
        return saved


def tracked_by_values(ledger: Ledger, account_id: UUID) -> bool:
    """The account has only opening balances and adjustments: its balance comes from informed values."""
    return all(
        op.kind is OperationKind.OPENING_BALANCE
        for op in ledger.active_operations()
        if any(p.account_id == account_id for p in op.postings)
    )


class ValuesDialog(FormDialog):
    """What the bank shows for each part on a date: checked, optionally adjusted, investments valued."""

    def __init__(self, parent: QWidget | None, ledger: Ledger, bank_id: UUID) -> None:
        item = banking.bank_accounts(ledger)[bank_id]
        super().__init__(parent, f"Valores em uma data — {item.name}", "Registrar valores")
        self.ledger, self.bank_id = ledger, bank_id
        self.on = date_edit()
        self.on.setAccessibleName("Data dos valores")
        self.on.dateChanged.connect(self._fill_app_values)
        self.table = QTableWidget(0, 4)
        self.table.setHorizontalHeaderLabels(["Item", "No aplicativo", "Valor no banco", "Ajustar o saldo"])
        self.table.verticalHeader().setVisible(False)
        self.table.setAccessibleName("Valores por item")
        stretch_column(self.table, 0)
        from PySide6.QtWidgets import QHeaderView

        for column in (1, 2, 3):
            self.table.horizontalHeader().setSectionResizeMode(column, QHeaderView.ResizeMode.ResizeToContents)
        self.table.setMinimumHeight(220)
        self.rows = banking.values_at(ledger, bank_id, date.today())
        self.table.setRowCount(len(self.rows))
        for row, value in enumerate(self.rows):
            name = QTableWidgetItem(value.label)
            name.setFlags(name.flags() & ~Qt.ItemFlag.ItemIsEditable)
            self.table.setItem(row, 0, name)
            informed = QTableWidgetItem("")
            informed.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            self.table.setItem(row, 2, informed)
            adjust = QTableWidgetItem("")
            if value.kind == "investment":
                adjust.setFlags(Qt.ItemFlag.NoItemFlags)
                adjust.setText("vira avaliação")
            else:
                adjust.setFlags(Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsUserCheckable)
                adjust.setCheckState(
                    Qt.CheckState.Checked if tracked_by_values(ledger, value.ref) else Qt.CheckState.Unchecked
                )
            self.table.setItem(row, 3, adjust)
        self._fill_app_values()
        self.note = QLineEdit()
        self.note.setPlaceholderText("ex.: extrato do aplicativo, informe de rendimentos")
        self.note.setAccessibleName("Origem dos valores")
        self.form.addRow("Data:", self.on)
        self.form.addRow(self.table)
        self.form.addRow("Origem:", self.note)
        _caption(
            self,
            "Deixe em branco o que não quiser informar. Cada saldo vira uma conferência com o banco; com "
            "“Ajustar o saldo”, a diferença é lançada como ajuste nessa data e o saldo do aplicativo "
            "passa a ser o do banco (patrimônio, relatórios e imposto de renda acompanham). Contas com "
            "lançamentos ficam sem ajuste por padrão: a diferença indica lançamento faltando. Investimentos "
            "recebem uma avaliação nessa data.",
        )
        self.setMinimumWidth(720)

    def _fill_app_values(self) -> None:
        on = from_qdate(self.on.date())
        current = {v.ref: v.value for v in banking.values_at(self.ledger, self.bank_id, on)}
        for row, value in enumerate(self.rows):
            cell = QTableWidgetItem(fmt(current.get(value.ref)))
            cell.setFlags(cell.flags() & ~Qt.ItemFlag.ItemIsEditable)
            cell.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            self.table.setItem(row, 1, cell)

    def values(self) -> tuple[dict[UUID, object], set[UUID]]:
        out: dict[UUID, object] = {}
        adjust: set[UUID] = set()
        for row, value in enumerate(self.rows):
            cell = self.table.item(row, 2)
            raw = cell.text().strip() if cell else ""
            if not raw:
                continue
            try:
                out[value.ref] = parse_brl(raw)
            except MoneyError:
                raise DomainError(f"{value.label}: valor inválido, use o formato 1.234,56.") from None
            check = self.table.item(row, 3)
            if value.kind != "investment" and check is not None and check.checkState() == Qt.CheckState.Checked:
                adjust.add(value.ref)
        if not out:
            raise DomainError("Informe ao menos um valor.")
        return out, adjust

    def validate(self) -> None:
        self.values()

    def apply(self) -> banking.Recorded:
        values, adjust = self.values()
        return banking.record_values(
            self.ledger, self.bank_id, from_qdate(self.on.date()), values, adjust=adjust, note=self.note.text()
        )


# ── investments ──────────


def _rate(edit: QLineEdit) -> Decimal | None:
    raw = edit.text().strip().replace("%", "")
    if not raw:
        return None
    try:
        return parse_brl(raw)
    except MoneyError:
        raise DomainError("Taxa: use um número como 110 ou 6,5.") from None


class InvestmentDialog(FormDialog):
    """A new investment held at a bank account, or the characteristics of an existing one."""

    def __init__(
        self,
        parent: QWidget | None,
        ledger: Ledger,
        *,
        bank_id: UUID | None = None,
        position_id: UUID | None = None,
    ) -> None:
        from opesvault.ui.operation_edit import OptionalDate

        self.ledger, self.position_id = ledger, position_id
        current = prof.profile_of(ledger, position_id) if position_id else None
        super().__init__(parent, "Características do investimento" if position_id else "Novo investimento", "Salvar")
        self.name = QLineEdit()
        self.name.setAccessibleName("Nome do investimento")
        self.name.setPlaceholderText("ex.: CDB Banco X 2027, Tesouro IPCA+ 2035, PETR4")
        self.kind = investment_code_combo(
            (current.irpf_group, current.irpf_code) if current and current.irpf_group and current.irpf_code else None
        )
        self.kind.currentIndexChanged.connect(self._kind_changed)
        self.asset_class = QComboBox()
        self.asset_class.setAccessibleName("Classe no aplicativo")
        fill_combo(self.asset_class, [(label, c) for c, label in ASSET_CLASS_LABELS.items()])
        self.bank = QComboBox()
        self.bank.setAccessibleName("Conta bancária ou corretora")
        fill_combo(
            self.bank,
            [(b.name, b.id) for b in banking.bank_accounts(ledger).values() if not b.archived],
            empty="(nenhuma)",
        )
        select_combo(self.bank, current.bank_account_id if current else bank_id)
        self.value = money_edit()
        self.value.setAccessibleName("Valor aplicado")
        self.from_checking = QCheckBox("O dinheiro saiu da conta corrente desta conta bancária")
        self.from_checking.setChecked(True)
        self.issuer = QLineEdit(current.issuer or "" if current else "")
        self.issuer.setAccessibleName("Emissor")
        self.issuer.setPlaceholderText("banco, empresa ou Tesouro Nacional")
        self.issuer_id = QLineEdit(ids.display(current.issuer_tax_id) if current and current.issuer_tax_id else "")
        self.issuer_id.setAccessibleName("CNPJ do emissor")
        self.issuer_id.setPlaceholderText("00.000.000/0000-00")
        self.indexer = QComboBox()
        self.indexer.setAccessibleName("Indexador")
        fill_combo(self.indexer, [(label, i) for i, label in prof.INDEXER_LABELS.items()], empty="Não informado")
        select_combo(self.indexer, current.indexer if current else None)
        self.rate = QLineEdit(format_decimal_br(current.rate) if current and current.rate is not None else "")
        self.rate.setAccessibleName("Taxa (%)")
        self.rate.setPlaceholderText("ex.: 110 (% do CDI), 6,5 (IPCA +), 12,4 (prefixado)")
        self.applied = OptionalDate(current.applied_on if current else date.today())
        self.applied.setAccessibleName("Data da aplicação")
        self.maturity = OptionalDate(current.maturity if current else None)
        self.maturity.setAccessibleName("Vencimento")
        self.liquidity = QComboBox()
        self.liquidity.setAccessibleName("Liquidez")
        fill_combo(self.liquidity, [(label, li) for li, label in prof.LIQUIDITY_LABELS.items()], empty="Não informada")
        select_combo(self.liquidity, current.liquidity if current else None)
        self.days = QSpinBox()
        self.days.setRange(0, 3650)
        self.days.setPrefix("D+")
        self.days.setAccessibleName("Dias para o resgate")
        self.days.setValue(current.liquidity_days or 0 if current else 0)
        self.tax = QComboBox()
        self.tax.setAccessibleName("Tributação")
        fill_combo(self.tax, [(label, t) for t, label in prof.TAX_LABELS.items()], empty="Não informada")
        select_combo(self.tax, current.tax if current else None)
        self.income_code = QComboBox()
        self.income_code.setAccessibleName("Código do rendimento no IRPF")
        codes = [(f"Isentos {c} — {d}", f"isento:{c}") for c, d in EXEMPT_CODES.items()]
        codes += [(f"Tributação exclusiva {c} — {d}", f"exclusivo:{c}") for c, d in EXCLUSIVE_CODES.items()]
        fill_combo(self.income_code, codes, empty="Não informado")
        select_combo(self.income_code, current.income_code if current else None)
        self.fgc = QComboBox()
        self.fgc.setAccessibleName("Cobertura do FGC")
        fill_combo(self.fgc, [("Sim", True), ("Não", False)], empty="Não informado")
        select_combo(self.fgc, current.fgc if current else None)
        self.notes = QLineEdit(current.notes or "" if current else "")
        self.notes.setAccessibleName("Observações")
        self.notes.setMaxLength(500)
        if position_id is None:
            self.form.addRow("Nome:", self.name)
        self.form.addRow("Tipo (IRPF):", self.kind)
        if position_id is None:
            self.form.addRow("Classe:", self.asset_class)
        self.form.addRow("Onde está:", self.bank)
        if position_id is None:
            self.form.addRow("Valor aplicado:", self.value)
            self.form.addRow("", self.from_checking)
        for label, widget in (
            ("Emissor:", self.issuer),
            ("CNPJ do emissor:", self.issuer_id),
            ("Indexador:", self.indexer),
            ("Taxa (%):", self.rate),
            ("Aplicação:", self.applied),
            ("Vencimento:", self.maturity),
            ("Liquidez:", hbox_widget(self.liquidity, self.days, None)),
            ("Tributação:", self.tax),
            ("Rendimento (IR):", self.income_code),
            ("FGC:", self.fgc),
            ("Observações:", self.notes),
        ):
            self.form.addRow(label, widget)
        _caption(
            self,
            "Tipo e rendimento seguem as tabelas do IRPF e preenchem Bens e Direitos e os rendimentos; a "
            "tributação diz como o imposto é cobrado, sem alíquota embutida. O valor ao longo do tempo fica nas "
            "avaliações (Valores em uma data)."
            + (
                ""
                if position_id
                else " Ações e fundos negociados por quantidade são registrados em Investimentos › Negociação."
            ),
        )
        self._kind_changed()
        self.setMinimumWidth(680)

    def _kind_changed(self) -> None:
        chosen = combo_value(self.kind)
        if chosen is None:
            return
        group, code = chosen
        if self.position_id is None:
            select_combo(self.asset_class, prof.class_for(group, code))
        if combo_value(self.tax) is None:
            select_combo(self.tax, prof.tax_for(group, code))

    def _profile(self, position_id: UUID) -> prof.InvestmentProfile:
        chosen = combo_value(self.kind)
        if chosen is None:
            raise DomainError("Escolha o tipo do investimento na tabela do IRPF.")
        raw_id = self.issuer_id.text().strip()
        issuer_id = ids.normalize(raw_id, (ids.TaxIdKind.CNPJ,)) if raw_id else None
        liquidity = combo_value(self.liquidity)
        indexer, tax = combo_value(self.indexer), combo_value(self.tax)
        return prof.InvestmentProfile(
            position_id=position_id,
            bank_account_id=combo_value(self.bank),
            irpf_group=chosen[0],
            irpf_code=chosen[1],
            issuer=" ".join(self.issuer.text().split())[:120] or None,
            issuer_tax_id=issuer_id,
            indexer=prof.Indexer(indexer) if indexer else None,
            rate=_rate(self.rate),
            applied_on=self.applied.value(),
            maturity=self.maturity.value(),
            liquidity=prof.Liquidity(liquidity) if liquidity else None,
            liquidity_days=self.days.value() if liquidity == prof.Liquidity.DAYS else None,
            tax=prof.TaxTreatment(tax) if tax else None,
            income_code=combo_value(self.income_code),
            fgc=combo_value(self.fgc),
            notes=self.notes.text().strip() or None,
        )

    def validate(self) -> None:
        if self.position_id is None:
            if not self.name.text().strip():
                raise DomainError("Informe o nome do investimento.")
            read_money(self.value)
        from uuid import uuid4

        self._profile(self.position_id or uuid4())

    def apply(self) -> Any:
        from opesvault.investments.service import create_position

        position_id = self.position_id
        if position_id is None:
            bank = banking.bank_accounts(self.ledger).get(combo_value(self.bank)) if combo_value(self.bank) else None
            value = read_money(self.value)
            on = self.applied.value() or date.today()
            from_account = bank.checking_id if bank is not None and self.from_checking.isChecked() else None
            position = create_position(
                self.ledger,
                self.name.text().strip(),
                AssetClass(combo_value(self.asset_class)),
                on,
                holder_id=bank.holder_id if bank else None,
                initial_cost=value,
                from_account=from_account,
            )
            position_id = position.id
        return prof.save_profile(self.ledger, self._profile(position_id))
