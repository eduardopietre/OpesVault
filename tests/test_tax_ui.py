"""Imposto de renda page (docs/09 §1.3 F): sheets on screen, issues that lead to the fix, the informe
import off the UI thread, and nothing left on screen when the vault closes (TA-31)."""

from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from PySide6.QtWidgets import QApplication, QFileDialog, QTableWidget

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
