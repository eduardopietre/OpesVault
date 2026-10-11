"""Contas bancárias tab and dialogs: create with the COMPE list, values at a date, a new investment
with its characteristics, and nothing left on screen when the vault closes (TA-31)."""

from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from PySide6.QtCore import QDate, Qt
from PySide6.QtWidgets import QApplication, QTableWidget

from opesvault.domain import banking, queries
from opesvault.investments import profile as prof
from opesvault.session import Session
from opesvault.ui import theme
from opesvault.ui.common import select_combo
from opesvault.ui.main_window import MainWindow

from .domain_fixtures import Family, family


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
    win.session = session
    win._refresh()
    return win, f


def _tab(window: MainWindow) -> Any:
    page: Any = next(p for p in window.pages if type(p).__name__ == "AccountsPage")
    window.show_page(window.pages.index(page))
    QApplication.processEvents()
    return page.bank_tab


def test_create_bank_account_from_the_list(setup: tuple[MainWindow, Family], monkeypatch: pytest.MonkeyPatch) -> None:
    from opesvault.ui import bank_dialogs

    window, f = setup
    tab = _tab(window)
    assert tab.table.rowCount() == 0 and not tab.empty.isHidden()

    def fill(self: Any) -> int:
        select_combo(self.bank, "077")
        self.branch.setText("0001")
        self.number.setText("123/45-X")
        select_combo(self.holder, f.ana)
        self.joint.setChecked(True)
        select_combo(self.co_holder, f.bruno)
        self.parts[0].include.setChecked(True)
        self.parts[0].opening.setText("1.500,00")
        self.parts[1].include.setChecked(True)
        self.opening_date.setDate(QDate(2026, 1, 1))
        self.validate()
        return 1

    monkeypatch.setattr(bank_dialogs.BankAccountDialog, "exec", fill)
    tab.add()
    [item] = banking.bank_accounts(f.ledger).values()
    assert item.bank_code == "077" and item.number == "123/45-X" and item.co_holder_id == f.bruno
    assert item.checking_id is not None and item.savings_id is not None
    assert queries.balance(f.ledger, item.checking_id, date(2026, 1, 31)) == Decimal("1500.00")
    assert tab.table.rowCount() == 1 and "077" in tab.table.item(0, 1).text()
    assert tab.parts.rowCount() == 2
    window.undo()  # one user action, one undo step
    assert not banking.bank_accounts(f.ledger)


def test_values_and_new_investment(setup: tuple[MainWindow, Family], monkeypatch: pytest.MonkeyPatch) -> None:
    from opesvault.ui import bank_dialogs

    window, f = setup
    item = banking.create(
        f.ledger,
        banking.build(name="Itaú", bank_code="341", bank_name=None, branch="1", number="2", holder_id=f.ana),
        checking=True,
        opening={banking.Part.CHECKING: (Decimal("10000.00"), date(2026, 1, 2))},
    )
    tab = _tab(window)
    tab.refresh()

    def invest(self: Any) -> int:
        self.name.setText("CDB X")
        select_combo(self.kind, ("04", "02"))
        self.value.setText("4.000,00")
        select_combo(self.indexer, prof.Indexer.CDI)
        self.rate.setText("105")
        self.applied.set_value(date(2026, 2, 1))
        self.validate()
        return 1

    monkeypatch.setattr(bank_dialogs.InvestmentDialog, "exec", invest)
    tab.add_investment()
    [position_id] = banking.positions_of(f.ledger, item.id)
    found = prof.profile_of(f.ledger, position_id)
    assert found is not None and found.tax is prof.TaxTreatment.WITHHELD  # suggested from the IRPF type
    assert prof.yield_text(found) == "105% do CDI"
    assert queries.balance(f.ledger, item.checking_id, date(2026, 2, 28)) == Decimal("6000.00")  # type: ignore[arg-type]

    def values(self: Any) -> int:
        self.on.setDate(QDate(2026, 3, 31))
        for row, value in enumerate(self.rows):
            self.table.item(row, 2).setText("6.100,00" if value.kind == "checking" else "4.050,00")
            if value.kind == "checking":
                self.table.item(row, 3).setCheckState(Qt.CheckState.Checked)
        self.validate()
        return 1

    monkeypatch.setattr(bank_dialogs.ValuesDialog, "exec", values)
    tab.record_values()
    at = {v.ref: v.value for v in banking.values_at(f.ledger, item.id, date(2026, 3, 31))}
    assert (
        item.checking_id is not None
        and at[item.checking_id] == Decimal("6100.00")
        and at[position_id] == Decimal("4050.00")
    )
    assert tab.table.item(0, 7).text() == "R$ 4.050,00"


