"""Commands of the Imposto de renda page: resolve a pending item, registrations, DARFs, documents.

Each command opens the dialog that fixes one thing and, when it is saved, calls `changed()`
once; a pending item ("Resolver…") leads straight to the dialog that resolves it.
"""

from typing import TYPE_CHECKING, Any
from uuid import UUID

from opesvault.domain.model import YearMonth
from opesvault.tax import checklist, declaration, records, variable_income
from opesvault.tax.model import FilingSubject, NatureSubject, PaymentPurpose, TaxSubject
from opesvault.ui.common import run_guarded, selected_id

if TYPE_CHECKING:
    from PySide6.QtWidgets import QScrollArea, QTableWidget

    from opesvault.tax import issues
    from opesvault.ui.components import Collapsible
    from opesvault.ui.pages.base import Page

    class _Parts(Page):
        """What the commands read from the page: its tables, the year's data and the year."""

        issue_table: QTableWidget
        docs_table: QTableWidget
        taxable: QTableWidget
        other: QTableWidget
        carne: QTableWidget
        payments: QTableWidget
        assets: QTableWidget
        debts: QTableWidget
        variable: QTableWidget
        docs_section: Collapsible
        body_scroll: QScrollArea
        _issues: list[issues.Issue]
        _docs: list[checklist.Expected]
        _income: declaration.Income | None
        _payments: list[declaration.PaymentRow]
        _assets: list[declaration.AssetRow]
        _months: list[variable_income.MonthResult]

        def _year(self) -> int: ...
        def _open_report_id(self, report_id: object) -> None: ...
        def import_report(self, source: object = None) -> None: ...

else:
    _Parts = object


def _at[T](items: list[T], index: object) -> T | None:
    """The row a table key points to, or None when the key is stale."""
    return items[index] if isinstance(index, int) and 0 <= index < len(items) else None


