"""First-use wizard (phase 9): family members, accounts with opening balances and cards.

Every page can be left empty; nothing is written until the last page validates the
whole plan (`domain/onboarding.py`).
"""

from datetime import date

from PySide6.QtWidgets import (
    QComboBox,
    QDateEdit,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QSpinBox,
    QTableWidget,
    QVBoxLayout,
    QWidget,
    QWizard,
    QWizardPage,
)

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.onboarding import AccountPlan, CardPlan, SetupPlan, check_plan
from opesvault.ui.common import date_edit, fill_combo, from_qdate, money_edit, read_money
from opesvault.ui.dialogs import ASSET_SUBTYPES, LIABILITY_SUBTYPES, SUBTYPE_LABELS


def _table(headers: tuple[str, ...]) -> QTableWidget:
    table = QTableWidget(0, len(headers))
    table.setHorizontalHeaderLabels(list(headers))
    table.verticalHeader().setVisible(False)
    table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
    return table


def _row_buttons(table: QTableWidget, add: object) -> QHBoxLayout:
    row = QHBoxLayout()
    add_button, remove_button = QPushButton("Adicionar"), QPushButton("Remover")
    add_button.clicked.connect(add)  # type: ignore[arg-type]
    remove_button.clicked.connect(
        lambda: table.removeRow(table.currentRow() if table.currentRow() >= 0 else table.rowCount() - 1)
    )
    row.addWidget(add_button)
    row.addWidget(remove_button)
    row.addStretch()
    return row


class MembersPage(QWizardPage):
    def __init__(self, ledger: Ledger) -> None:
        super().__init__()
        self.setTitle("Integrantes")
        self.setSubTitle(
            "Quem participa das finanças? Um nome por linha. Integrantes servem para titularidade, "
            "portadores de cartão e rateio de despesas."
        )
        self.names = QPlainTextEdit()
        existing = [m.name for m in ledger.members.values()]
        if existing:
            self.names.setPlaceholderText("Já cadastrados: " + ", ".join(existing))
        layout = QVBoxLayout(self)
        layout.addWidget(self.names)

    def members(self) -> list[str]:
        return [line.strip() for line in self.names.toPlainText().splitlines() if line.strip()]


class AccountsPage(QWizardPage):
    HEADERS = ("Nome", "Tipo", "Titulares (separados por vírgula)", "Instituição", "Saldo de abertura", "Data do saldo")

    def __init__(self) -> None:
        super().__init__()
        self.setTitle("Contas")
        self.setSubTitle(
            "Contas correntes, poupança, dinheiro, corretoras e dívidas. O saldo de abertura é opcional: "
            "vazio significa não informado, não zero. Cartões de crédito vêm na próxima etapa."
        )
        self.table = _table(self.HEADERS)
        layout = QVBoxLayout(self)
        layout.addWidget(self.table)
        layout.addLayout(_row_buttons(self.table, self.add_row))

    def add_row(self) -> int:
        row = self.table.rowCount()
        self.table.insertRow(row)
        subtype = QComboBox()
        fill_combo(subtype, [(SUBTYPE_LABELS[s], s) for s in (*ASSET_SUBTYPES, *LIABILITY_SUBTYPES)])
        self.table.setCellWidget(row, 0, QLineEdit())
        self.table.setCellWidget(row, 1, subtype)
        self.table.setCellWidget(row, 2, QLineEdit())
        self.table.setCellWidget(row, 3, QLineEdit())
        self.table.setCellWidget(row, 4, money_edit("opcional"))
        self.table.setCellWidget(row, 5, date_edit(date.today()))
        return row

    def accounts(self) -> list[AccountPlan]:
        result = []
        for row in range(self.table.rowCount()):
            name, subtype, holders, institution, balance, when = (
                self.table.cellWidget(row, c) for c in range(len(self.HEADERS))
            )
            assert isinstance(name, QLineEdit) and isinstance(subtype, QComboBox)
            assert isinstance(holders, QLineEdit) and isinstance(institution, QLineEdit)
            assert isinstance(balance, QLineEdit) and isinstance(when, QDateEdit)
            if not name.text().strip():
                continue
            value = read_money(balance, allow_empty=True)
            result.append(
                AccountPlan(
                    name=name.text().strip(),
                    subtype=subtype.currentData(),
                    holders=tuple(h.strip() for h in holders.text().split(",") if h.strip()),
                    institution=institution.text().strip() or None,
                    opening_balance=value,
                    opening_date=from_qdate(when.date()) if value is not None else None,
                )
            )
        return result


