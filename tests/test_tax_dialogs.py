"""The income tax dialogs typed and confirmed as a person does (ui/tax_dialogs).

Nothing fiscal comes filled in: the user copies the year's table and rates, and the dialogs
check digits and formats. Wrong input stays in the form with a message, never as an error.
"""

from datetime import date
from decimal import Decimal

import pytest
from PySide6.QtCore import QDate
from PySide6.QtWidgets import QApplication, QDialog, QTableWidgetItem

from opesvault.domain.model import YearMonth
from opesvault.tax import records
from opesvault.tax.model import Bucket, FilingSubject, PaymentPurpose, TaxSubject
from opesvault.ui import tax_dialogs as dialogs
from opesvault.ui.common import select_combo

from .domain_fixtures import Family, family

VALID_CPF = "529.982.247-25"
VALID_CNPJ = "11.222.333/0001-81"


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    return instance if isinstance(instance, QApplication) else QApplication([])


@pytest.fixture
def f(app: QApplication) -> Family:
    return family()


def _confirm(dialog: QDialog) -> None:
    dialog._try_accept()  # type: ignore[attr-defined]
    assert dialog.result() == QDialog.DialogCode.Accepted, dialog.error.text()  # type: ignore[attr-defined]
    dialog.apply()  # type: ignore[attr-defined]


def _refused(dialog: QDialog, words: str) -> None:
    dialog._try_accept()  # type: ignore[attr-defined]
    assert dialog.result() != QDialog.DialogCode.Accepted
    assert words.casefold() in dialog.error.text().casefold(), dialog.error.text()  # type: ignore[attr-defined]


def test_a_payers_cnpj_is_checked_and_kept(f: Family) -> None:
    dialog = dialogs.TaxIdDialog(None, f.ledger, TaxSubject.CATEGORY, f.salary, "Salário")
    assert dialog.name.text() == "Salário"  # the label suggests the name
    dialog.number.setText("11.222.333/0001-80")
    _refused(dialog, "")  # a wrong check digit
    dialog.number.setText(VALID_CNPJ)
    dialog.name.setText("Empresa Exemplo Ltda")
    _confirm(dialog)
    found = records.identity(f.ledger, TaxSubject.CATEGORY, f.salary)
    assert found is not None and found.tax_id == "11222333000181" and found.name == "Empresa Exemplo Ltda"
    again = dialogs.TaxIdDialog(None, f.ledger, TaxSubject.CATEGORY, f.salary, "Salário")
    assert again.number.text() == VALID_CNPJ  # shown formatted


def test_a_member_becomes_a_dependent_with_a_valid_cpf(f: Family) -> None:
    dialog = dialogs.MemberTaxDialog(None, f.ledger, f.bruno)
    dialog.cpf.setText(VALID_CNPJ)
    _refused(dialog, "")  # a CNPJ is not a person's CPF
    dialog.cpf.setText(VALID_CPF)
    dialog.birth.set_value(date(2015, 5, 1))
    select_combo(dialog.declared_by, f.ana)
    dialog.relation.setText("Filho(a)")
    _confirm(dialog)
    info = records.member_info(f.ledger, f.bruno)
    assert info is not None and info.cpf == "52998224725" and info.declared_by == f.ana
    assert records.dependents_of(f.ledger, f.ana) == [f.bruno]
    assert records.people_of(f.ledger, f.ana) == {f.ana, f.bruno}


def test_the_years_table_is_typed_by_the_user(f: Family) -> None:
    dialog = dialogs.ParametersDialog(None, f.ledger, 2026)
    from opesvault.ui.tax_dialogs.fields import cell_text

    assert all(not cell_text(dialog.table, r, c) for r in range(5) for c in range(3))  # nothing embedded
    rows = [("26.963,20", "0", "0"), ("33.919,80", "7,5", "2.022,24"), ("", "27,5", "10.432,32")]
    for row, values in enumerate(rows):
        for column, value in enumerate(values):
            dialog.table.setItem(row, column, QTableWidgetItem(value))
    dialog.simple_rate.setText("20")
    dialog.simple_cap.setText("16.754,34")
    dialog.dependent.setText("2.275,08")
    dialog.source.setText("tabela do ano")
    _confirm(dialog)
    saved = records.parameters(f.ledger, 2026)
    assert saved is not None and len(saved.brackets) == 3
    assert saved.brackets[1].rate == Decimal("0.075") and saved.brackets[2].up_to is None
    assert saved.simplified_rate == Decimal("0.2") and saved.education_cap is None  # left empty: unknown
    reopened = dialogs.ParametersDialog(None, f.ledger, 2026)
    assert cell_text(reopened.table, 1, 1) == "7,5" and reopened.simple_rate.text() == "20"


