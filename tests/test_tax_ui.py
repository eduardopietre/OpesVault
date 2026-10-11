"""Imposto de renda page (docs/09 §1.3 F): sheets on screen, issues that lead to the fix, the informe
import off the UI thread, and nothing left on screen when the vault closes (TA-31)."""

from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from PySide6.QtCore import QDate
from PySide6.QtWidgets import QApplication, QDialog, QFileDialog, QLabel, QTableWidget

from opesvault.domain.deductibles import DeductibleKind, mark
from opesvault.session import Session
from opesvault.tax import records
from opesvault.tax.model import IncomeNature, NatureSubject, ReportField, TaxSubject
from opesvault.ui import theme
from opesvault.ui.main_window import MainWindow

from . import synthetic_docs as docs
from .domain_fixtures import Family, category, family

Y = 2025


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    app = instance if isinstance(instance, QApplication) else QApplication([])
    theme.apply_theme(app, dark=False)
    return app


@pytest.fixture
def setup(app: QApplication, tmp_path: Path) -> tuple[MainWindow, Family]:
    win = MainWindow()
    f = family()
    session = Session.new(tmp_path / "x.opesvault", "Teste")
    session.ledger = f.ledger
    ledger = f.ledger
    ledger.record_opening_balance(f.bank, "1000.00", date(Y - 1, 1, 2))
    records.classify(ledger, NatureSubject.CATEGORY, f.salary, IncomeNature.TAXABLE_PJ)
    ledger.record_income(f.bank, f.salary, "1400.00", date(Y, 6, 1), "Salário", member_id=f.ana)
    health = category(ledger, "Saúde")
    mark(ledger, health, DeductibleKind.HEALTH)
    ledger.record_expense(f.bank, health, "300.00", date(Y, 5, 2), "CLINICA BOA SAUDE", member_id=f.ana)
    win.session = session
    win._refresh()
    return win, f


def _page(window: MainWindow) -> Any:
    page = next(p for p in window.pages if type(p).__name__ == "TaxPage")
    window.show_page(window.pages.index(page))
    QApplication.processEvents()
    return page


def _row_of(table: QTableWidget, column: int, text: str) -> int:
    for row in range(table.rowCount()):
        item = table.item(row, column)
        if item is not None and text in item.text():
            return row
    raise AssertionError(text)


def test_page_shows_the_sheets_of_the_year(setup: tuple[MainWindow, Family]) -> None:
    window, _f = setup
    page = _page(window)
    assert page._year() == Y
    assert page.taxable.rowCount() == 1 and page.payments.rowCount() == 1
    assert page.figures.values["Rendimentos tributáveis"].text() == "R$ 1.400,00"
    titles = [page.issue_table.item(r, 1).text() for r in range(page.issue_table.rowCount())]
    assert any(t.startswith("CNPJ da fonte pagadora") for t in titles)
    assert any(t.startswith("CPF/CNPJ de quem recebeu") for t in titles)


def test_issue_leads_to_the_fix(setup: tuple[MainWindow, Family], monkeypatch: pytest.MonkeyPatch) -> None:
    from opesvault.ui import tax_dialogs

    window, f = setup
    page = _page(window)
    row = _row_of(page.issue_table, 1, "CNPJ da fonte pagadora")
    page.issue_table.selectRow(row)

    def fill(self: Any) -> int:
        self.number.setText("11.222.333/0001-81")
        return 1

    monkeypatch.setattr(tax_dialogs.TaxIdDialog, "exec", fill)
    page.resolve()
    found = records.identity(f.ledger, TaxSubject.CATEGORY, f.salary)
    assert found is not None and found.tax_id == "11222333000181"
    assert page.taxable.item(0, 1).text() == "11.222.333/0001-81"
    window.undo()  # a tax record is undone like any other edit
    assert records.identity(f.ledger, TaxSubject.CATEGORY, f.salary) is None


