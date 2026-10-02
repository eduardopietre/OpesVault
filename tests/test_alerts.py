from datetime import date
from decimal import Decimal
from pathlib import Path

from opesvault.domain import alerts, budget
from opesvault.domain.alerts import Severity, Target
from opesvault.domain.model import YearMonth
from opesvault.domain.recurrence import RecurrenceRule, add_rule, realize
from opesvault.importing import pipeline
from opesvault.importing.pipeline import ImportRequest
from opesvault.session import Session

from . import synthetic_docs as docs
from .domain_fixtures import category, family

TODAY = date(2026, 3, 8)  # card X closes on the 3rd and is due on the 10th


def titles(found: list[alerts.Alert]) -> list[str]:
    return [a.title for a in found]


def test_card_bill_due_soon_then_paid() -> None:
    f = family()
    f.ledger.record_card_purchase(f.card, f.groceries, "300.00", date(2026, 2, 20), "Mercado")
    found = alerts.card_alerts(f.ledger, TODAY)
    assert len(found) == 1 and found[0].severity is Severity.SOON
    assert "vence em 2 dias" in found[0].detail and "R$ 300,00" in found[0].detail
    late = alerts.card_alerts(f.ledger, date(2026, 3, 15))
    assert late[0].severity is Severity.URGENT and late[0].title.startswith("Fatura vencida")
    f.ledger.record_card_payment(f.card, f.bank, "300.00", date(2026, 3, 9))
    assert alerts.card_alerts(f.ledger, date(2026, 3, 15)) == []


def test_recurrences_late_and_upcoming() -> None:
    f = family()
    rent = add_rule(
        f.ledger,
        RecurrenceRule(
            description="Aluguel",
            account_id=f.bank,
            counterpart_id=category(f.ledger, "Moradia"),
            amount=Decimal("2000"),
            day=12,
            start=date(2026, 1, 1),
            window_days=2,
        ),
    )
    found = alerts.recurrence_alerts(f.ledger, TODAY)
    assert [a.severity for a in found] == [Severity.URGENT, Severity.SOON]  # February late, March soon
    assert found[1].title == "Conta a vencer: Aluguel" and "vence em 4 dias" in found[1].detail
    op = f.ledger.record_expense(f.bank, category(f.ledger, "Moradia"), "2000.00", date(2026, 2, 12), "Aluguel")
    realize(f.ledger, rent.id, date(2026, 2, 12), op.id)
    assert [a.severity for a in alerts.recurrence_alerts(f.ledger, TODAY)] == [Severity.SOON]


def test_budget_and_import_alerts(tmp_path: Path) -> None:
    f = family()
    session = Session.new(tmp_path / "x.opesvault")
    session.ledger = f.ledger
    month = YearMonth.of(TODAY)
    budget.set_budget(f.ledger, f.groceries, month, "100.00")
    f.ledger.record_expense(f.bank, f.groceries, "120.00", date(2026, 3, 2), "Feira")
    pipeline.import_document(session, ImportRequest("nu.pdf", docs.nubank_card_pdf()))
    found = alerts.alerts(f.ledger, TODAY)
    assert found[0].severity is Severity.URGENT and found[0].target is Target.BUDGET
    assert any(a.target is Target.IMPORT and "aguardando revisão" in a.title for a in found)
    assert found == sorted(found, key=lambda a: alerts.ORDER[a.severity])


def test_quiet_vault_has_no_alerts() -> None:
    assert alerts.alerts(family().ledger, TODAY) == []
