"""Entry dialogs for registrations and manual operations (docs/07 §2)."""

from datetime import date
from decimal import Decimal
from typing import Any, ClassVar
from uuid import UUID

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, Card, LedgerAccount, YearMonth
from opesvault.ui.common import (
    CompetenceCombo,
    combo_value,
    date_edit,
    fill_combo,
    from_qdate,
    money_edit,
    read_money,
    select_combo,
)

SUBTYPE_LABELS: dict[AccountSubtype, str] = {
    AccountSubtype.CHECKING: "Conta corrente",
    AccountSubtype.SAVINGS: "Poupança",
    AccountSubtype.CASH: "Dinheiro",
    AccountSubtype.BROKERAGE_CASH: "Saldo em corretora",
    AccountSubtype.INVESTMENT: "Investimento",
    AccountSubtype.OTHER_ASSET: "Outro bem",
    AccountSubtype.CREDIT_CARD: "Cartão de crédito",
    AccountSubtype.LOAN: "Empréstimo/financiamento",
    AccountSubtype.OTHER_LIABILITY: "Outra dívida",
    AccountSubtype.TAX_PAYABLE: "Imposto a pagar",
}
ASSET_SUBTYPES = (
    AccountSubtype.CHECKING,
    AccountSubtype.SAVINGS,
    AccountSubtype.CASH,
    AccountSubtype.BROKERAGE_CASH,
    AccountSubtype.INVESTMENT,
    AccountSubtype.OTHER_ASSET,
)
LIABILITY_SUBTYPES = (AccountSubtype.LOAN, AccountSubtype.OTHER_LIABILITY, AccountSubtype.TAX_PAYABLE)


