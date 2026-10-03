"""What each sheet of the Imposto de renda page shows, checked without Qt (ui/pages/tax/rows.py)."""

import re
from decimal import Decimal
from pathlib import Path

from opesvault.domain.alerts import Severity
from opesvault.tax import declaration, issues, simulation
from opesvault.ui.pages.tax import rows

from .demo_vault import demo_session


def _name(member_id: object) -> str:
    return "Ana" if member_id else "—"


def test_a_missing_tax_id_says_so() -> None:
    assert rows.tax_id(None) == "falta"
    assert rows.tax_id("11222333000181") == "11.222.333/0001-81"


def test_issue_rows_keep_their_index_and_say_the_severity() -> None:
    found = [
        issues.Issue(Severity.URGENT, "CPF faltando: Ana", "a declaração exige", "member"),
        issues.Issue(Severity.INFO, "Confira o informe", "", "report"),
    ]
    assert rows.issue_rows(found) == [
        (["Corrigir", "CPF faltando: Ana", "a declaração exige"], 0),
        (["Conferir", "Confira o informe", ""], 1),
    ]


def test_income_of_the_demo_year_fills_the_sheets(tmp_path: Path) -> None:
    ledger = demo_session(tmp_path / "demo.opesvault").ledger
    found = declaration.income(ledger, 2026)
    taxable = rows.taxable_rows(found, _name)
    assert taxable and taxable[0][0][0] == "Empresa Exemplo Ltda"
    assert taxable[0][0][1] == "11.222.333/0001-81"
    assert [key for _cells, key in taxable] == list(range(len(found.taxable)))
    payments = rows.payment_rows(declaration.payments(ledger, 2026), _name)
    assert payments, "the demo marks Saúde as deductible and has a consultation"
    assert all(re.fullmatch(r"\d+ de \d+", cells[-1]) for cells, _ in payments)  # receipts: "N de M"


def test_assets_say_when_the_group_is_only_a_suggestion(tmp_path: Path) -> None:
    ledger = demo_session(tmp_path / "demo.opesvault").ledger
    found = declaration.assets(ledger, 2026)
    shown = rows.asset_rows(found)
    for row, (cells, key) in zip(found, shown, strict=True):
        assert key == found.index(row)
        assert ("(sugerido)" in cells[0]) == bool(row.suggested and row.group)
        if not row.group:
            assert cells[0] == "a definir"


def test_simulation_without_the_years_table_shows_unknown_never_zero() -> None:
    comparison = simulation.Comparison(year=2026, taxable=Decimal("50000.00"), withheld=Decimal("4000.00"))
    comparison.missing = ["a tabela progressiva"]
    shown = dict((key, cells) for cells, key in rows.simulation_rows(comparison))
    assert shown["tax"][1:] == ["—", "—"] and shown["balance"][1:] == ["—", "—"]
    assert shown["taxable"][1:] == ["R$ 50.000,00", "R$ 50.000,00"]
    note = rows.simulation_notes(comparison)
    assert "Falta informar a tabela progressiva" in note and "menos imposto" not in note


def test_simulation_names_the_cheaper_model_when_both_are_known() -> None:
    comparison = simulation.Comparison(year=2026, taxable=Decimal("50000.00"), withheld=Decimal("4000.00"))
    comparison.simplified = simulation.Model("Simplificada", Decimal("10000"), Decimal("40000"), Decimal("3000"))
    comparison.itemized = simulation.Model("Completa", Decimal("12000"), Decimal("38000"), Decimal("2500"))
    comparison.deductions = {"Saúde": Decimal("12000.00")}
    shown = dict((key, cells) for cells, key in rows.simulation_rows(comparison))
    assert shown["balance"][1:] == ["-R$ 1.000,00", "-R$ 1.500,00"]
    note = rows.simulation_notes(comparison)
    assert "a completa resulta em menos imposto" in note and "Deduções: Saúde R$ 12.000,00." in note


def test_variable_income_notes_always_warn_about_holidays() -> None:
    assert "feriados" in rows.variable_notes([], {})
