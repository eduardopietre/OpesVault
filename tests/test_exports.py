import csv
import io
import json
from datetime import date
from decimal import Decimal

from opesvault.domain.ledger import Ledger
from opesvault.exports import interchange_json, ledger_csv

from .domain_fixtures import family


def test_ledger_csv_rebalances() -> None:
    f = family()
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2026, 1, 1))
    f.ledger.record_card_purchase(f.card, f.groceries, "99.99", date(2026, 1, 5), "Mercado; com ponto e vírgula")
    rows = list(csv.DictReader(io.StringIO(ledger_csv(f.ledger).decode("utf-8-sig")), delimiter=";"))
    assert sum(Decimal(r["valor"]) for r in rows) == 0
    assert any(r["descricao"] == "Mercado; com ponto e vírgula" for r in rows)


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