class FormDialog(QDialog):
    """Shared form frame: fields, an inline error line and Cancel / <verb> buttons.

    Errors are shown next to the form instead of in a second dialog, so the user fixes
    them without losing context.
    """

    def __init__(self, parent: QWidget | None, title: str, confirm: str = "Salvar") -> None:
        from opesvault.ui.components import text

        super().__init__(parent)
        self.setWindowTitle(title)
        self.setMinimumWidth(420)
        self.form = QFormLayout()
        self.form.setLabelAlignment(Qt.AlignmentFlag.AlignRight)
        self.form.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        self.form.setVerticalSpacing(8)
        self.error = text("", wrap=True)
        self.error.setProperty("tone", "negative")
        self.error.setAccessibleName("Erro no formulário")
        self.error.hide()
        layout = QVBoxLayout(self)
        layout.setSpacing(12)
        layout.addLayout(self.form)
        layout.addWidget(self.error)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        self.confirm_button = buttons.button(QDialogButtonBox.StandardButton.Ok)
        self.confirm_button.setText(confirm)
        self.confirm_button.setProperty("role", "primary")
        buttons.button(QDialogButtonBox.StandardButton.Cancel).setText("Cancelar")
        buttons.accepted.connect(self._try_accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def _try_accept(self) -> None:
        try:
            self.validate()
        except DomainError as exc:
            self.show_error(str(exc))
            return
        self.accept()

    def show_error(self, message: str | None) -> None:
        self.error.setText(message or "")
        self.error.setVisible(bool(message))

    def validate(self) -> None:
        pass


def liquid_accounts(ledger: Ledger) -> list[tuple[str, UUID]]:
    return [
        (a.name, a.id) for a in sorted(ledger.accounts.values(), key=lambda a: a.name) if a.is_liquid and not a.archived
    ]


def asset_accounts(ledger: Ledger) -> list[tuple[str, UUID]]:
    return [
        (a.name, a.id)
        for a in sorted(ledger.accounts.values(), key=lambda a: a.name)
        if a.type is AccountType.ASSET and not a.archived
    ]


def balance_accounts(ledger: Ledger) -> list[tuple[str, UUID]]:
    return [
        (a.name, a.id)
        for a in sorted(ledger.accounts.values(), key=lambda a: a.name)
        if a.type in (AccountType.ASSET, AccountType.LIABILITY) and not a.archived
    ]


def category_items(ledger: Ledger, kind: AccountType) -> list[tuple[str, UUID]]:
    def label(account: LedgerAccount) -> str:
        parent = ledger.accounts.get(account.parent_id) if account.parent_id else None
        return f"{parent.name} › {account.name}" if parent else account.name

    return sorted(((label(a), a.id) for a in ledger.categories(kind)), key=lambda t: t[0])


class AccountDialog(FormDialog):
    def __init__(self, parent: QWidget | None, ledger: Ledger, account: LedgerAccount | None = None) -> None:
        super().__init__(parent, "Conta", "Salvar conta")
        self.ledger = ledger
        self.original = account
        self.name = QLineEdit(account.name if account else "")
        self.subtype = QComboBox()
        fill_combo(self.subtype, [(SUBTYPE_LABELS[s], s) for s in (*ASSET_SUBTYPES, *LIABILITY_SUBTYPES)])
        self.institution = QLineEdit(account.institution or "" if account else "")
        self.masked = QLineEdit(account.masked_number or "" if account else "")
        self.masked.setPlaceholderText("ex.: final 1234")
        self.holders = QListWidget()
        for member in ledger.members.values():
            item = QListWidgetItem(member.name)
            item.setData(Qt.ItemDataRole.UserRole, member.id)
            item.setCheckState(
                Qt.CheckState.Checked if account and member.id in account.holders else Qt.CheckState.Unchecked
            )
            self.holders.addItem(item)
        self.opening = money_edit("saldo de abertura (opcional)")
        self.opening_date = date_edit()
        self.form.addRow("Nome:", self.name)
        self.form.addRow("Tipo:", self.subtype)
        self.form.addRow("Instituição:", self.institution)
        self.form.addRow("Identificação:", self.masked)
        self.form.addRow("Titulares:", self.holders)
        if account is None:
            self.form.addRow("Saldo de abertura:", self.opening)
            self.form.addRow("Data do saldo:", self.opening_date)
        else:
            select_combo(self.subtype, account.subtype)
            self.subtype.setEnabled(False)

    def selected_holders(self) -> tuple[UUID, ...]:
        out = []
        for i in range(self.holders.count()):
            item = self.holders.item(i)
            if item.checkState() == Qt.CheckState.Checked:
                out.append(item.data(Qt.ItemDataRole.UserRole))
        return tuple(out)

    def build(self) -> LedgerAccount:
        subtype: AccountSubtype = combo_value(self.subtype)
        kind = AccountType.ASSET if subtype in ASSET_SUBTYPES else AccountType.LIABILITY
        fields = {
            "name": self.name.text().strip(),
            "type": kind,
            "subtype": subtype,
            "institution": self.institution.text().strip() or None,
            "masked_number": self.masked.text().strip() or None,
            "holders": self.selected_holders(),
        }
        if not fields["name"]:
            raise DomainError("Informe o nome da conta.")
        if self.original is not None:
            return self.original.model_copy(update=fields)
        return LedgerAccount(**fields)  # type: ignore[arg-type]

    def opening_balance(self) -> tuple[Decimal, date] | None:
        value = read_money(self.opening, allow_empty=True)
        return None if value is None else (value, from_qdate(self.opening_date.date()))

    def validate(self) -> None:
        self.build()
        self.opening_balance()


class CardDialog(FormDialog):
    def __init__(self, parent: QWidget | None, ledger: Ledger, card: Card | None = None) -> None:
        super().__init__(parent, "Cartão de crédito", "Salvar cartão")
        self.ledger = ledger
        self.original = card
        self.name = QLineEdit(card.name if card else "")
        self.holder = QComboBox()
        fill_combo(self.holder, [(m.name, m.id) for m in ledger.members.values() if m.active])
        self.last4 = QLineEdit(card.last4 if card else "")
        self.last4.setInputMask("9999")
        self.closing = QSpinBox()
        self.closing.setRange(1, 31)
        self.due = QSpinBox()
        self.due.setRange(1, 31)
        self.settlement = QComboBox()
        fill_combo(self.settlement, liquid_accounts(ledger), empty="(não definida)")
        self.institution = QLineEdit()
        self.form.addRow("Nome:", self.name)
        self.form.addRow("Instituição:", self.institution)
        self.form.addRow("Portador:", self.holder)
        self.form.addRow("Final:", self.last4)
        self.form.addRow("Dia de fechamento:", self.closing)
        self.form.addRow("Dia de vencimento:", self.due)
        self.form.addRow("Conta de pagamento:", self.settlement)
        if card:
            select_combo(self.holder, card.holder_id)
            self.closing.setValue(card.closing_day)
            self.due.setValue(card.due_day)
            select_combo(self.settlement, card.settlement_account_id)

    def validate(self) -> None:
        if not self.name.text().strip():
            raise DomainError("Informe o nome do cartão.")
        if len(self.last4.text().strip()) != 4:
            raise DomainError("Informe os 4 últimos dígitos.")
        if combo_value(self.holder) is None:
            raise DomainError("Cadastre um integrante antes do cartão.")

    def apply(self) -> Card:
        """Creates the card (and its liability account) or updates it."""
        fields = {
            "name": self.name.text().strip(),
            "holder_id": combo_value(self.holder),
            "last4": self.last4.text().strip(),
            "closing_day": self.closing.value(),
            "due_day": self.due.value(),
            "settlement_account_id": combo_value(self.settlement),
        }
        if self.original is not None:
            return self.ledger.update_card(self.original.model_copy(update=fields), "Edição do cadastro")
        liability = self.ledger.add_account(
            LedgerAccount(
                name=fields["name"],
                type=AccountType.LIABILITY,
                subtype=AccountSubtype.CREDIT_CARD,
                institution=self.institution.text().strip() or None,
                masked_number=f"final {fields['last4']}",
                holders=(fields["holder_id"],),
            )
        )
        return self.ledger.add_card(Card(liability_account_id=liability.id, **fields))


class CategoryDialog(FormDialog):
    def __init__(self, parent: QWidget | None, ledger: Ledger) -> None:
        super().__init__(parent, "Categoria", "Criar categoria")
        self.ledger = ledger
        self.name = QLineEdit()
        self.kind = QComboBox()
        fill_combo(self.kind, [("Despesa", AccountType.EXPENSE), ("Receita", AccountType.INCOME)])
        self.parent_cat = QComboBox()
        self.kind.currentIndexChanged.connect(self._reload_parents)
        self.form.addRow("Nome:", self.name)
        self.form.addRow("Tipo:", self.kind)
        self.form.addRow("Dentro de:", self.parent_cat)
        self._reload_parents()

    def _reload_parents(self) -> None:
        fill_combo(self.parent_cat, category_items(self.ledger, combo_value(self.kind)), empty="(nenhuma)")

    def validate(self) -> None:
        if not self.name.text().strip():
            raise DomainError("Informe o nome.")

    def build(self) -> LedgerAccount:
        return LedgerAccount(
            name=self.name.text().strip(),
            type=combo_value(self.kind),
            subtype=AccountSubtype.CATEGORY,
            parent_id=combo_value(self.parent_cat),
        )


class OperationDialog(FormDialog):
    """Manual income, expense, transfer, card purchase and bill payment (RF-10)."""

    KINDS: ClassVar[dict[str, str]] = {
        "income": "Receita",
        "expense": "Despesa",
        "transfer": "Transferência",
        "card_purchase": "Compra no cartão",
        "card_payment": "Pagamento de fatura",
    }

    def __init__(self, parent: QWidget | None, ledger: Ledger, kind: str) -> None:
        super().__init__(parent, self.KINDS[kind], "Registrar")
        self.ledger = ledger
        self.kind = kind
        self.description = QLineEdit()
        self.amount = money_edit()
        self.when = date_edit()
        self.competence = CompetenceCombo()
        self.source = QComboBox()
        self.target = QComboBox()
        self.member = QComboBox()
        fill_combo(self.member, [(m.name, m.id) for m in ledger.members.values() if m.active], empty="(família)")

        self.form.addRow("Descrição:", self.description)
        self.form.addRow("Valor:", self.amount)
        self.form.addRow("Data:", self.when)
        if kind == "income":
            fill_combo(self.source, category_items(ledger, AccountType.INCOME))
            fill_combo(self.target, asset_accounts(ledger))
            self.form.addRow("Categoria:", self.source)
            self.form.addRow("Conta de destino:", self.target)
        elif kind == "expense":
            fill_combo(self.source, asset_accounts(ledger))
            fill_combo(self.target, category_items(ledger, AccountType.EXPENSE))
            self.form.addRow("Conta de origem:", self.source)
            self.form.addRow("Categoria:", self.target)
        elif kind == "transfer":
            fill_combo(self.source, balance_accounts(ledger))
            fill_combo(self.target, balance_accounts(ledger))
            self.form.addRow("De:", self.source)
            self.form.addRow("Para:", self.target)
        elif kind == "card_purchase":
            fill_combo(self.source, [(c.name, c.id) for c in ledger.cards.values()])
            fill_combo(self.target, category_items(ledger, AccountType.EXPENSE))
            self.form.addRow("Cartão:", self.source)
            self.form.addRow("Categoria:", self.target)
            self.installments = QSpinBox()
            self.installments.setRange(1, 72)
            self.policy = QComboBox()
            fill_combo(
                self.policy,
                [
                    ("Despesa inteira no mês da compra", "purchase"),
                    ("Despesa distribuída nas parcelas", "spread"),
                ],
            )
            self.form.addRow("Parcelas:", self.installments)
            self.form.addRow("Competência das parcelas:", self.policy)
        elif kind == "card_payment":
            fill_combo(self.source, [(c.name, c.id) for c in ledger.cards.values()])
            fill_combo(self.target, liquid_accounts(ledger))
            self.form.addRow("Cartão:", self.source)
            self.form.addRow("Pago pela conta:", self.target)
        if kind in ("income", "expense", "card_purchase"):
            self.form.addRow("Competência:", self.competence)
            self.form.addRow("Responsável:", self.member)

    def _competence(self) -> YearMonth | None:
        return self.competence.value()

    def validate(self) -> None:
        if combo_value(self.source) is None or combo_value(self.target) is None:
            raise DomainError("Cadastre as contas, cartões e categorias necessários.")
        value = read_money(self.amount)
        if value is None or value <= 0:
            raise DomainError("Informe um valor positivo.")
        self._competence()

    def apply(self) -> None:
        value = read_money(self.amount)
        on = from_qdate(self.when.date())
        description = self.description.text().strip() or self.KINDS[self.kind]
        extra: dict[str, Any] = {}
        if self.kind in ("income", "expense", "card_purchase"):
            extra = {"accrual_month": self._competence(), "member_id": combo_value(self.member)}
        source, target = combo_value(self.source), combo_value(self.target)
        if self.kind == "income":
            self.ledger.record_income(target, source, value, on, description, **extra)
        elif self.kind == "expense":
            self.ledger.record_expense(source, target, value, on, description, **extra)
        elif self.kind == "transfer":
            self.ledger.record_transfer(source, target, value, on, description)
        elif self.kind == "card_purchase":
            if self.installments.value() > 1:
                from opesvault.domain.cards import CompetencePolicy, record_installment_purchase

                extra.pop("accrual_month", None)  # the policy decides the competence of each part
                record_installment_purchase(
                    self.ledger,
                    source,
                    target,
                    value,
                    on,
                    description,
                    self.installments.value(),
                    CompetencePolicy(combo_value(self.policy)),
                    **extra,
                )
            else:
                self.ledger.record_card_purchase(source, target, value, on, description, **extra)
        elif self.kind == "card_payment":
            self.ledger.record_card_payment(source, target, value, on)


class BillPaymentDialog(FormDialog):
    """Pays one card bill from where it is seen: the remaining amount comes filled in."""

    def __init__(self, parent: QWidget | None, ledger: Ledger, card: Card, bill: Any) -> None:
        from opesvault.domain.money import format_brl
        from opesvault.ui.common import fmt_date
        from opesvault.ui.components import text

        super().__init__(parent, f"Pagar fatura — {card.name}", "Registrar pagamento")
        self.ledger = ledger
        self.card = card
        self.due = bill.cycle.due
        self.amount = money_edit()
        self.amount.setText(format_brl(bill.remaining).replace("R$", "").strip())
        self.when = date_edit()
        self.account = QComboBox()
        self.account.setAccessibleName("Pago pela conta")
        fill_combo(self.account, liquid_accounts(ledger))
        self.late = text("", "caption", wrap=True)
        self.late.setProperty("tone", "warning")
        self.when.dateChanged.connect(lambda _: self._update_note())
        summary = (
            f"Vencimento {fmt_date(bill.cycle.due)} · total {format_brl(bill.total)} · "
            f"pago {format_brl(bill.payments)} · falta {format_brl(bill.remaining)}"
        )
        self.form.addRow("", text(summary, "caption", wrap=True))
        self.form.addRow("Pago pela conta:", self.account)
        self.form.addRow("Valor:", self.amount)
        self.form.addRow("Data do pagamento:", self.when)
        self.form.addRow("", self.late)
        self._update_note()

    def _update_note(self) -> None:
        # Bills count payments made up to their due date (domain.cards.bills); say so before it happens.
        paid_on = from_qdate(self.when.date())
        late = paid_on > self.due
        self.late.setText("Pagamentos depois do vencimento entram na conta da fatura seguinte." if late else "")
        self.late.setVisible(late)

    def validate(self) -> None:
        if combo_value(self.account) is None:
            raise DomainError("Cadastre a conta de onde sai o pagamento.")
        value = read_money(self.amount)
        if value is None or value <= 0:
            raise DomainError("Informe um valor positivo.")

    def apply(self) -> object:
        value = read_money(self.amount)
        return self.ledger.record_card_payment(
            self.card.id, combo_value(self.account), value, from_qdate(self.when.date())
        )


def ask_reason(parent: QWidget, title: str) -> str | None:
    from PySide6.QtWidgets import QInputDialog

    text, ok = QInputDialog.getText(parent, title, "Motivo (fica no histórico):")
    if not ok:
        return None
    if not text.strip():
        QMessageBox.warning(parent, title, "O motivo é obrigatório.")
        return None
    return text.strip()