def test_account_dialog_has_first_and_second_holder(setup: tuple[MainWindow, Family]) -> None:
    from opesvault.domain.ledger import DomainError
    from opesvault.ui.dialogs import AccountDialog

    window, f = setup
    dialog = AccountDialog(window, f.ledger, f.ledger.account(f.joint))
    assert dialog.selected_holders() == (f.ana, f.bruno)
    select_combo(dialog.co_holder, f.ana)
    with pytest.raises(DomainError):
        dialog.selected_holders()


def test_closing_the_vault_clears_the_tab(setup: tuple[MainWindow, Family]) -> None:
    window, f = setup
    banking.create(
        f.ledger,
        banking.build(name="Itaú", bank_code="341", bank_name=None, branch="1", number="2", holder_id=f.ana),
        checking=True,
    )
    tab = _tab(window)
    tab.refresh()
    assert tab.table.rowCount() == 1
    page = next(p for p in window.pages if type(p).__name__ == "AccountsPage")
    page.set_session(None)
    for table in tab.findChildren(QTableWidget):
        assert table.rowCount() == 0


def test_maturity_alert_opens_the_investment(setup: tuple[MainWindow, Family]) -> None:
    from opesvault.investments import service as inv
    from opesvault.investments.model import AssetClass

    window, f = setup
    ledger = f.ledger
    first = inv.create_position(ledger, "Fundo A", AssetClass.FUND, date(2025, 1, 1), reference_value="500")
    second = inv.create_position(ledger, "CDB B", AssetClass.FIXED_INCOME, date(2025, 1, 1), reference_value="900")
    assert first.id != second.id
    window._refresh()
    window.navigate("investments", second.id)
    QApplication.processEvents()
    page: Any = next(p for p in window.pages if type(p).__name__ == "InvestmentsPage")
    assert page._position_id() == second.id
    assert page.detail.isVisibleTo(page)


def _investments(window: MainWindow) -> Any:
    page: Any = next(p for p in window.pages if type(p).__name__ == "InvestmentsPage")
    window.show_page(window.pages.index(page))
    QApplication.processEvents()
    return page


def test_new_investment_is_selected_and_points_to_its_characteristics(
    setup: tuple[MainWindow, Family], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.investments import service as inv
    from opesvault.investments.model import AssetClass
    from opesvault.ui.pages.investments import forms

    window, f = setup
    existing = inv.create_position(f.ledger, "Fundo A", AssetClass.FUND, date(2025, 1, 1), reference_value="500")
    window._refresh()
    page = _investments(window)
    assert page._position_id() == existing.id

    def fill(self: Any) -> int:
        self.fields["name"].setText("Tesouro IPCA 2035")
        self.fields["reference"].setText("1.000,00")
        return 1

    monkeypatch.setattr(forms.Form, "exec", fill)
    messages: list[str] = []
    monkeypatch.setattr(page, "notify", messages.append)
    page.new_position()
    created = next(p for p in inv.positions(f.ledger).values() if p.id != existing.id)
    assert page._position_id() == created.id
    assert messages and "Características" in messages[-1]


def test_investment_figures_say_what_is_missing(setup: tuple[MainWindow, Family]) -> None:
    from opesvault.investments import service as inv
    from opesvault.investments.model import AssetClass
    from opesvault.investments.performance import unrealized
    from opesvault.ui.pages.investments import detail

    _window, f = setup
    ledger = f.ledger
    pos = inv.create_position(ledger, "CDB", AssetClass.FIXED_INCOME, date(2026, 1, 2), reference_value="1000")
    today = date(2026, 10, 3)
    shown = {
        label: (value, tone)
        for label, value, tone in detail.figures(ledger, pos.id, today, unrealized(ledger, pos.id, today))
    }
    assert shown["Custo remanescente"][0] == "desconhecido"  # unknown, never zero
    assert shown["Vencimento"] == ("—", None)
    assert shown["Não realizado"][0] == "indisponível"

    prof.save_profile(ledger, prof.InvestmentProfile(position_id=pos.id, maturity=date(2026, 10, 20)))
    shown = {
        label: (value, tone)
        for label, value, tone in detail.figures(ledger, pos.id, today, unrealized(ledger, pos.id, today))
    }
    assert shown["Vencimento"] == ("20/10/2026 (em 17 dias)", "warning")  # within a month: stands out
    assert [detail.days_text(n) for n in (0, 1, -1, -3)] == ["hoje", "em 1 dia", "há 1 dia", "há 3 dias"]