class CardsPage(QWizardPage):
    HEADERS = ("Nome", "Portador", "Final", "Fechamento", "Vencimento", "Conta de pagamento")

    def __init__(self, ledger: Ledger) -> None:
        super().__init__()
        self.ledger = ledger
        self.setTitle("Cartões de crédito")
        self.setSubTitle("Fechamento e vencimento definem as faturas. Adicionais podem ser cadastrados depois.")
        self.table = _table(self.HEADERS)
        layout = QVBoxLayout(self)
        layout.addWidget(self.table)
        layout.addLayout(_row_buttons(self.table, self.add_row))

    def _people(self) -> list[str]:
        wizard = self.wizard()
        planned = wizard.members_page.members() if isinstance(wizard, SetupWizard) else []
        return [m.name for m in self.ledger.members.values() if m.active] + planned

    def _payers(self) -> list[str]:
        wizard = self.wizard()
        planned = (
            [a.name for a in wizard.accounts_page.accounts() if a.subtype in ASSET_SUBTYPES]
            if isinstance(wizard, SetupWizard)
            else []
        )
        return [a.name for a in self.ledger.accounts.values() if a.is_liquid] + planned

    def initializePage(self) -> None:  # noqa: N802 - Qt override
        # Members and accounts may have changed on the previous pages.
        for row in range(self.table.rowCount()):
            self._fill(row)

    def _fill(self, row: int) -> None:
        for column, items, empty in ((1, self._people(), None), (5, self._payers(), "(não definida)")):
            combo = self.table.cellWidget(row, column)
            assert isinstance(combo, QComboBox)
            current = combo.currentText()
            fill_combo(combo, [(n, n) for n in items], empty=empty)
            if current:
                combo.setCurrentText(current)

    def add_row(self) -> int:
        row = self.table.rowCount()
        self.table.insertRow(row)
        last4 = QLineEdit()
        last4.setInputMask("9999")
        closing, due = QSpinBox(), QSpinBox()
        closing.setRange(1, 31)
        due.setRange(1, 31)
        closing.setValue(1)
        due.setValue(10)
        self.table.setCellWidget(row, 0, QLineEdit())
        self.table.setCellWidget(row, 1, QComboBox())
        self.table.setCellWidget(row, 2, last4)
        self.table.setCellWidget(row, 3, closing)
        self.table.setCellWidget(row, 4, due)
        self.table.setCellWidget(row, 5, QComboBox())
        self._fill(row)
        return row

    def cards(self) -> list[CardPlan]:
        result = []
        for row in range(self.table.rowCount()):
            name, holder, last4, closing, due, payer = (self.table.cellWidget(row, c) for c in range(6))
            assert isinstance(name, QLineEdit) and isinstance(holder, QComboBox) and isinstance(last4, QLineEdit)
            assert isinstance(closing, QSpinBox) and isinstance(due, QSpinBox) and isinstance(payer, QComboBox)
            if not name.text().strip():
                continue
            result.append(
                CardPlan(
                    name=name.text().strip(),
                    holder=holder.currentData() or "",
                    last4=last4.text().strip(),
                    closing_day=closing.value(),
                    due_day=due.value(),
                    settlement_account=payer.currentData(),
                )
            )
        return result


class FinishPage(QWizardPage):
    def __init__(self) -> None:
        super().__init__()
        self.setTitle("Pronto para começar")
        self.summary = QLabel()
        self.summary.setWordWrap(True)
        tips = QLabel(
            "Próximos passos:\n"
            "• Importe faturas e extratos em “Importar e revisar” (PDF, CSV ou OFX).\n"
            "• Salve com Ctrl+S: a senha é pedida a cada salvamento e nunca fica guardada.\n"
            "• Escolha uma pasta de backup em Configurações.\n"
            "• Pressione F1 em qualquer tela para ver a ajuda."
        )
        tips.setWordWrap(True)
        layout = QVBoxLayout(self)
        layout.addWidget(self.summary)
        layout.addWidget(tips)
        layout.addStretch()

    def initializePage(self) -> None:  # noqa: N802 - Qt override
        wizard = self.wizard()
        if not isinstance(wizard, SetupWizard):
            return
        try:
            plan = wizard.plan()
        except DomainError as exc:
            self.summary.setText(f"Revise as etapas anteriores: {exc}")
            return
        self.summary.setText(
            f"Serão criados {len(plan.members)} integrante(s), {len(plan.accounts)} conta(s) "
            f"e {len(plan.cards)} cartão(ões). Tudo pode ser alterado depois em “Contas e cartões”."
        )

    def validatePage(self) -> bool:  # noqa: N802 - Qt override
        wizard = self.wizard()
        if not isinstance(wizard, SetupWizard):
            return True
        try:
            check_plan(wizard.ledger, wizard.plan())
        except DomainError as exc:
            QMessageBox.warning(self, "Assistente", str(exc))
            return False
        return True


class SetupWizard(QWizard):
    def __init__(self, parent: QWidget | None, ledger: Ledger) -> None:
        super().__init__(parent)
        self.ledger = ledger
        self.setWindowTitle("Configuração inicial")
        self.setWizardStyle(QWizard.WizardStyle.ClassicStyle)
        self.members_page = MembersPage(ledger)
        self.accounts_page = AccountsPage()
        self.cards_page = CardsPage(ledger)
        self.finish_page = FinishPage()
        for page in (self.members_page, self.accounts_page, self.cards_page, self.finish_page):
            self.addPage(page)
        self.setButtonText(QWizard.WizardButton.FinishButton, "Concluir")
        self.setButtonText(QWizard.WizardButton.NextButton, "Avançar >")
        self.setButtonText(QWizard.WizardButton.BackButton, "< Voltar")
        self.setButtonText(QWizard.WizardButton.CancelButton, "Pular")
        self.resize(900, 520)

    def plan(self) -> SetupPlan:
        return SetupPlan(
            members=tuple(self.members_page.members()),
            accounts=tuple(self.accounts_page.accounts()),
            cards=tuple(self.cards_page.cards()),
        )