def test_informe_import_runs_in_background_and_is_compared(
    setup: tuple[MainWindow, Family], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from opesvault.ui import tax_dialogs

    window, f = setup
    page = _page(window)
    pdf = tmp_path / "informe.pdf"
    pdf.write_bytes(docs.bank_income_report_pdf(Y))
    monkeypatch.setattr(QFileDialog, "getOpenFileName", lambda *a, **k: (str(pdf), ""))
    seen: dict[str, Any] = {}

    def accept(self: Any) -> int:
        from opesvault.tax.model import ReportSource
        from opesvault.ui.common import select_combo

        select_combo(self.source, (ReportSource.ACCOUNT, f.bank))
        seen["lines"] = len(self.lines())
        return 1

    monkeypatch.setattr(tax_dialogs.ReportDialog, "exec", accept)
    page.import_report()
    for _ in range(200):
        QApplication.processEvents()
        if page._job is None:
            break
        import time

        time.sleep(0.01)
    assert seen["lines"] >= 4
    [report] = records.reports_of(f.ledger, Y)
    assert report.document_id is not None and window.session is not None
    assert window.session.document(report.document_id).meta.original_name == "informe.pdf"
    assert any(line.field is ReportField.BALANCE_END for line in report.lines)
    assert page.reports.rowCount() == 1 and "diferença" in page.reports.item(0, 3).text()


def test_closing_the_vault_clears_every_table(setup: tuple[MainWindow, Family]) -> None:
    window, _f = setup
    page = _page(window)
    assert page.taxable.rowCount()
    page.set_session(None)
    for table in page.findChildren(QTableWidget):
        assert table.rowCount() == 0, table.accessibleName()


def test_ledger_action_details_a_salary(setup: tuple[MainWindow, Family], monkeypatch: pytest.MonkeyPatch) -> None:
    from opesvault.ui import tax_dialogs

    window, f = setup
    op = next(o for o in f.ledger.active_operations() if o.description == "Salário")

    def fill(self: Any) -> int:
        self.gross.setText("1.800,00")
        self.withheld.setText("100,00")
        self.social.setText("200,00")
        return 1

    monkeypatch.setattr(tax_dialogs.IncomeDetailDialog, "exec", fill)
    ledger_page: Any = next(p for p in window.pages if type(p).__name__ == "LedgerPage")
    monkeypatch.setattr(ledger_page, "_selected", lambda: op)
    ledger_page.detail_income()
    detail = records.detail_of(f.ledger, op.id)
    assert detail is not None and detail.gross == Decimal("1800.00") and detail.social_security == Decimal("200.00")


# ── every command of the page, driven as a person does ──────────
#
# Modal dialogs never show: `FormDialog.exec` is replaced by a stand-in that records the dialog,
# lets the test type into it and then confirms it through `_try_accept` (the dialog's own
# validation), as the confirm button does. A dialog without a filler is cancelled.


class Dialogs:
    """The dialogs the commands opened, and what to type in each before confirming."""

    def __init__(self) -> None:
        self.opened: list[Any] = []
        self.fillers: dict[str, Any] = {}

    def fill(self, name: str, filler: Any) -> None:
        self.fillers[name] = filler

    def last(self, name: str) -> Any:
        return next(d for d in reversed(self.opened) if type(d).__name__ == name)

    def names(self) -> list[str]:
        return [type(d).__name__ for d in self.opened]


@pytest.fixture
def dialogs(monkeypatch: pytest.MonkeyPatch) -> Dialogs:
    from opesvault.ui.dialogs import FormDialog

    seen = Dialogs()

    def exec_(self: Any) -> int:
        seen.opened.append(self)
        filler = seen.fillers.get(type(self).__name__)
        if filler is None or filler(self) is False:
            return 0  # cancelled, or a list dialog closed with "Fechar"
        self._try_accept()
        return int(self.result() == QDialog.DialogCode.Accepted)

    monkeypatch.setattr(FormDialog, "exec", exec_)
    return seen


@pytest.fixture
def warnings(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """What `run_guarded` would show in a message box."""
    from PySide6.QtWidgets import QMessageBox

    shown: list[str] = []
    monkeypatch.setattr(QMessageBox, "warning", lambda _parent, _title, message: shown.append(message))
    return shown


class Rich:
    """A year with something on every sheet, so each pending item and command has a target."""

    def __init__(self, window: MainWindow, f: Family, page: Any, ids: dict[str, Any]) -> None:
        self.window, self.f, self.page, self.ids = window, f, page, ids
        self.ledger = f.ledger
        self.messages: list[str] = []
        self.went: list[tuple[str, object, bool]] = []
        page.set_notify_hook(self.messages.append)
        page.set_navigate_hook(lambda target, ref=None, *, act=False: self.went.append((target, ref, act)))

    @property
    def steps(self) -> int:
        """Undo steps so far; each user action that changed something must add exactly one."""
        assert self.window.session is not None
        stack = self.window.session.undo_stack()
        assert not stack.journal, "an edit was left outside an undo step"
        return len(stack.undo_steps)

    def select(self, table: QTableWidget, column: int, text: str) -> None:
        table.setCurrentCell(_row_of(table, column, text), 0)


@pytest.fixture
def rich(app: QApplication, tmp_path: Path) -> Rich:
    from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount
    from opesvault.investments import service as inv
    from opesvault.investments import trades
    from opesvault.investments.model import AssetClass, TrackingMode
    from opesvault.tax.model import DeclaredAsset, ReportLine, ReportSource

    f = family()
    ledger = f.ledger

    def income_category(name: str, nature: IncomeNature | None) -> UUID:
        found = ledger.add_account(
            LedgerAccount(name=name, type=AccountType.INCOME, subtype=AccountSubtype.CATEGORY)
        ).id
        if nature is not None:
            records.classify(ledger, NatureSubject.CATEGORY, found, nature)
        return found

    ledger.record_opening_balance(f.bank, "100000.00", date(Y - 1, 12, 1))
    records.classify(ledger, NatureSubject.CATEGORY, f.salary, IncomeNature.TAXABLE_PJ)
    ledger.record_income(f.bank, f.salary, "1400.00", date(Y, 6, 1), "Salário", member_id=f.ana)
    health = category(ledger, "Saúde")
    mark(ledger, health, DeductibleKind.HEALTH)
    ledger.record_expense(f.bank, health, "300.00", date(Y, 5, 2), "CLINICA BOA SAUDE", member_id=f.ana)
    rent = income_category("Aluguel recebido", IncomeNature.CARNE_LEAO)
    ledger.record_income(f.bank, rent, "1500.00", date(Y, 8, 1), "Aluguel", member_id=f.ana)
    dividends = income_category("Dividendos", IncomeNature.EXEMPT)
    ledger.record_income(f.bank, dividends, "200.00", date(Y, 7, 1), "Dividendos", member_id=f.ana)
    odd = income_category("Bicos", None)  # a nature still to be chosen
    ledger.record_income(f.bank, odd, "100.00", date(Y, 9, 1), "Bico", member_id=f.ana)
    ledger.record_income(f.joint, odd, "50.00", date(Y, 9, 2), "Bico sem integrante")  # two holders: nobody
    cdb = inv.create_position(
        ledger,
        "CDB X",
        AssetClass.FIXED_INCOME,
        date(Y, 2, 1),
        initial_cost="5000",
        from_account=f.bank,
        holder_id=f.ana,
    )
    inv.create_position(  # tracked from a reference value: its cost is unknown
        ledger, "Fundo antigo", AssetClass.FIXED_INCOME, date(Y, 2, 1), reference_value="1000", holder_id=f.ana
    )
    stock = inv.create_position(
        ledger, "PETR4", AssetClass.STOCK, date(Y, 1, 2), mode=TrackingMode.QUANTITY, holder_id=f.ana
    )
    trades.buy(ledger, stock.id, date(Y, 1, 2), "1000", "20.00", f.bank)
    trades.sell(ledger, stock.id, date(Y, 3, 10), "100", "15.00", f.bank)  # a loss carried forward
    trades.sell(ledger, stock.id, date(Y, 4, 10), "500", "70.00", f.bank)  # a gain with no rate informed
    trades.buy(ledger, stock.id, date(Y, 5, 5), "100", "10.00", f.bank)
    trades.sell(ledger, stock.id, date(Y, 5, 5), "100", "12.00", f.bank)  # day trade
    car = records.save_declared_asset(
        ledger,
        DeclaredAsset(
            name="Carro", group="02", code="01", owner_id=f.ana, acquired_on=date(Y, 3, 1), cost=Decimal("60000.00")
        ),
    )
    loan = ledger.add_account(
        LedgerAccount(name="Financiamento", type=AccountType.LIABILITY, subtype=AccountSubtype.LOAN, holders=(f.ana,))
    ).id
    ledger.record_opening_balance(loan, "-20000.00", date(Y, 3, 1))
    records.set_member_info(ledger, f.bruno, cpf=None, birth_date=None, declared_by=f.ana)
    records.save_report(
        ledger, Y, ReportSource.ACCOUNT, f.bank, [ReportLine(field=ReportField.BALANCE_END, amount=Decimal("1"))]
    )

    window = MainWindow()
    session = Session.new(tmp_path / "x.opesvault", "Teste")
    session.ledger = ledger
    window.session = session
    window._refresh()
    ids = {"rent": rent, "dividends": dividends, "odd": odd, "cdb": cdb.id, "car": car.id, "loan": loan}
    out = Rich(window, f, _page(window), ids)
    assert out.steps == 0  # what the fixture built is not an undoable action
    return out


def _choose_declarant(rich: Rich, member: UUID) -> None:
    from opesvault.ui.common import select_combo

    select_combo(rich.page.declarant, member)
    QApplication.processEvents()


def test_every_pending_item_opens_what_resolves_it(rich: Rich, dialogs: Dialogs) -> None:
    from opesvault.tax.model import FilingSubject

    page = rich.page
    _choose_declarant(rich, rich.f.ana)  # members without CPF are pending only for a declarant
    actions: set[str] = set()
    for index, issue in enumerate(list(page._issues)):
        page.issue_table.setCurrentCell(index, 0)
        before = len(dialogs.opened)
        page.resolve()
        actions.add(issue.action)
        opened = dialogs.opened[before:]
        if issue.action in ("checklist", "investments", "ledger"):
            assert not opened
            if issue.action == "checklist":
                assert page.docs_section.expanded
            else:
                assert rich.went[-1] == (issue.action, None, False)
            continue
        [dialog] = opened
        name = type(dialog).__name__
        if issue.action == "identity":
            assert name == "TaxIdDialog" and (dialog.subject, dialog.ref) == issue.ref
            assert dialog.name.text() == issue.title.split(": ", 1)[1]  # the name in the title is suggested
        elif issue.action == "member":
            assert name == "MemberTaxDialog" and dialog.member_id == issue.ref
        elif issue.action == "nature":
            assert name == "NatureDialog"
            assert dialog.combos[dialog.table.currentRow()][:2] == issue.ref  # the line comes selected
        elif issue.action == "filing":
            subject, ref = issue.ref
            assert name == "FilingDialog" and dialog.ref == ref
            assert dialog.subject is (FilingSubject.ACCOUNT if subject == "account" else FilingSubject.POSITION)
        elif issue.action in ("detail", "receipts"):
            assert name == "OperationsDialog" and dialog.mode == issue.action and dialog.ids == issue.ref
            assert dialog.table.rowCount() == len(issue.ref)
        elif issue.action == "report":
            assert name == "ReportDialog" and dialog.report_id == issue.ref
        elif issue.action == "rules":
            assert name == "VariableRulesDialog"
        elif issue.action == "params":
            assert name == "ParametersDialog" and dialog.year == Y
        else:
            assert issue.action == "payment" and name == "PaymentDialog" and dialog.month == issue.ref[1]
    assert actions == {
        "identity",
        "member",
        "nature",
        "filing",
        "detail",
        "receipts",
        "report",
        "checklist",
        "rules",
        "params",
        "payment",
        "investments",
        "ledger",
    }
    assert rich.steps == 0 and not rich.messages  # every dialog was cancelled: nothing changed


def test_without_a_selection_or_a_vault_nothing_opens(rich: Rich, dialogs: Dialogs) -> None:
    page = rich.page
    page.issue_table.setCurrentCell(-1, -1)
    page.resolve()
    page.set_session(None)
    for command in (
        page.resolve,
        page.edit_people,
        lambda: page.edit_natures(None),
        page.edit_selected_nature,
        page.edit_payer,
        page.new_asset,
        page.edit_parameters,
        page.edit_rules,
        page.new_report,
        page.export_pdf,
        page.import_report,
        page.open_document_item,
        page.toggle_received,
        lambda: page._open_report_id(None),
        lambda: page._operations((), "detail"),
        page._show_checks,
    ):
        command()
    assert dialogs.opened == [] and page.checks.rowCount() == 0


def test_a_member_resolved_is_one_undo_step(rich: Rich, dialogs: Dialogs) -> None:
    page, f = rich.page, rich.f
    _choose_declarant(rich, f.ana)
    rich.select(page.issue_table, 1, "CPF: Ana")
    dialogs.fill("MemberTaxDialog", lambda d: d.cpf.setText("529.982.247-25"))
    page.resolve()
    info = records.member_info(rich.ledger, f.ana)
    assert info is not None and info.cpf == "52998224725"
    assert rich.messages == ["Dados fiscais salvos."] and rich.steps == 1
    assert not any(i.title == "CPF: Ana" for i in page._issues)  # the page refreshed


def test_a_save_the_domain_refuses_changes_nothing(
    rich: Rich, dialogs: Dialogs, warnings: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.domain.ledger import DomainError
    from opesvault.ui import tax_dialogs

    def refuse(_self: Any) -> None:
        raise DomainError("Recusado pelo domínio.")

    monkeypatch.setattr(tax_dialogs.TaxIdDialog, "apply", refuse)
    dialogs.fill("TaxIdDialog", lambda d: d.number.setText("11.222.333/0001-81"))
    rich.select(rich.page.issue_table, 1, "CNPJ da fonte pagadora")
    rich.page.resolve()
    assert warnings == ["Recusado pelo domínio."]
    assert rich.messages == [] and rich.steps == 0


def test_people_are_edited_one_at_a_time(rich: Rich, dialogs: Dialogs) -> None:
    page, f = rich.page, rich.f

    def people(dialog: Any) -> bool:
        row = _row_of(dialog.table, 0, "Bruno")
        assert dialog.table.item(row, 3).text() == "Dependente de Ana"
        assert dialog.table.item(_row_of(dialog.table, 0, "Ana"), 2).text() == "—"
        dialog.table.setCurrentCell(-1, -1)
        dialog.edit()  # nothing selected
        dialog.table.setCurrentCell(row, 0)
        dialog.edit()
        assert dialog.edited
        assert dialog.table.item(_row_of(dialog.table, 0, "Bruno"), 1).text() == "529.982.247-25"
        return False  # "Fechar"

    def member(dialog: Any) -> None:
        dialog.cpf.setText("529.982.247-25")
        dialog.birth.set_value(date(2015, 5, 1))

    dialogs.fill("PeopleDialog", people)
    dialogs.fill("MemberTaxDialog", member)
    page.edit_people()
    assert dialogs.names() == ["PeopleDialog", "MemberTaxDialog"]
    info = records.member_info(rich.ledger, f.bruno)
    assert info is not None and info.birth_date == date(2015, 5, 1) and info.declared_by == f.ana
    assert rich.steps == 1

    dialogs.fill("PeopleDialog", lambda d: False)
    page.edit_people()  # closed without editing: no step
    assert rich.steps == 1


def test_people_need_members_first(app: QApplication, tmp_path: Path, dialogs: Dialogs) -> None:
    from opesvault.domain.ledger import Ledger

    window = MainWindow()
    session = Session.new(tmp_path / "x.opesvault", "Teste")
    session.ledger = Ledger.new("Vazio")
    window.session = session
    window._refresh()
    page = _page(window)
    messages: list[str] = []
    page.set_notify_hook(messages.append)
    page.edit_people()
    assert messages == ["Cadastre os integrantes em Contas e cartões › Integrantes."] and dialogs.opened == []


def test_natures_are_chosen_by_the_user(rich: Rich, dialogs: Dialogs) -> None:
    from opesvault.ui.common import select_combo

    page, ids = rich.page, rich.ids
    page.other.setCurrentCell(-1, -1)
    page.edit_selected_nature()  # no row: the dialog opens on no line in particular
    assert dialogs.last("NatureDialog").table.currentRow() == -1

    def fill(dialog: Any) -> None:
        assert dialog.combos[dialog.table.currentRow()][1] == ids["dividends"]  # opened on the selected line
        select_combo(next(c for _s, r, c in dialog.combos if r == ids["odd"]), IncomeNature.CARNE_LEAO)

    dialogs.fill("NatureDialog", fill)
    rich.select(page.other, 1, "Dividendos")
    page.edit_selected_nature()
    assert records.nature_of(rich.ledger, NatureSubject.CATEGORY, ids["odd"]) is IncomeNature.CARNE_LEAO
    assert records.nature_of(rich.ledger, NatureSubject.CATEGORY, ids["dividends"]) is IncomeNature.EXEMPT
    assert rich.messages == ["Natureza dos rendimentos salva."] and rich.steps == 1


def test_the_payer_of_the_selected_income(rich: Rich, dialogs: Dialogs) -> None:
    page, f, ids = rich.page, rich.f, rich.ids
    page.taxable.setCurrentCell(-1, -1)
    page.other.setCurrentCell(-1, -1)
    page.edit_payer()
    assert dialogs.opened == []
    rich.select(page.other, 1, "Dividendos")
    page.edit_payer()
    assert dialogs.last("TaxIdDialog").ref == ids["dividends"]
    dialogs.fill("TaxIdDialog", lambda d: d.number.setText("11.222.333/0001-81"))
    page.other.setCurrentCell(-1, -1)
    rich.select(page.taxable, 0, "Salário")
    page.edit_payer()
    assert dialogs.last("TaxIdDialog").ref == f.salary
    assert rich.messages == ["CPF/CNPJ salvo."] and rich.steps == 1


def test_the_payer_follows_the_row_picked_last(rich: Rich, dialogs: Dialogs) -> None:
    page, f, ids = rich.page, rich.f, rich.ids
    rich.select(page.taxable, 0, "Salário")
    rich.select(page.other, 1, "Dividendos")  # picked later, in the other table
    assert not page.taxable.selectedItems()
    page.edit_payer()
    assert dialogs.last("TaxIdDialog").ref == ids["dividends"]
    rich.select(page.taxable, 0, "Salário")
    assert not page.other.selectedItems()
    page.edit_payer()
    assert dialogs.last("TaxIdDialog").ref == f.salary


def test_payslips_are_detailed_from_the_payer(rich: Rich, dialogs: Dialogs, warnings: list[str]) -> None:
    from opesvault.ui.tax_dialogs import IncomeDetailDialog

    page = rich.page
    page.taxable.setCurrentCell(-1, -1)
    page.detail_payslips()
    assert rich.messages == ["Escolha uma fonte pagadora."] and dialogs.opened == []
    op = next(o for o in rich.ledger.active_operations() if o.description == "Salário")

    def payslips(dialog: Any) -> bool:
        assert dialog.table.item(0, 3).text() == "não detalhado"
        dialog.table.setCurrentCell(-1, -1)
        dialog.act()  # nothing selected
        dialog.table.setCurrentCell(0, 0)
        dialogs.fill("IncomeDetailDialog", lambda d: d.gross.setText("abc"))
        dialog.act()  # refused in the form: nothing saved
        assert not dialog.edited and dialogs.last("IncomeDetailDialog").error.text()
        dialogs.fill("IncomeDetailDialog", lambda d: (d.gross.setText("1.800,00"), d.withheld.setText("100,00")))
        dialog.act()
        assert dialog.edited and dialog.table.item(0, 3).text() == "R$ 1.800,00 / R$ 100,00 / —"
        return False

    dialogs.fill("OperationsDialog", payslips)
    rich.select(page.taxable, 0, "Salário")
    page.detail_payslips()
    detail = records.detail_of(rich.ledger, op.id)
    assert detail is not None and detail.gross == Decimal("1800.00") and detail.social_security is None
    assert rich.steps == 1 and warnings == []
    assert page.taxable.item(0, 3).text() == "R$ 1.800,00"  # the sheet now counts the gross
    reopened = IncomeDetailDialog(None, rich.ledger, op.id)
    assert reopened.gross.text() == "1.800,00" and reopened.social.text() == ""


def test_receipts_are_attached_to_a_payment(
    rich: Rich, dialogs: Dialogs, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from opesvault.domain import attachments

    page = rich.page
    page.payments.setCurrentCell(-1, -1)
    page.edit_payee()
    page.payment_receipts()
    assert dialogs.opened == []
    receipt = tmp_path / "recibo.pdf"
    receipt.write_bytes(docs.bank_income_report_pdf(Y))
    chosen = iter(["", str(tmp_path / "sumiu.pdf"), str(receipt)])
    monkeypatch.setattr(QFileDialog, "getOpenFileName", lambda *a, **k: (next(chosen), ""))
    op = next(o for o in rich.ledger.active_operations() if o.description == "CLINICA BOA SAUDE")

    def receipts(dialog: Any) -> bool:
        assert dialog.table.item(0, 3).text() == "falta"
        dialog.table.setCurrentCell(0, 0)
        dialog.act()  # the file dialog was cancelled
        dialog.act()  # a file that cannot be read
        assert dialog.error.text() == "Não foi possível ler o arquivo." and not dialog.edited
        dialog.act()
        assert dialog.edited and dialog.table.item(0, 3).text() == "1 anexo(s)"
        return False

    dialogs.fill("OperationsDialog", receipts)
    page.payments.setCurrentCell(0, 0)  # the clinic, the only payment
    page.payment_receipts()
    assert len(attachments.of_operation(rich.ledger, op.id)) == 1 and rich.steps == 1

    dialogs.fill("TaxIdDialog", lambda d: d.number.setText("529.982.247-25"))
    page.payments.setCurrentCell(0, 0)  # the clinic, the only payment
    page.edit_payee()
    payee = dialogs.last("TaxIdDialog").ref
    assert dialogs.last("TaxIdDialog").subject is TaxSubject.MERCHANT
    assert records.identity(rich.ledger, TaxSubject.MERCHANT, payee) is not None and rich.steps == 2


def test_assets_are_filed_and_their_institutions_named(rich: Rich, dialogs: Dialogs) -> None:
    from opesvault.investments.service import positions
    from opesvault.tax.model import FilingSubject
    from opesvault.ui.common import select_combo

    page, f, ids = rich.page, rich.f, rich.ids
    page.assets.setCurrentCell(-1, -1)
    page.debts.setCurrentCell(-1, -1)
    page.edit_filing()
    page.edit_institution()
    page.edit_lender()
    assert dialogs.opened == []

    rich.select(page.assets, 2, "Banco A")
    page.edit_filing()
    page.edit_institution()
    filing, bank = dialogs.opened[-2:]
    assert (filing.subject, filing.ref) == (FilingSubject.ACCOUNT, f.bank)
    assert (bank.subject, bank.ref) == (TaxSubject.ACCOUNT, f.bank)

    rich.select(page.assets, 2, "CDB X")
    page.edit_institution()  # the broker is the position's account
    broker = dialogs.opened[-1]
    assert (broker.subject, broker.ref) == (TaxSubject.ACCOUNT, positions(rich.ledger)[ids["cdb"]].account_id)
    dialogs.fill("FilingDialog", lambda d: select_combo(d.kind, ("04", "02")))
    page.edit_filing()
    found = records.filing_of(rich.ledger, FilingSubject.POSITION, ids["cdb"])
    assert found is not None and (found.group, found.code) == ("04", "02") and rich.messages == ["Bem classificado."]

    rich.select(page.assets, 2, "Carro")
    before = len(dialogs.opened)
    page.edit_institution()  # a declared good has no institution
    assert len(dialogs.opened) == before
    dialogs.fill("DeclaredAssetDialog", lambda d: d.cost.setText("65.000,00"))
    page.edit_filing()
    car = records.declared_assets(rich.ledger)[ids["car"]]
    assert car.cost == Decimal("65000.00") and car.name == "Carro" and rich.messages[-1] == "Bem salvo."

    page.debts.setCurrentCell(0, 0)
    page.edit_lender()
    lender = dialogs.opened[-1]
    assert (lender.subject, lender.ref) == (TaxSubject.ACCOUNT, ids["loan"]) and lender.name.text() == "Financiamento"
    assert rich.steps == 2


def test_a_new_good_by_hand(rich: Rich, dialogs: Dialogs) -> None:
    from opesvault.ui.common import select_combo

    def fill(dialog: Any) -> None:
        dialog.name.setText("Apartamento")
        select_combo(dialog.kind, ("01", "11"))
        dialog.cost.setText("350.000,00")
        dialog.acquired.setDate(QDate(Y, 4, 1))

    dialogs.fill("DeclaredAssetDialog", fill)
    rich.page.new_asset()
    assert any(a.name == "Apartamento" for a in records.declared_assets(rich.ledger).values())
    assert rich.messages == ["Bem incluído."] and rich.steps == 1
    assert any(r.name == "Apartamento" for r in rich.page._assets)


def test_a_carne_leao_darf_is_paid_from_its_month(rich: Rich, dialogs: Dialogs) -> None:
    from opesvault.domain.model import YearMonth
    from opesvault.tax.model import PaymentPurpose
    from opesvault.ui.common import select_combo

    page, f = rich.page, rich.f
    page.carne.setCurrentCell(-1, -1)
    page.pay_carne_leao()
    assert rich.messages == ["Escolha o mês do Carnê-Leão."] and dialogs.opened == []

    def fill(dialog: Any) -> None:
        assert dialog.amount.text() == ""  # calculated in the Carnê-Leão Web, never here
        dialog.amount.setText("80,00")
        select_combo(dialog.account, f.bank)

    dialogs.fill("PaymentDialog", fill)
    page.carne.setCurrentCell(0, 0)
    page.pay_carne_leao()
    dialog = dialogs.last("PaymentDialog")
    month = YearMonth(year=Y, month=8)
    assert (dialog.purpose, dialog.month, dialog.member_id) == (PaymentPurpose.CARNE_LEAO, month, f.ana)
    assert records.paid(rich.ledger, PaymentPurpose.CARNE_LEAO, month, f.ana) == Decimal("80.00")
    assert rich.messages[-1] == "Pagamento do DARF registrado." and rich.steps == 1


def test_a_variable_income_darf_is_suggested_from_what_is_due(rich: Rich, dialogs: Dialogs) -> None:
    from opesvault.domain.model import YearMonth
    from opesvault.tax import variable_income
    from opesvault.tax.model import Bucket, BucketRule, PaymentPurpose
    from opesvault.ui.tax_dialogs.fields import editable

    page = rich.page
    note = page.variable_note.text()
    assert "Day trade" in note and "sem alíquota" in note
    page.variable.setCurrentCell(-1, -1)
    page.pay_variable()  # no rate informed: nothing is due, so no month is chosen for the user
    assert rich.messages == ["Escolha o mês na tabela de renda variável."] and dialogs.opened == []

    rich.select(page.variable, 0, f"03/{Y}")
    page.pay_variable()
    assert dialogs.last("PaymentDialog").month == YearMonth(year=Y, month=3)

    rules = [BucketRule(bucket=b, rate=Decimal("0.15")) for b in (Bucket.COMMON, Bucket.DAY_TRADE)]
    records.set_variable_rules(rich.ledger, date(2000, 1, 1), rules, "teste")
    page.refresh()
    page.variable.setCurrentCell(-1, -1)
    page.pay_variable()  # the first month with a DARF still unpaid
    dialog = dialogs.last("PaymentDialog")
    month, (due, paid, _when) = next(iter(variable_income.due_by_month(page._months).items()))
    assert dialog.purpose is PaymentPurpose.VARIABLE_INCOME and dialog.member_id is None
    assert dialog.month == month and dialog.amount.text() == editable(due - paid) != ""


def test_alerts_reveal_the_year_and_open_the_darf(rich: Rich, dialogs: Dialogs) -> None:
    from opesvault.domain.model import YearMonth

    page, f = rich.page, rich.f
    page.reveal(("year", Y - 1))
    assert page._year() == Y - 1
    page.reveal(("carne_leao", YearMonth(year=Y, month=8), f.ana))
    assert page._year() == Y and dialogs.opened == []  # shown, not acted on
    page.reveal(("carne_leao", YearMonth(year=Y, month=8), f.ana), act=True)
    assert dialogs.last("PaymentDialog").member_id == f.ana
    page.reveal(("variable_income", YearMonth(year=Y, month=4)), act=True)
    assert dialogs.last("PaymentDialog").amount.text() == ""  # no rate: nothing to suggest
    page.reveal("anything else")
    page._pay(None)
    assert len(dialogs.opened) == 2


def test_documents_of_the_year_open_or_are_marked(
    rich: Rich, dialogs: Dialogs, monkeypatch: pytest.MonkeyPatch
) -> None:
    page = rich.page
    page.docs_table.setCurrentCell(-1, -1)
    page.open_document_item()
    page.toggle_received()
    assert dialogs.opened == [] and rich.steps == 0
    asked: list[str] = []

    def choose(*_args: Any, **_kwargs: Any) -> tuple[str, str]:
        asked.append("informe")
        return ("", "")

    monkeypatch.setattr(QFileDialog, "getOpenFileName", choose)
    rich.select(page.docs_table, 0, "Informe de rendimentos — Banco A")
    page.open_document_item()  # its informe exists: it opens
    assert dialogs.last("ReportDialog").report_id is not None and not asked
    rich.select(page.docs_table, 0, "Comprovante de rendimentos — Salário")
    page.open_document_item()  # none yet: import one for that payer
    assert asked == ["informe"]
    rich.select(page.docs_table, 0, "Recibos e notas")
    page.open_document_item()
    assert dialogs.last("OperationsDialog").mode == "receipts"

    title = "Documento de compra — Carro"
    key = next(d.key for d in page._docs if d.title == title)
    rich.select(page.docs_table, 0, title)
    page.open_document_item()  # nothing to open: it is marked by hand
    found = records.mark_of(rich.ledger, Y, key)
    assert found is not None and found.received and rich.steps == 1
    rich.select(page.docs_table, 0, title)
    page.toggle_received()  # back to what the app sees
    assert records.mark_of(rich.ledger, Y, key) is None and rich.steps == 2


def test_an_informe_typed_by_hand_corrected_and_removed(
    rich: Rich, dialogs: Dialogs, monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.tax.model import ReportSource
    from opesvault.ui.common import select_combo
    from opesvault.ui.pages.tax import informes

    page, f = rich.page, rich.f

    def typed(dialog: Any) -> None:
        select_combo(dialog.source, (ReportSource.CATEGORY, f.salary))
        dialog._add_row(None)
        dialog.table.item(0, 2).setText("1.400,00")
        dialog.payer.setText("11.222.333/0001-81")

    dialogs.fill("ReportDialog", typed)
    page.new_report()
    report = next(r for r in records.reports_of(rich.ledger, Y) if r.source is ReportSource.CATEGORY)
    assert [line.amount for line in report.lines] == [Decimal("1400.00")]
    found = records.identity(rich.ledger, TaxSubject.CATEGORY, f.salary)
    assert found is not None and found.tax_id == "11222333000181"  # the informe names the payer
    assert rich.messages == ["Informe salvo."] and rich.steps == 1

    page.reports.setCurrentCell(-1, -1)
    page.open_report()
    page.remove_report()
    rich.select(page.reports, 0, "Salário")
    assert page.checks.rowCount() >= 1  # the selected informe compared with the records

    def corrected(dialog: Any) -> None:
        assert dialog.lines()[0].amount == Decimal("1400.00") and dialog.report_id == report.id
        dialog.table.item(0, 2).setText("1.500,00")

    dialogs.fill("ReportDialog", corrected)
    page.open_report()
    assert records.reports(rich.ledger)[report.id].lines[0].amount == Decimal("1500.00")
    assert rich.messages[-1] == "Informe corrigido." and rich.steps == 2

    answers = iter([False, True])
    monkeypatch.setattr(informes, "confirm", lambda *a: next(answers))
    rich.select(page.reports, 0, "Salário")
    page.remove_report()
    assert report.id in records.reports(rich.ledger) and rich.steps == 2
    rich.select(page.reports, 0, "Salário")
    page.remove_report()
    assert report.id not in records.reports(rich.ledger) and rich.steps == 3


def test_an_informe_file_that_cannot_be_read(rich: Rich, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from opesvault.importing.source import SourceError, SourceProblem
    from opesvault.ui.pages.tax import informes

    page = rich.page
    monkeypatch.setattr(QFileDialog, "getOpenFileName", lambda *a, **k: ("", ""))
    page.import_report()  # cancelled
    monkeypatch.setattr(QFileDialog, "getOpenFileName", lambda *a, **k: (str(tmp_path / "sumiu.pdf"), ""))
    page.import_report()
    assert rich.messages == ["Não foi possível ler o arquivo."]
    page._job = object()
    page.import_report()  # one import at a time
    page._job = None
    assert rich.messages == ["Não foi possível ler o arquivo."]

    page._report_read("x.pdf", b"x", None, SourceError(SourceProblem.INVALID))
    assert rich.messages[-1] == "Não foi possível ler este arquivo. Use Mais › Novo informe sem arquivo."
    assert page.import_button.isEnabled() and page._job is None

    retried: list[tuple[Any, ...]] = []
    monkeypatch.setattr(page, "_read_report", lambda *args: retried.append(args))
    answers = iter([("", False), ("segredo", True)])
    monkeypatch.setattr(informes.QInputDialog, "getText", lambda *a, **k: next(answers))
    page._report_read("x.pdf", b"x", None, SourceError(SourceProblem.PASSWORD_REQUIRED))
    assert retried == []  # cancelled: nothing read again
    page._report_read("x.pdf", b"x", None, SourceError(SourceProblem.WRONG_PASSWORD))
    assert retried == [("x.pdf", b"x", None, "segredo")]
    assert rich.steps == 0


def test_an_informe_read_is_reviewed_before_it_is_kept(rich: Rich, dialogs: Dialogs, warnings: list[str]) -> None:
    from opesvault.tax import statements
    from opesvault.tax.model import ReportLine, ReportSource

    page, f = rich.page, rich.f
    session = rich.window.session
    assert session is not None
    data = docs.bank_income_report_pdf(Y)
    lines = [ReportLine(field=ReportField.BALANCE_END, amount=Decimal("2500.00"))]
    parsed = statements.ParsedReport(None, None, "Banco", lines, ["linha"])
    source = (ReportSource.ACCOUNT, f.savings)
    page._report_read("informe.pdf", data, source, parsed)  # reviewed and cancelled
    dialog = dialogs.last("ReportDialog")
    assert dialog.year.value() == Y and dialog.source.currentData() == source  # no year in the file: the page's
    assert rich.steps == 0 and session.find_document_by_hash(_sha256(data)) is None

    dialogs.fill("ReportDialog", lambda d: None)
    page._report_read("informe.pdf", data, source, parsed)
    [saved] = [r for r in records.reports_of(rich.ledger, Y) if r.source_id == f.savings]
    document = session.find_document_by_hash(_sha256(data))
    assert document is not None and document.meta.original_name == "informe.pdf"
    assert saved.document_id == document.meta.id and warnings == []
    assert rich.messages[-1] == "Informe salvo e comparado com o registrado." and rich.steps == 1

    # The same file for another account: the original already in the vault is reused, not copied.
    page._report_read("copia.pdf", data, (ReportSource.ACCOUNT, f.joint), parsed)
    [other] = [r for r in records.reports_of(rich.ledger, Y) if r.source_id == f.joint]
    assert other.document_id == document.meta.id and len(session.documents) == 1 and rich.steps == 2

    # Bug fixed: an informe the domain refuses (one per source and year) left its file in the vault,
    # orphan and outside any undo step.
    other_file = docs.bank_income_report_pdf(Y - 1)
    page._report_read("outro.pdf", other_file, source, parsed)
    assert warnings == ["Já há um informe desta fonte neste ano; abra-o para corrigir."]
    assert session.find_document_by_hash(_sha256(other_file)) is None and len(session.documents) == 1
    assert rich.steps == 2  # also asserts that nothing was left out of an undo step

    page.set_session(None)
    page._report_read("informe.pdf", data, None, parsed)  # the vault closed while reading
    assert len(dialogs.opened) == 4


def _sha256(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


def test_the_report_for_the_return_is_an_unencrypted_pdf_only_when_confirmed(
    rich: Rich, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from opesvault.ui import pdf_export

    page = rich.page
    target = tmp_path / "saida" / "declaracao.pdf"
    target.parent.mkdir()
    asked: list[str] = []

    def save_name(_parent: Any, _title: str, suggested: str, _filter: str) -> tuple[str, str]:
        asked.append(suggested)
        return (str(target) if len(asked) > 1 else "", "")

    answers = iter([False, True, True])
    monkeypatch.setattr(pdf_export, "confirm", lambda *a: next(answers))
    monkeypatch.setattr(QFileDialog, "getSaveFileName", save_name)
    page.export_pdf()  # the warning was declined: not even the file dialog
    assert asked == [] and not target.exists()
    page.export_pdf()  # the file dialog was cancelled
    assert asked == [f"declaracao-{Y}.pdf"] and not target.exists() and rich.messages == []
    page.export_pdf()
    assert target.read_bytes().startswith(b"%PDF")
    assert rich.messages == [f"Relatório de {Y} gerado."]
    assert [p.name for p in target.parent.iterdir()] == ["declaracao.pdf"]  # no temporary files
    assert rich.steps == 0


# ── dialogs on their own ──────────


def test_a_report_dialog_recognizes_the_issuer_by_cnpj(rich: Rich) -> None:
    from opesvault.domain.ledger import DomainError
    from opesvault.tax.model import ReportLine, ReportSource
    from opesvault.ui.common import select_combo
    from opesvault.ui.tax_dialogs import ReportDialog

    f, ledger = rich.f, rich.ledger
    records.set_identity(ledger, TaxSubject.ACCOUNT, f.savings, "11.222.333/0001-81")
    records.set_identity(ledger, TaxSubject.CATEGORY, f.salary, "11.444.777/0001-61")
    records.set_identity(ledger, TaxSubject.MERCHANT, "CLINICA", "06.990.590/0001-23")

    def guessed(tax_id: str) -> object:
        return ReportDialog(None, ledger, year=Y, lines=[], payer_tax_id=tax_id).source.currentData()

    assert guessed("11222333000181") == (ReportSource.ACCOUNT, f.savings)
    assert guessed("11444777000161") == (ReportSource.CATEGORY, f.salary)
    assert guessed("06990590000123") is None  # a payee is not an informe's issuer
    assert guessed("00000000000191") is None

    lines = [ReportLine(field=ReportField.TAXABLE, amount=Decimal("10"), label="a")] * 2
    dialog = ReportDialog(None, ledger, year=Y, lines=lines, skipped=[f"linha {n}" for n in range(8)])
    captions = [label.text() for label in dialog.findChildren(QLabel)]
    assert any(c.endswith("linha 5…") and "linha 6" not in c for c in captions)  # a long list is cut
    dialog._try_accept()
    assert dialog.error.text() == "Escolha de quem é o informe."
    select_combo(dialog.source, (ReportSource.ACCOUNT, f.joint))
    dialog.payer.setText("123")
    dialog._try_accept()
    assert dialog.error.text() and dialog.result() != QDialog.DialogCode.Accepted
    dialog.payer.setText("")
    value = dialog.table.item(1, 2)
    assert value is not None
    value.setText("dez")
    with pytest.raises(DomainError, match="linha 2"):
        dialog.lines()
    value.setText("")  # a line without a value is left out
    assert len(dialog.lines()) == 1
    dialog.table.setCurrentCell(-1, -1)
    dialog._remove_row()  # nothing selected: nothing removed
    dialog.table.setCurrentCell(1, 1)
    dialog._remove_row()
    assert dialog.table.rowCount() == 1
    dialog.payer.setText("06.990.590/0001-23")
    assert dialog.apply().payer_tax_id == "06990590000123"
    known = records.identity(ledger, TaxSubject.ACCOUNT, f.joint)
    assert known is not None and known.tax_id == "06990590000123"  # unknown until now: taken from the informe

    savings = ReportDialog(None, ledger, year=Y, lines=lines, source=(ReportSource.ACCOUNT, f.savings))
    savings.payer.setText("06.990.590/0001-23")
    savings.apply()
    kept = records.identity(ledger, TaxSubject.ACCOUNT, f.savings)
    assert kept is not None and kept.tax_id == "11222333000181"  # a CNPJ the user typed is not overwritten


def test_a_payment_needs_an_account_and_the_table_loses_a_row(app: QApplication) -> None:
    from opesvault.domain.ledger import Ledger
    from opesvault.domain.model import YearMonth
    from opesvault.tax.model import PaymentPurpose
    from opesvault.ui.tax_dialogs import ParametersDialog, PaymentDialog

    ledger = Ledger.new("Sem contas")
    month = YearMonth(year=Y, month=4)
    dialog = PaymentDialog(None, ledger, PaymentPurpose.VARIABLE_INCOME, month, None, Decimal("10"))
    dialog._try_accept()
    assert dialog.error.text() == "Escolha a conta."
    params = ParametersDialog(None, ledger, Y)
    rows = params.table.rowCount()
    params.table.setCurrentCell(-1, -1)
    params._remove()
    params.table.setCurrentCell(0, 0)
    params._remove()
    assert params.table.rowCount() == rows - 1


def test_a_good_needs_its_irpf_code(app: QApplication) -> None:
    from opesvault.domain.ledger import Ledger
    from opesvault.ui.tax_dialogs import DeclaredAssetDialog

    dialog = DeclaredAssetDialog(None, Ledger.new("x"))
    dialog.name.setText("Casa")
    dialog.cost.setText("1,00")
    dialog._try_accept()
    assert dialog.error.text() == "Escolha o grupo e o código na tabela do IRPF."


def test_stale_references_open_nothing(rich: Rich, dialogs: Dialogs) -> None:
    from uuid import uuid4

    from opesvault.ui.tax_dialogs import OperationsDialog

    rich.page._open_report_id(uuid4())  # an informe removed since the pending item was listed
    assert dialogs.opened == []
    op = next(o for o in rich.ledger.active_operations() if o.description == "Salário")
    dialog = OperationsDialog(None, rich.window.session, (uuid4(), op.id), "detail")
    assert dialog.table.rowCount() == 1  # a deleted operation is left out
