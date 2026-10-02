"""Full edit of one operation: dates, competence, member, notes and postings (RF-22).

Every change goes through `Ledger.update_operation`, so validation, closed-month guards
and history with a reason stay in the domain.
"""

from datetime import date
from decimal import Decimal
from typing import Any
from uuid import UUID

from PySide6.QtCore import QDate
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDateEdit,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QPushButton,
    QTableWidget,
    QWidget,
)

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, Operation, Posting, YearMonth
from opesvault.domain.money import ZERO, MoneyError, format_brl, parse_brl
from opesvault.ui.common import combo_value, fill_combo, from_qdate, select_combo, to_qdate
from opesvault.ui.dialogs import FormDialog

TYPE_PREFIX = {
    AccountType.ASSET: "Conta",
    AccountType.LIABILITY: "Dívida",
    AccountType.EQUITY: "Patrimônio",
    AccountType.INCOME: "Receita",
    AccountType.EXPENSE: "Despesa",
}


def account_choices(ledger: Ledger, keep: set[UUID]) -> list[tuple[str, UUID]]:
    """Every postable account, labelled by type; archived ones only when already used."""
    items = []
    for account in ledger.accounts.values():
        if account.archived and account.id not in keep:
            continue
        label = account.name
        parent = ledger.accounts.get(account.parent_id) if account.parent_id else None
        if account.subtype is AccountSubtype.CATEGORY and parent is not None:
            label = f"{parent.name} › {label}"
        items.append((f"{TYPE_PREFIX.get(account.type, account.type.value)}: {label}", account.id))
    return sorted(items, key=lambda t: t[0].casefold())


def parse_side(text: str) -> Decimal | None:
    text = text.strip()
    if not text:
        return None
    try:
        value = parse_brl(text)
    except MoneyError:
        raise DomainError(f"Valor inválido: {text!r}. Use o formato 1.234,56.") from None
    if value <= 0:
        raise DomainError("Débito e crédito são informados como valores positivos.")
    return value


def build_postings(rows: list[tuple[UUID | None, str, str, UUID | None]]) -> tuple[Posting, ...]:
    """Rows are (account, debit text, credit text, member). Exactly one side per row."""
    postings = []
    for account_id, debit_text, credit_text, member_id in rows:
        debit, credit = parse_side(debit_text), parse_side(credit_text)
        if account_id is None and debit is None and credit is None:
            continue
        if account_id is None:
            raise DomainError("Escolha a conta de cada partida.")
        if (debit is None) == (credit is None):
            raise DomainError("Cada partida tem débito ou crédito, não os dois.")
        amount = debit if debit is not None else -credit  # type: ignore[operator]
        postings.append(Posting(account_id=account_id, amount=amount, member_id=member_id))
    if len(postings) < 2:
        raise DomainError("Uma operação precisa de pelo menos duas partidas.")
    return tuple(postings)


def imbalance(rows: list[tuple[UUID | None, str, str, UUID | None]]) -> Decimal | None:
    """Debits minus credits, or None while some value is unreadable."""
    total = ZERO
    for _, debit_text, credit_text, _ in rows:
        try:
            debit, credit = parse_side(debit_text), parse_side(credit_text)
        except DomainError:
            return None
        total += (debit or ZERO) - (credit or ZERO)
    return total


class OptionalDate(QWidget):
    """A date that may stay unknown (docs/04 §5): unchecked means None, never today."""

    def __init__(self, value: date | None) -> None:
        super().__init__()
        self.known = QCheckBox("informada")
        self.edit = QDateEdit()
        self.edit.setCalendarPopup(True)
        self.edit.setDisplayFormat("dd/MM/yyyy")
        self.edit.setDate(to_qdate(value) if value else QDate.currentDate())
        self.known.setChecked(value is not None)
        self.edit.setEnabled(value is not None)
        self.known.toggled.connect(self.edit.setEnabled)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.known)
        layout.addWidget(self.edit, 1)

    def value(self) -> date | None:
        return from_qdate(self.edit.date()) if self.known.isChecked() else None

    def set_value(self, value: date | None) -> None:
        self.known.setChecked(value is not None)
        if value is not None:
            self.edit.setDate(to_qdate(value))


