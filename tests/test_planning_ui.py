"""Interface of the review of 03/10/2026: charts beside their values (no tabs), collapsible sections,
and the screens of the new features."""

from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from PySide6.QtWidgets import QApplication, QTabWidget

from opesvault.domain import balance_checks, loans, sharing, tags
from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount, YearMonth
from opesvault.session import Session
from opesvault.ui import theme
from opesvault.ui.main_window import MainWindow

from .domain_fixtures import Family, category, family


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
    f.ledger.record_opening_balance(f.bank, "5000.00", date(2026, 1, 1))
    for month in (1, 2, 3):
        f.ledger.record_income(f.bank, f.salary, "4000.00", date(2026, month, 5), "Salário")
        f.ledger.record_expense(f.bank, f.groceries, "900.00", date(2026, month, 8), "Mercado")
    win.session = session
    win._refresh()
    return win, f


def _page(window: MainWindow, name: str) -> Any:
    page = next(p for p in window.pages if type(p).__name__ == name)
    window.show_page(window.pages.index(page))
    QApplication.processEvents()
    return page


def test_collapsible_remembers_only_the_users_choice(app: QApplication, monkeypatch: pytest.MonkeyPatch) -> None:
    from opesvault.ui.components import Collapsible

    stored: dict[str, object] = {}

    class Fake:
        def __init__(self, *_: object) -> None:
            pass

        def value(self, key: str, default: object = None) -> object:
            return stored.get(key, default)

        def setValue(self, key: str, value: object) -> None:  # noqa: N802 - Qt API
            stored[key] = value

    monkeypatch.setattr("PySide6.QtCore.QSettings", Fake)
    section = Collapsible("Valores", "teste/valores")
    assert section.expanded and not section.content.isHidden()
    section.set_expanded(False)  # programmatic: not a preference
    assert section.content.isHidden() and stored == {}
    section.toggle.click()  # the user's click is remembered on this computer
    assert section.expanded and stored == {"secoes/teste/valores": True}
    section.toggle.click()
    assert Collapsible("Valores", "teste/valores").expanded is False


def test_reports_show_the_chart_and_its_values_together(setup: tuple[MainWindow, Family]) -> None:
    window, _f = setup
    page = _page(window, "ReportsPage")
    assert not page.findChildren(QTabWidget)
    panel = page.panel
    assert panel.chart_section.expanded and panel.table_section.expanded
    headers = [panel.table.horizontalHeaderItem(c).text() for c in range(panel.table.columnCount())]
    assert headers == ["Mês", "Entradas", "Saídas"]
    labels = [panel.table.item(r, 0).text() for r in range(panel.table.rowCount())]
    assert labels[-2:] == ["Total", "Média"] and "jan/2026" in labels
    january = labels.index("jan/2026")
    assert panel.table.item(january, 1).text() == "R$ 4.000,00"
    # A row points at the value on the chart and fills the inspection line.
    panel.table.setCurrentCell(january, 1)
    assert "jan/26" in page.point.text() and page.open_ledger.isEnabled()
    csv = panel.csv_bytes().decode("utf-8-sig")
    assert csv.splitlines()[0] == "item;Entradas;Saídas" and "2026-01;4000.00;900.00" in csv
    for key in ("projected_balance", "comparison", "tags", "deductibles", "net_worth", "projection"):
        page.reveal(key)
        assert page.panel.data is not None, key


def test_investments_have_no_tabs_and_show_sections(setup: tuple[MainWindow, Family]) -> None:
    from opesvault.investments import service as inv
    from opesvault.investments.model import AssetClass, ValueNature

    window, f = setup
    pos = inv.create_position(
        f.ledger, "CDB", AssetClass.FIXED_INCOME, date(2026, 1, 2), initial_cost="1000", from_account=f.bank
    )
    inv.add_valuation(f.ledger, pos.id, date(2026, 2, 28), "1010", ValueNature.GROSS)
    window._refresh()
    page = _page(window, "InvestmentsPage")
    assert not page.findChildren(QTabWidget)
    assert page.valuations.rowCount() == 2 and page.evolution.chart is not None
    assert not page.detail.isHidden()


