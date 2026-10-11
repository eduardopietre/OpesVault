"""Second part of the review of 03/10/2026: receipts, saved filters, merchants, suspicious operations,
goals, the year-end summary, backup reminders and printable reports (docs/09 §1.3)."""

from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from opesvault.domain import alerts, annual, anomalies, attachments, goals, merchants, saved_filters
from opesvault.domain.cards import record_installment_purchase
from opesvault.domain.ledger import DomainError
from opesvault.domain.model import YearMonth
from opesvault.domain.periods import close_month
from opesvault.session import Session

from .domain_fixtures import category, family

D = Decimal
PDF = b"%PDF-1.4\n%fake receipt\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


# ── receipts ─────────────────────────────────────────────


def test_receipts_are_vault_documents_linked_beside_the_operation(tmp_path: Path) -> None:
    f = family()
    session = Session.new(tmp_path / "x.opesvault")
    session.ledger = f.ledger
    op = f.ledger.record_expense(f.bank, f.groceries, "80.00", date(2026, 1, 5), "Dentista")
    close_month(f.ledger, YearMonth(year=2026, month=1), "teste")  # a receipt never changes a figure
    first = attachments.attach(session, op.id, "recibo.pdf", PDF)
    assert [d.meta.original_name for d in session.documents] == ["recibo.pdf"]
    other = f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 2, 5), "Outro")
    attachments.attach(session, other.id, "mesmo.pdf", PDF)  # the same bytes: one document, two links
    assert len(session.documents) == 1 and len(attachments.of_document(f.ledger, first.document_id)) == 2
    with pytest.raises(DomainError, match="já está anexado"):
        attachments.attach(session, op.id, "de novo.pdf", PDF)
    with pytest.raises(DomainError, match="PDF ou uma imagem"):
        attachments.attach(session, op.id, "nota.txt", b"texto qualquer")
    photo = attachments.attach(session, op.id, "foto.png", PNG)
    assert attachments.kind_of(PNG) == "png" and len(session.documents) == 2
    attachments.detach(session, first.id)
    assert len(session.documents) == 2  # still used by the other operation
    attachments.detach(session, photo.id)
    assert [d.meta.original_name for d in session.documents] == ["recibo.pdf"]


# ── saved filters ────────────────────────────────────────


def test_saved_filters_live_in_the_vault() -> None:
    f = family()
    saved = saved_filters.save_filter(
        f.ledger, saved_filters.SavedFilter(name="  Cartão  da Ana ", period="this_month", account_id=f.card_account)
    )
    assert saved.name == "Cartão da Ana"
    replaced = saved_filters.save_filter(f.ledger, saved_filters.SavedFilter(name="cartão da ana", period="all"))
    assert replaced.id == saved.id and [s.period for s in saved_filters.saved(f.ledger)] == ["all"]
    with pytest.raises(DomainError, match="personalizado"):
        saved_filters.save_filter(f.ledger, saved_filters.SavedFilter(name="X", period="custom"))
    saved_filters.delete_filter(f.ledger, saved.id)
    assert saved_filters.saved(f.ledger) == []


# ── merchants ────────────────────────────────────────────


@pytest.mark.parametrize(
    ("description", "cleaned"),
    [
        ("IFD*IFOOD.COM AGENCIA", "Ifood"),
        ("MP*LOJA DO ZE 123456", "Loja Do Ze"),
        ("PADARIA REAL LTDA BR", "Padaria Real"),
        ("SPOTIFY P1A2B3", "Spotify"),
        ("NETFLIX.COM", "Netflix"),
        ("TV 55 (3/10)", "Tv"),
        ("12345", "12345"),
    ],
)
def test_merchant_cleaning(description: str, cleaned: str) -> None:
    assert merchants.clean(description) == cleaned