class OperationEditDialog(FormDialog):
    COLUMNS = ("Conta", "Débito", "Crédito", "Integrante")

    def __init__(self, parent: QWidget | None, ledger: Ledger, op: Operation) -> None:
        super().__init__(parent, "Editar lançamento")
        self.ledger = ledger
        self.original = op
        self._accounts = account_choices(ledger, {p.account_id for p in op.postings})
        self._members = [(m.name, m.id) for m in ledger.members.values() if m.active or m.id == op.member_id]
        self.description = QLineEdit(op.description)
        self.occurred = OptionalDate(op.occurred_on)
        self.booked = OptionalDate(op.booked_on)
        self.settled = OptionalDate(op.settled_on)
        self.due = OptionalDate(op.due_on)
        self.competence = QLineEdit(str(op.accrual_month) if op.accrual_month else "")
        self.competence.setPlaceholderText("AAAA-MM (vazio = mês da data)")
        self.member = QComboBox()
        fill_combo(self.member, self._members, empty="(família)")
        select_combo(self.member, op.member_id)
        self.notes = QLineEdit(op.notes or "")
        self.postings = QTableWidget(0, len(self.COLUMNS))
        self.postings.setHorizontalHeaderLabels(list(self.COLUMNS))
        self.postings.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.postings.verticalHeader().setVisible(False)
        self.postings.setMinimumWidth(680)
        for posting in op.postings:
            self.add_row(posting)
        add, remove = QPushButton("Adicionar partida"), QPushButton("Remover partida")
        add.clicked.connect(lambda: self.add_row(None))
        remove.clicked.connect(self.remove_row)
        buttons = QHBoxLayout()
        buttons.addWidget(add)
        buttons.addWidget(remove)
        buttons.addStretch()
        self.balance = QLabel()
        buttons.addWidget(self.balance)
        self.reason = QLineEdit()
        self.reason.setPlaceholderText("obrigatório; fica no histórico")

        self.form.addRow("Descrição:", self.description)
        self.form.addRow("Ocorrência:", self.occurred)
        self.form.addRow("Lançamento:", self.booked)
        self.form.addRow("Liquidação:", self.settled)
        self.form.addRow("Vencimento:", self.due)
        self.form.addRow("Competência:", self.competence)
        self.form.addRow("Responsável:", self.member)
        self.form.addRow("Observações:", self.notes)
        self.form.addRow("Partidas:", self.postings)
        self.form.addRow("", _wrap(buttons))
        self.form.addRow("Motivo da correção:", self.reason)
        self.update_balance()

    # ── postings grid ───────────────────────────────

    def add_row(self, posting: Posting | None) -> None:
        row = self.postings.rowCount()
        self.postings.insertRow(row)
        account = QComboBox()
        fill_combo(account, self._accounts, empty="(escolha)")
        member = QComboBox()
        fill_combo(member, self._members, empty="—")
        debit, credit = QLineEdit(), QLineEdit()
        if posting is not None:
            select_combo(account, posting.account_id)
            select_combo(member, posting.member_id)
            target = debit if posting.amount > 0 else credit
            # Plain digits, no rounding: what is shown is exactly what is stored.
            target.setText(f"{abs(posting.amount):f}".replace(".", ","))
        for edit in (debit, credit):
            edit.textChanged.connect(self.update_balance)
        self.postings.setCellWidget(row, 0, account)
        self.postings.setCellWidget(row, 1, debit)
        self.postings.setCellWidget(row, 2, credit)
        self.postings.setCellWidget(row, 3, member)

    def remove_row(self) -> None:
        row = self.postings.currentRow()
        self.postings.removeRow(row if row >= 0 else self.postings.rowCount() - 1)
        self.update_balance()

    def rows(self) -> list[tuple[UUID | None, str, str, UUID | None]]:
        result = []
        for row in range(self.postings.rowCount()):
            account = self.postings.cellWidget(row, 0)
            debit = self.postings.cellWidget(row, 1)
            credit = self.postings.cellWidget(row, 2)
            member = self.postings.cellWidget(row, 3)
            assert isinstance(account, QComboBox) and isinstance(member, QComboBox)
            assert isinstance(debit, QLineEdit) and isinstance(credit, QLineEdit)
            result.append((combo_value(account), debit.text(), credit.text(), combo_value(member)))
        return result

    def update_balance(self) -> None:
        diff = imbalance(self.rows())
        if diff is None:
            self.balance.setText("Valor ilegível")
        elif diff == 0:
            self.balance.setText("Equilibrada ✓")
        else:
            side = "débitos" if diff > 0 else "créditos"
            self.balance.setText(f"Sobram {format_brl(abs(diff))} em {side}")

    # ── result ──────────────────────────────────────

    def _competence(self) -> YearMonth | None:
        text = self.competence.text().strip()
        if not text:
            return None
        try:
            return YearMonth.parse(text)
        except (ValueError, TypeError):
            raise DomainError("Competência inválida; use AAAA-MM.") from None

    def build(self) -> Operation:
        description = self.description.text().strip()
        if not description:
            raise DomainError("Informe a descrição.")
        update: dict[str, Any] = {
            "description": description,
            "occurred_on": self.occurred.value(),
            "booked_on": self.booked.value(),
            "settled_on": self.settled.value(),
            "due_on": self.due.value(),
            "accrual_month": self._competence(),
            "member_id": combo_value(self.member),
            "notes": self.notes.text().strip() or None,
            "postings": build_postings(self.rows()),
        }
        return self.original.model_copy(update=update)

    def validate(self) -> None:
        if not self.reason.text().strip():
            raise DomainError("O motivo da correção é obrigatório.")
        updated = self.build()
        if updated == self.original:
            raise DomainError("Nada foi alterado.")
        self.ledger.validate_operation(updated)

    def apply(self) -> Operation:
        return self.ledger.update_operation(self.build(), self.reason.text().strip())


def _wrap(layout: QHBoxLayout) -> QWidget:
    widget = QWidget()
    layout.setContentsMargins(0, 0, 0, 0)
    widget.setLayout(layout)
    return widget