class TaxCommands(_Parts):
    def _run(self, dialog: Any, message: str) -> bool:
        if dialog.exec() and run_guarded(self, lambda: dialog.apply() or True):
            self.notify(message)
            self.changed()
            return True
        return False

    def resolve(self) -> None:
        issue = _at(self._issues, selected_id(self.issue_table))
        if self.session is None or issue is None:
            return
        action, ref = issue.action, issue.ref
        if action == "identity" and isinstance(ref, tuple):
            subject, key = ref
            self._identity(subject, key, issue.title.split(": ", 1)[-1])
        elif action == "member" and isinstance(ref, UUID):
            from opesvault.ui.tax_dialogs import MemberTaxDialog

            self._run(MemberTaxDialog(self, self.session.ledger, ref), "Dados fiscais salvos.")
        elif action == "nature":
            self.edit_natures(ref)
        elif action == "filing":
            row = next((r for r in self._assets if (r.subject, r.ref) == ref), None)
            if row is not None:
                self._filing(row)
        elif action in ("detail", "receipts"):
            self._operations(ref, action)
        elif action == "report":
            self._open_report_id(ref)
        elif action == "checklist":
            self.docs_section.set_expanded(True)
            self.body_scroll.ensureWidgetVisible(self.docs_section)
        elif action == "rules":
            self.edit_rules()
        elif action == "params":
            self.edit_parameters()
        elif action == "payment":
            self._pay(ref)
        elif action == "investments":
            self.navigate("investments")
        elif action == "ledger":
            self.navigate("ledger")

    def _identity(self, subject: TaxSubject, ref: object, label: str) -> None:
        from opesvault.ui.tax_dialogs import TaxIdDialog

        assert self.session is not None
        self._run(TaxIdDialog(self, self.session.ledger, subject, ref, label), "CPF/CNPJ salvo.")

    def edit_people(self) -> None:
        from opesvault.ui.tax_dialogs import PeopleDialog

        if self.session is None:
            return
        if not self.session.ledger.members:
            self.notify("Cadastre os integrantes em Contas e cartões › Integrantes.")
            return
        dialog = PeopleDialog(self, self.session.ledger)
        dialog.exec()
        if dialog.edited:
            self.changed()

    def edit_natures(self, focus: object) -> None:
        from opesvault.ui.tax_dialogs import NatureDialog

        if self.session is not None:
            self._run(NatureDialog(self, self.session.ledger, focus), "Natureza dos rendimentos salva.")  # type: ignore[arg-type]

    def edit_selected_nature(self) -> None:
        row = _at(self._income.other, selected_id(self.other)) if self._income else None
        self.edit_natures((row.subject, row.ref) if row else None)

    def edit_payer(self) -> None:
        if self._income is None:
            return
        taxable = _at(self._income.taxable, selected_id(self.taxable))
        if taxable is not None:
            self._identity(TaxSubject.CATEGORY, taxable.source_id, taxable.payer)
            return
        row = _at(self._income.other, selected_id(self.other))
        if row is not None and row.subject is NatureSubject.CATEGORY:
            self._identity(TaxSubject.CATEGORY, row.ref, row.source)

    def detail_payslips(self) -> None:
        taxable = _at(self._income.taxable, selected_id(self.taxable)) if self._income else None
        if taxable is None:
            self.notify("Escolha uma fonte pagadora.")
            return
        self._operations(tuple(taxable.operations), "detail")

    def _operations(self, operation_ids: object, mode: str) -> None:
        from opesvault.ui.tax_dialogs import OperationsDialog

        if self.session is None or not isinstance(operation_ids, tuple):
            return
        dialog = OperationsDialog(self, self.session, operation_ids, mode)
        dialog.exec()
        if dialog.edited:
            self.changed()

    def _selected_payment(self) -> declaration.PaymentRow | None:
        return _at(self._payments, selected_id(self.payments))

    def edit_payee(self) -> None:
        row = self._selected_payment()
        if row is not None:
            self._identity(TaxSubject.MERCHANT, row.payee_key, row.payee)

    def payment_receipts(self) -> None:
        row = self._selected_payment()
        if row is not None:
            self._operations(tuple(row.operations), "receipts")

    def _selected_asset(self) -> declaration.AssetRow | None:
        return _at(self._assets, selected_id(self.assets))

    def edit_filing(self) -> None:
        row = self._selected_asset()
        if row is not None:
            self._filing(row)

    def _filing(self, row: declaration.AssetRow) -> None:
        from opesvault.ui.tax_dialogs import DeclaredAssetDialog, FilingDialog

        assert self.session is not None
        ledger = self.session.ledger
        if row.subject == "declared":
            self._run(DeclaredAssetDialog(self, ledger, records.declared_assets(ledger)[row.ref]), "Bem salvo.")
            return
        subject = FilingSubject.ACCOUNT if row.subject == "account" else FilingSubject.POSITION
        self._run(FilingDialog(self, ledger, subject, row.ref, row.name, row.group), "Bem classificado.")

    def edit_institution(self) -> None:
        row = self._selected_asset()
        if row is None or row.subject == "declared" or self.session is None:
            return
        ref = row.ref
        if row.subject == "position":
            from opesvault.investments.service import positions

            ref = positions(self.session.ledger)[row.ref].account_id
        self._identity(TaxSubject.ACCOUNT, ref, row.name)

    def edit_lender(self) -> None:
        account_id = selected_id(self.debts)
        if account_id is not None and self.session is not None:
            self._identity(TaxSubject.ACCOUNT, account_id, self.session.ledger.account(account_id).name)

    def new_asset(self) -> None:
        from opesvault.ui.tax_dialogs import DeclaredAssetDialog

        if self.session is not None:
            self._run(DeclaredAssetDialog(self, self.session.ledger), "Bem incluído.")

    def edit_parameters(self) -> None:
        from opesvault.ui.tax_dialogs import ParametersDialog

        if self.session is not None:
            self._run(ParametersDialog(self, self.session.ledger, self._year()), "Tabela do ano salva.")

    def edit_rules(self) -> None:
        from opesvault.ui.tax_dialogs import VariableRulesDialog

        if self.session is not None:
            self._run(VariableRulesDialog(self, self.session.ledger), "Regras de renda variável salvas.")

    def pay_variable(self) -> None:
        row = _at(self._months, selected_id(self.variable))
        month = row.month if row is not None else None
        if month is None:
            due = variable_income.due_by_month(self._months)
            month = next((m for m, (value, paid, _) in due.items() if paid < value), None)
        if month is None:
            self.notify("Escolha o mês na tabela de renda variável.")
            return
        self._pay(("variable_income", month))

    def pay_carne_leao(self) -> None:
        item = _at(self._income.carne_leao, selected_id(self.carne)) if self._income else None
        if item is None:
            self.notify("Escolha o mês do Carnê-Leão.")
            return
        self._pay(("carne_leao", item.month, item.member_id))

    def _pay(self, ref: object) -> None:
        from opesvault.ui.tax_dialogs import PaymentDialog

        if self.session is None or not isinstance(ref, tuple):
            return
        ledger = self.session.ledger
        month: YearMonth = ref[1]
        if ref[0] == "variable_income":
            rows = variable_income.months(ledger, month.year)
            due = variable_income.due_by_month(rows).get(month)
            suggested = (due[0] - due[1]) if due else None
            dialog = PaymentDialog(self, ledger, PaymentPurpose.VARIABLE_INCOME, month, None, suggested)
        else:
            dialog = PaymentDialog(
                self, ledger, PaymentPurpose.CARNE_LEAO, month, ref[2] if len(ref) > 2 else None, None
            )
        self._run(dialog, "Pagamento do DARF registrado.")

    # ── documents checklist ──────────

    def _selected_doc(self) -> checklist.Expected | None:
        return _at(self._docs, selected_id(self.docs_table))

    def open_document_item(self) -> None:
        item = self._selected_doc()
        if item is None or self.session is None:
            return
        if item.action == "receipts":
            self._operations(item.ref, "receipts")
        elif item.action == "report" and isinstance(item.ref, tuple):
            existing = next(
                (
                    r
                    for r in records.reports_of(self.session.ledger, self._year())
                    if (r.source, r.source_id) == item.ref
                ),
                None,
            )
            if existing is not None:
                self._open_report_id(existing.id)
            else:
                self.import_report(item.ref)
        else:
            self.toggle_received()

    def toggle_received(self) -> None:
        item = self._selected_doc()
        if item is None or self.session is None:
            return
        ledger, year = self.session.ledger, self._year()
        records.set_mark(ledger, year, item.key, None if item.by_hand else not item.received)
        self.changed()
