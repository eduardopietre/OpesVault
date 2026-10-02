"""First-use wizard (phase 9): family members, accounts with opening balances and cards.

Every page can be left empty; nothing is written until the last page validates the
whole plan (`domain/onboarding.py`).
"""

from datetime import date

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFormLayout,
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
            "portadores de cartão e rateio de despesas. Todos entram como titulares; dependentes (filhos, "
            "por exemplo) podem ser marcados depois em Contas e cartões › Integrantes."
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
    """One account at a time, in a form like the rest of the app; the ones added are listed below.

    The account being typed counts even without "Adicionar conta": for a family with one bank
    account, filling the form and pressing Avançar is enough.
    """

    def __init__(self, ledger: Ledger) -> None:
        from opesvault.ui.common import summary_table
        from opesvault.ui.components import button, text

        super().__init__()
        self.ledger = ledger
        self.setTitle("Contas")
        self.setSubTitle(
            "Contas correntes, poupança, dinheiro, corretoras e dívidas. O saldo de abertura é opcional: "
            "vazio significa não informado, não zero. Cartões de crédito vêm na próxima etapa."
        )
        self.planned: list[AccountPlan] = []
        self.name = QLineEdit()
        self.name.setAccessibleName("Nome da conta")
        self.name.setPlaceholderText("ex.: Conta corrente Banco A")
        self.subtype = QComboBox()
        fill_combo(self.subtype, [(SUBTYPE_LABELS[s], s) for s in (*ASSET_SUBTYPES, *LIABILITY_SUBTYPES)])
        self.holders_host = QWidget()
        self.holders_layout = QHBoxLayout(self.holders_host)
        self.holders_layout.setContentsMargins(0, 0, 0, 0)
        self.holders: list[QCheckBox] = []
        self.institution = QLineEdit()
        self.institution.setPlaceholderText("opcional")
        self.balance = money_edit("opcional")
        self.when = date_edit(date.today())
        self.error = text("", wrap=True)
        self.error.setProperty("tone", "negative")
        self.error.hide()
        form = QFormLayout()
        form.setLabelAlignment(Qt.AlignmentFlag.AlignRight)
        form.addRow("Nome:", self.name)
        form.addRow("Tipo:", self.subtype)
        form.addRow("Titulares:", self.holders_host)
        form.addRow("Instituição:", self.institution)
        form.addRow("Saldo de abertura:", self.balance)
        form.addRow("Data do saldo:", self.when)
        self.add_button = button("Adicionar conta", self.add_current, tip="Guarda esta conta e limpa o formulário")
        self.table = summary_table(["Conta", "Tipo", "Titulares", "Saldo de abertura"], max_rows=5)
        self.remove_button = button("Remover da lista", self.remove_selected, role="plain")
        self.added = text("Contas adicionadas", "headline")
        layout = QVBoxLayout(self)
        layout.addLayout(form)
        layout.addWidget(self.error)
        layout.addLayout(_buttons(self.add_button))
        layout.addSpacing(12)
        layout.addWidget(self.added)
        layout.addWidget(self.table)
        layout.addLayout(_buttons(self.remove_button))
        layout.addStretch(1)
        self._show_list()

    def initializePage(self) -> None:  # noqa: N802 - Qt override
        """Holders are the members known so far, including those typed on the previous page."""
        checked = {box.text() for box in self.holders if box.isChecked()}
        for box in self.holders:
            box.deleteLater()
        self.holders = []
        wizard = self.wizard()
        planned = wizard.members_page.members() if isinstance(wizard, SetupWizard) else []
        people = [m.name for m in self.ledger.members.values() if m.active] + planned
        for person in people:
            box = QCheckBox(person)
            box.setChecked(person in checked or len(people) == 1)
            self.holders_layout.addWidget(box)
            self.holders.append(box)
        self.holders_layout.addStretch(1)

    def _current(self) -> AccountPlan | None:
        """The account in the form, or None while it has no name."""
        name = self.name.text().strip()
        if not name:
            return None
        value = read_money(self.balance, allow_empty=True)
        return AccountPlan(
            name=name,
            subtype=self.subtype.currentData(),
            holders=tuple(box.text() for box in self.holders if box.isChecked()),
            institution=self.institution.text().strip() or None,
            opening_balance=value,
            opening_date=from_qdate(self.when.date()) if value is not None else None,
        )

    def add_current(self) -> bool:
        try:
            plan = self._current()
        except DomainError as exc:
            self._show_error(str(exc))
            return False
        if plan is None:
            self._show_error("Informe o nome da conta.")
            return False
        if plan.name.casefold() in {a.name.casefold() for a in self.planned}:
            self._show_error(f"A conta {plan.name} já está na lista.")
            return False
        self.planned.append(plan)
        self._show_error("")
        for edit in (self.name, self.institution, self.balance):
            edit.clear()
        self._show_list()
        self.name.setFocus()
        return True

    def remove_selected(self) -> None:
        row = self.table.currentRow()
        if 0 <= row < len(self.planned):
            del self.planned[row]
            self._show_list()

    def _show_error(self, message: str) -> None:
        self.error.setText(message)
        self.error.setVisible(bool(message))

    def _show_list(self) -> None:
        from opesvault.ui.common import fit_to_rows, fmt, set_rows

        set_rows(
            self.table,
            [
                (
                    [a.name, SUBTYPE_LABELS[a.subtype], ", ".join(a.holders) or "—", fmt(a.opening_balance)],
                    index,
                )
                for index, a in enumerate(self.planned)
            ],
        )
        fit_to_rows(self.table)
        for widget in (self.added, self.table, self.remove_button):
            widget.setVisible(bool(self.planned))

    def validatePage(self) -> bool:  # noqa: N802 - Qt override
        # The account still in the form is added on Avançar, so one account needs no extra click.
        return not self.name.text().strip() or self.add_current()

    def accounts(self) -> list[AccountPlan]:
        """Accounts added so far, plus the one in the form when it has a name."""
        current = self._current()
        return [*self.planned, *([current] if current is not None else [])]


def _buttons(*widgets: QWidget) -> QHBoxLayout:
    row = QHBoxLayout()
    for widget in widgets:
        row.addWidget(widget)
    row.addStretch()
    return row


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
        try:
            planned = (
                [a.name for a in wizard.accounts_page.accounts() if a.subtype in ASSET_SUBTYPES]
                if isinstance(wizard, SetupWizard)
                else []
            )
        except DomainError:  # an unreadable balance in the form: Contas reports it
            planned = []
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
        self.accounts_page = AccountsPage(ledger)
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