def test_an_approved_name_covers_similar_descriptions() -> None:
    f = family()
    for day, text in ((3, "IFD*IFOOD.COM AGENCIA"), (9, "IFD*IFOOD.COM AGENCIA 7781")):
        f.ledger.record_card_purchase(f.card, f.groceries, "50.00", date(2026, 3, day), text)
    f.ledger.record_card_purchase(f.card, f.groceries, "20.00", date(2026, 3, 9), "PADARIA REAL")
    merchants.name_merchant(f.ledger, "IFD*IFOOD.COM AGENCIA", "iFood")
    assert merchants.merchant_of(f.ledger, "IFD*IFOOD.COM AGENCIA 7781") == "iFood"
    found = merchants.totals(f.ledger, date(2026, 3, 1), date(2026, 3, 31))
    assert [(m.name, m.expense, m.count, m.approved) for m in found] == [
        ("iFood", D("100.00"), 2, True),
        ("Padaria Real", D("20.00"), 1, False),
    ]
    assert f.ledger.operations[next(iter(f.ledger.operations))].description  # descriptions untouched
    with pytest.raises(DomainError):
        merchants.name_merchant(f.ledger, "X", "  ")


# ── suspicious operations ────────────────────────────────


def test_possible_duplicate_charge_until_reviewed() -> None:
    f = family()
    today = date(2026, 3, 20)
    f.ledger.record_card_purchase(f.card, f.groceries, "89.90", date(2026, 3, 10), "POSTO SHELL")
    second = f.ledger.record_card_purchase(f.card, f.groceries, "89.90", date(2026, 3, 11), "POSTO SHELL")
    f.ledger.record_card_purchase(f.card, f.groceries, "89.90", date(2026, 3, 18), "POSTO SHELL")  # a week later
    record_installment_purchase(f.ledger, f.card, f.groceries, "300.00", date(2026, 3, 12), "TV", 3)
    found = anomalies.suspicions(f.ledger, today)
    assert [(s.kind, s.operation_id) for s in found] == [(anomalies.SuspicionKind.DUPLICATE, second.id)]
    assert "10/03" in found[0].detail and found[0].account_id == f.card_account
    assert [a.title for a in alerts.suspicion_alerts(f.ledger, today)] == ["Possível cobrança duplicada: POSTO SHELL"]
    assert anomalies.mark_reviewed(f.ledger, second.id) == 2
    assert anomalies.suspicions(f.ledger, today) == [] and anomalies.mark_reviewed(f.ledger, second.id) == 0


def test_value_far_above_the_category_usual() -> None:
    f = family()
    for month in range(1, 7):
        f.ledger.record_expense(f.bank, f.groceries, "100.00", date(2025, 9 + month % 4, month), f"Mercado {month}")
    f.ledger.record_expense(f.bank, f.groceries, "120.00", date(2026, 2, 10), "Mercado normal")
    typo = f.ledger.record_expense(f.bank, f.groceries, "1000.00", date(2026, 3, 1), "Mercado digitado errado")
    found = anomalies.suspicions(f.ledger, date(2026, 3, 5))
    assert [(s.kind, s.operation_id) for s in found] == [(anomalies.SuspicionKind.OUTLIER, typo.id)]
    assert "R$ 100,00" in found[0].detail


# ── goals ────────────────────────────────────────────────


