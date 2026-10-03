"""Interface of the review of 03/10/2026: charts beside their values (no tabs), collapsible sections,
and the screens of the new features."""

from datetime import UTC, date, datetime
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


def test_collapsible_remembers_only_the_users_choice(app: QApplication) -> None:
    from opesvault.ui import preferences
    from opesvault.ui.components import Collapsible

    def stored() -> object:
        return preferences.app_settings().value("secoes/teste/valores")

    section = Collapsible("Valores", "teste/valores")
    assert section.expanded and not section.content.isHidden()
    section.set_expanded(False)  # programmatic: not a preference
    assert section.content.isHidden() and stored() is None
    section.toggle.click()  # the user's click is remembered on this computer
    assert section.expanded and str(stored()).lower() == "true"
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
    assert page.detail.valuations.rowCount() == 2 and page.detail.evolution.chart is not None
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
    assert page.model.rowCount() == 1 and not page.filters.clear_button.isHidden()
    assert page.filters.tag.currentData() == "Casa"
    page.reset_filters()
    assert page.filters.tag.currentIndex() == 0 and page.model.rowCount() > 1


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


# ── second part: receipts, saved filters, member view, drop, PDF, goals, backup ─────


def test_receipt_attached_from_the_ledger_opens_in_documents(
    setup: tuple[MainWindow, Family], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from PySide6.QtWidgets import QFileDialog

    window, _f = setup
    receipt = tmp_path / "recibo.png"
    receipt.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
    monkeypatch.setattr(QFileDialog, "getOpenFileName", lambda *a, **k: (str(receipt), ""))
    page = _page(window, "LedgerPage")
    page.table.selectRow(0)
    page.attach_receipt()
    assert window.session is not None and [d.meta.original_name for d in window.session.documents] == ["recibo.png"]
    page._update_selection()
    document_id = window.session.documents[0].meta.id
    page.open_attachment(document_id)
    documents = _page(window, "DocumentsPage")
    assert documents.table.item(documents.table.currentRow(), 3).text() == "Comprovante"


def test_saved_filter_round_trip(setup: tuple[MainWindow, Family], monkeypatch: pytest.MonkeyPatch) -> None:
    from PySide6.QtWidgets import QInputDialog

    from opesvault.domain.saved_filters import saved

    window, f = setup
    page = _page(window, "LedgerPage")
    page.reveal(("filter", f.groceries, None))
    monkeypatch.setattr(QInputDialog, "getText", lambda *a, **k: ("Mercado", True))
    page.save_current_filter()
    [flt] = saved(f.ledger)
    assert flt.account_id == f.groceries
    page.reset_filters()
    page.apply_saved_filter(flt)
    assert page.filters.account.currentData() == f.groceries and page.model.rowCount() == 3


def test_member_view_on_the_overview(setup: tuple[MainWindow, Family]) -> None:
    window, f = setup
    page = _page(window, "OverviewPage")
    page.follow_month(YearMonth(year=2026, month=3))
    assert page.member.isVisibleTo(page)
    index = next(i for i in range(page.member.count()) if page.member.itemData(i) == f.bruno)
    page.member.setCurrentIndex(index)  # Bruno holds only the joint account and has no shares
    assert page.result.values["Despesas"].text() == "R$ 0,00"
    names = [page.balances.item(r, 0).text() for r in range(page.balances.rowCount())]
    assert names == ["Conjunta"]
    page.member.setCurrentIndex(0)
    assert page.result.values["Despesas"].text() == "R$ 900,00"


def test_files_dropped_anywhere_go_to_import(setup: tuple[MainWindow, Family], tmp_path: Path) -> None:
    from PySide6.QtCore import QMimeData, QUrl

    from opesvault.ui.pages.import_page import ImportPage

    window, _f = setup
    pdf = tmp_path / "fatura.pdf"
    pdf.write_bytes(b"%PDF-1.4\n")
    mime = QMimeData()
    mime.setUrls([QUrl.fromLocalFile(str(pdf)), QUrl.fromLocalFile(str(tmp_path / "planilha.xlsx"))])
    queued: list[list[Path]] = []
    page = next(p for p in window.pages if isinstance(p, ImportPage))
    page.import_paths = lambda paths: queued.append(paths)  # type: ignore[method-assign]

    class Drop:
        accepted = False

        def mimeData(self) -> QMimeData:  # noqa: N802 - Qt API
            return mime

        def acceptProposedAction(self) -> None:  # noqa: N802 - Qt API
            self.accepted = True

    event = Drop()
    window.dropEvent(event)
    assert event.accepted and queued == [[pdf]]
    assert window.stack.currentWidget() is page


def test_pdf_report_is_written_only_where_chosen(tmp_path: Path, app: QApplication) -> None:
    from opesvault.ui.pdf_export import write_pdf

    target = tmp_path / "resumo.pdf"
    write_pdf(str(target), "<h1>Resumo</h1><p>R$ 1.000,00</p>")
    assert target.read_bytes().startswith(b"%PDF")
    assert [p.name for p in tmp_path.iterdir()] == ["resumo.pdf"]  # no temporary files beside it


def test_goals_page(setup: tuple[MainWindow, Family]) -> None:
    from opesvault.domain import goals

    window, f = setup
    goals.add_goal(
        f.ledger,
        goals.Goal(
            name="Reserva", kind=goals.GoalKind.NET_WORTH, target=Decimal("50000.00"), created_on=date(2026, 1, 1)
        ),
    )
    window._refresh()
    page = _page(window, "GoalsPage")
    assert page.table.item(0, 0).text() == "Reserva"
    assert page.panel.data is not None and page.panel.data.title == "Meta: Reserva"


def test_backup_report_compares_with_the_open_vault(tmp_path: Path) -> None:
    from opesvault.ui.shell.backups import backup_report
    from opesvault.vault.model import RevisionInfo

    f = family()
    restored = Session.new(tmp_path / "b.opesvault")
    restored.ledger = f.ledger
    restored.revision = RevisionInfo(
        vault_id=restored.vault_id,
        format_version=1,
        revision=3,
        revision_id=restored.vault_id,
        saved_at=datetime(2026, 3, 1, 10, tzinfo=UTC),
    )
    current = Session(path=tmp_path / "a.opesvault", vault_id=restored.vault_id, ledger=f.ledger)
    current.revision = restored.revision.model_copy(update={"revision": 5})
    text = backup_report(restored, current)
    assert "Backup íntegro" in text and "Revisão 3" in text and "2 revisão(ões) atrás" in text
    other = Session.new(tmp_path / "c.opesvault")
    assert "outro cofre" in backup_report(restored, other)