def test_overview_has_indicators_comparison_and_months(setup: tuple[MainWindow, Family]) -> None:
    window, _f = setup
    page = _page(window, "OverviewPage")
    page.follow_month(YearMonth(year=2026, month=3))
    page.refresh()
    assert page.indicators.values["Poupança no mês"].text() == "78%"  # (4000 − 900) / 4000
    names = [page.comparison.item(r, 0).text() for r in range(page.comparison.rowCount())]
    assert names[:3] == ["Receitas", "Despesas", "Resultado"]
    assert page.months_panel.data is not None and page.months_panel.table.rowCount() == 14  # 12 + total + média


def test_ledger_tags_filter_and_command(setup: tuple[MainWindow, Family], monkeypatch: pytest.MonkeyPatch) -> None:
    window, f = setup
    page = _page(window, "LedgerPage")
    op = next(o for o in f.ledger.operations.values() if o.description == "Mercado")
    tags.add_tag(f.ledger, [op.id], "Casa")
    window._refresh()
    page.reveal(("tag", "Casa"))
    assert page.model.rowCount() == 1 and not page.clear_filters.isHidden()
    assert page.filter_tag.currentData() == "Casa"
    page.reset_filters()
    assert page.filter_tag.currentIndex() == 0 and page.model.rowCount() > 1


def test_accounts_loan_tab_pays_an_installment(
    setup: tuple[MainWindow, Family], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.ui.planning_dialogs import PayInstallmentDialog

    window, f = setup
    debt = f.ledger.add_account(LedgerAccount(name="Carro", type=AccountType.LIABILITY, subtype=AccountSubtype.LOAN))
    plan = loans.create_loan(
        f.ledger,
        loans.LoanPlan(
            name="Carro",
            liability_account_id=debt.id,
            payment_account_id=f.bank,
            interest_category_id=category(f.ledger, "Juros e encargos"),
            principal=Decimal("1000.00"),
            monthly_rate=Decimal("0.01"),
            term=12,
            system=loans.AmortizationSystem.PRICE,
            first_due=date(2026, 2, 10),
        ),
        loans.Opening.OPENING_BALANCE,
        on=date(2026, 1, 10),
    )
    window._refresh()
    monkeypatch.setattr(PayInstallmentDialog, "exec", lambda self: 1)
    window.navigate("accounts", ("loan", plan.id, 1), act=True)
    page = _page(window, "AccountsPage")
    assert page.tabs.currentIndex() == page.loans_tab
    assert loans.status(f.ledger, plan.id).paid == 1
    assert page.schedule.item(0, 7).text() == "Paga"
    assert page.loans.item(0, 3).text() == "1 de 12"


def test_bank_check_alert_opens_the_account(setup: tuple[MainWindow, Family]) -> None:
    window, f = setup
    balance_checks.record(f.ledger, f.bank, date(2026, 3, 31), "1.00")
    window._refresh()
    window.navigate("accounts", ("check", f.bank))
    page = _page(window, "AccountsPage")
    assert page.tabs.currentIndex() == 0 and page.checks.rowCount() == 1
    assert "diferença" in page.accounts.item(page.accounts.currentRow(), 5).text()
    assert page.history.data is not None and page.history.data.title == "Saldo: Banco A"


def test_calendar_and_sharing_pages(setup: tuple[MainWindow, Family]) -> None:
    window, f = setup
    f.ledger.record_card_purchase(f.card, f.groceries, "300.00", date(2026, 2, 20), "Mercado")
    op = f.ledger.record_expense(f.bank, category(f.ledger, "Saúde"), "200.00", date(2026, 3, 5), "Consulta")
    sharing.request(f.ledger, op.id, "Plano", "150.00")
    window._refresh()
    agenda = _page(window, "AgendaPage")
    agenda.follow_month(YearMonth(year=2026, month=3))
    titles = [agenda.events.item(r, 1).text() for r in range(agenda.events.rowCount())]
    assert "Fatura Cartão X" in titles
    sharing_page = _page(window, "SharingPage")
    assert sharing_page.reimbursements.rowCount() == 1
    assert sharing_page.figures.values["A receber de reembolsos"].text() == "R$ 150,00"


def test_new_pages_have_accessible_controls_and_fit(setup: tuple[MainWindow, Family]) -> None:
    import importlib
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
    unnamed = importlib.import_module("auditar_acessibilidade").unnamed
    window, _f = setup
    window.resize(1280, 800)
    window.show()
    for name in ("AgendaPage", "SharingPage", "ReportsPage", "AccountsPage", "InvestmentsPage", "OverviewPage"):
        page = _page(window, name)
        assert unnamed(page) == [], name
        assert window.minimumSizeHint().width() <= 1000, name