def test_a_malformed_bracket_names_its_row(f: Family) -> None:
    dialog = dialogs.ParametersDialog(None, f.ledger, 2026)
    dialog.table.setItem(1, 0, QTableWidgetItem("muito"))
    _refused(dialog, "Faixa 2")


def test_variable_income_rates_and_the_exempt_limit(f: Family) -> None:
    dialog = dialogs.VariableRulesDialog(None, f.ledger)
    dialog.valid_from.setDate(QDate(2026, 1, 1))
    dialog.rates[Bucket.COMMON].setText("15")
    dialog.rates[Bucket.DAY_TRADE].setText("abc")
    _refused(dialog, "")
    dialog.rates[Bucket.DAY_TRADE].setText("20")
    dialog.limit.setText("20.000,00")
    dialog.source.setText("informado")
    _confirm(dialog)
    rules = records.variable_rules(f.ledger, date(2026, 6, 1))
    assert rules is not None
    common = rules.rule(Bucket.COMMON)
    assert common is not None and common.rate == Decimal("0.15") and common.exempt_sales_limit == Decimal("20000.00")
    day_trade = rules.rule(Bucket.DAY_TRADE)
    assert day_trade is not None and day_trade.exempt_sales_limit is None
    assert records.variable_rules(f.ledger, date(2025, 12, 31)) is None  # not before it was valid


def test_a_darf_payment_leaves_the_account_as_tax(f: Family) -> None:
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2026, 1, 1))
    month = YearMonth(year=2026, month=3)
    dialog = dialogs.PaymentDialog(None, f.ledger, PaymentPurpose.CARNE_LEAO, month, f.ana, Decimal("123.45"))
    assert dialog.amount.text() == "123,45"  # what is due comes suggested
    select_combo(dialog.account, f.bank)
    _confirm(dialog)
    assert records.paid(f.ledger, PaymentPurpose.CARNE_LEAO, month, f.ana) == Decimal("123.45")
    from opesvault.domain import queries

    assert queries.balance(f.ledger, f.bank) == Decimal("876.55")


def test_an_account_is_filed_and_a_house_declared_by_hand(f: Family) -> None:
    filing = dialogs.FilingDialog(None, f.ledger, FilingSubject.ACCOUNT, f.bank, "Banco A", None)
    _refused(filing, "")  # a group and code must be chosen
    select_combo(filing.kind, ("06", "01"))
    _confirm(filing)
    found = records.filing_of(f.ledger, FilingSubject.ACCOUNT, f.bank)
    assert found is not None and (found.group, found.code) == ("06", "01")

    house = dialogs.DeclaredAssetDialog(None, f.ledger)
    house.cost.setText("350.000,00")
    select_combo(house.kind, ("01", "11"))
    _refused(house, "nome do bem")
    house.name.setText("Apartamento")
    house.description.setText("  Apto   101, matrícula 123 ")
    house.acquired.setDate(QDate(2019, 7, 1))
    _confirm(house)
    [asset] = records.declared_assets(f.ledger).values()
    assert asset.cost == Decimal("350000.00") and asset.description == "Apto 101, matrícula 123"
    assert asset.sold_on is None and asset.sale_value is None


def test_rates_read_back_as_typed() -> None:
    from opesvault.ui.tax_dialogs.fields import percent_text

    cases = {"0.075": "7,5", "0.2": "20", "0": "0", "0.275": "27,5", "1": "100", "0.00125": "0,125"}
    assert {fraction: percent_text(Decimal(fraction)) for fraction in cases} == cases
    assert percent_text(None) == ""
