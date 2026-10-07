import csv
import io
import json
from datetime import date
from decimal import Decimal

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount
from opesvault.exports import interchange_json, ledger_csv, spreadsheet_cell, spreadsheet_text

from .domain_fixtures import family


def test_ledger_csv_rebalances() -> None:
    f = family()
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2026, 1, 1))
    f.ledger.record_card_purchase(f.card, f.groceries, "99.99", date(2026, 1, 5), "Mercado; com ponto e vírgula")
    rows = list(csv.DictReader(io.StringIO(ledger_csv(f.ledger).decode("utf-8-sig")), delimiter=";"))
    assert sum(Decimal(r["valor"]) for r in rows) == 0
    assert any(r["descricao"] == "Mercado; com ponto e vírgula" for r in rows)


def test_spreadsheet_text_neutralizes_formulas() -> None:
    for start in ("=", "+", "-", "@", "\t", "\r"):
        assert spreadsheet_text(start + "HYPERLINK(1)") == "'" + start + "HYPERLINK(1)"
    assert spreadsheet_text("Mercado") == "Mercado"
    assert spreadsheet_text("") == ""
    assert spreadsheet_text(" =1") == " =1"
    # Free text is always guarded, even when it reads as a number.
    assert spreadsheet_text("-50") == "'-50"


def test_spreadsheet_cell_keeps_plain_numbers() -> None:
    assert spreadsheet_cell("-1485.00") == "-1485.00"
    assert spreadsheet_cell("+3") == "+3"
    assert spreadsheet_cell("2026-01") == "2026-01"
    assert spreadsheet_cell("-1+2") == "'-1+2"
    assert spreadsheet_cell("=SUM(A1)") == "'=SUM(A1)"


def test_ledger_csv_neutralizes_formulas_in_text_only() -> None:
    f = family()
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2026, 1, 1))
    f.ledger.record_card_purchase(f.card, f.groceries, "99.99", date(2026, 1, 5), '=HYPERLINK("http://x";"y")')
    category = f.ledger.add_account(
        LedgerAccount(name="@Compras", type=AccountType.EXPENSE, subtype=AccountSubtype.CATEGORY)
    ).id
    f.ledger.record_card_purchase(f.card, category, "10.00", date(2026, 1, 6), "-2+3")
    rows = list(csv.DictReader(io.StringIO(ledger_csv(f.ledger).decode("utf-8-sig")), delimiter=";"))
    descriptions = {r["descricao"] for r in rows}
    assert '\'=HYPERLINK("http://x";"y")' in descriptions and "'-2+3" in descriptions
    assert any(r["conta"] == "'@Compras" for r in rows)
    # Money stays a number: credits are negative and are not prefixed.
    assert any(r["valor"] == "-99.99" for r in rows)
    assert sum(Decimal(r["valor"]) for r in rows) == 0
    assert not any(v.startswith("'") for r in rows for k, v in r.items() if k not in ("descricao", "conta"))


def test_interchange_roundtrip_of_entities() -> None:
    f = family()
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2026, 1, 1))
    payload = json.loads(interchange_json(f.ledger))
    assert payload["formato"] == "opesvault-intercambio" and payload["versao_formato"] == 1
    from uuid import UUID

    rows = [(UUID(e["id"]), e["tipo"], e["dados"]) for e in payload["entidades"]]
    restored = Ledger.from_records(rows)
    assert restored.operations == f.ledger.operations


def test_migration_flag_on_old_schema() -> None:
    from opesvault.domain import migrations

    ledger = Ledger.new("x")
    rows = ledger.to_records()
    meta = {**rows[0][2], "schema_version": 0}
    migrations.STEPS[0] = lambda m, r: (m, r)
    try:
        restored = Ledger.from_records([(rows[0][0], rows[0][1], meta), *rows[1:]])
    finally:
        del migrations.STEPS[0]
    assert restored.migrated_from == 0