def test_goal_progress_needed_per_month_and_pace() -> None:
    f = family()
    f.ledger.record_opening_balance(f.savings, "2000.00", date(2025, 12, 31))
    for month in (1, 2, 3):
        f.ledger.record_income(f.savings, f.salary, "500.00", date(2026, month, 5), "Guardado")
    goal = goals.add_goal(
        f.ledger,
        goals.Goal(
            name="Reserva",
            kind=goals.GoalKind.ACCOUNTS,
            target=D("6000.00"),
            target_date=date(2026, 12, 31),
            account_ids=(f.savings,),
            created_on=date(2026, 1, 1),
        ),
    )
    p = goals.progress(f.ledger, goal, date(2026, 3, 20))
    assert p.current == D("3500.00") and p.missing == D("2500.00") and p.share == D("0.5833")
    assert p.months_left == 9 and p.needed_per_month == D("277.78")
    assert p.pace == D("500.00") and p.reached_on_pace == YearMonth(year=2026, month=8)
    worth = goals.add_goal(
        f.ledger,
        goals.Goal(name="Patrimônio", kind=goals.GoalKind.NET_WORTH, target=D("1000.00"), created_on=date(2026, 1, 1)),
    )
    reached = goals.progress(f.ledger, worth, date(2026, 3, 20))
    assert reached.reached and reached.needed_per_month is None and reached.share == 1
    with pytest.raises(DomainError, match="contas"):
        goals.add_goal(
            f.ledger, goals.Goal(name="X", kind=goals.GoalKind.ACCOUNTS, target=D("1"), created_on=date(2026, 1, 1))
        )
    with pytest.raises(DomainError, match="futura"):
        goals.add_goal(
            f.ledger,
            goals.Goal(
                name="X",
                kind=goals.GoalKind.NET_WORTH,
                target=D("1"),
                target_date=date(2025, 1, 1),
                created_on=date(2026, 1, 1),
            ),
        )


# ── year end ─────────────────────────────────────────────


def test_year_end_summary() -> None:
    from opesvault.investments import service as inv
    from opesvault.investments.model import AssetClass

    f = family()
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2025, 6, 1))
    f.ledger.record_income(f.bank, f.salary, "5000.00", date(2026, 2, 5), "Salário")
    f.ledger.record_expense(f.bank, f.groceries, "300.00", date(2026, 2, 8), "Mercado")
    pos = inv.create_position(
        f.ledger, "Fundo", AssetClass.FIXED_INCOME, date(2026, 1, 2), initial_cost="2000", from_account=f.bank
    )
    inv.distribute(f.ledger, pos.id, "50.00", date(2026, 6, 30), f.bank, tax_withheld="7.50")
    inv.redeem(f.ledger, pos.id, date(2026, 9, 1), "1100.00", f.bank, cost_attributed="1000.00", tax_withheld="15.00")
    summary = annual.annual(f.ledger, 2026)
    balances = {b.name: (b.previous_year_end, b.year_end) for b in summary.balances}
    assert balances["Banco A"][0] == D("1000.00")
    assert summary.income[f.salary] == D("5000.00") and summary.expense_total >= D("300.00")
    assert summary.investment_income == D("50.00") and summary.tax_withheld == D("22.50")
    assert summary.realized_gains == D("100.00") and summary.incomplete_events == 0
    assert annual.annual(f.ledger, 2024).balances == []


# ── reminders and printable reports ──────────────────────


def test_backup_reminder() -> None:
    today = date(2026, 3, 31)
    assert alerts.backup_alert(None, today, configured=False)[0].title == "Faça um backup do cofre"
    assert "nenhum backup" in alerts.backup_alert(None, today, configured=True)[0].detail
    assert alerts.backup_alert(date(2026, 3, 20), today, configured=True) == []
    assert alerts.backup_alert(date(2026, 1, 31), today, configured=True)[0].title == "Último backup há 59 dias"


def test_monthly_and_annual_reports_escape_text_and_say_they_are_unencrypted() -> None:
    from opesvault.exports import WARNING, annual_report_html, monthly_report_html

    f = family()
    f.ledger.record_income(f.bank, f.salary, "5000.00", date(2026, 3, 5), "Salário")
    f.ledger.record_expense(f.bank, f.groceries, "300.00", date(2026, 3, 8), "<script>Mercado</script>")
    html = monthly_report_html(f.ledger, YearMonth(year=2026, month=3))
    assert WARNING in html and "março de 2026" in html and "R$ 5.000,00" in html
    assert "<script>" not in html and "Alimentação" in html
    member_view = monthly_report_html(f.ledger, YearMonth(year=2026, month=3), f.ana)
    assert "Visão de <b>Ana</b>" in member_view
    year = annual_report_html(f.ledger, 2026)
    assert "fechamento de 2026" in year and "Salário" in year and WARNING in year
    assert category(f.ledger, "Saúde")  # deductibles section renders even when empty
