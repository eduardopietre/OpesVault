"""Renders every page with synthetic demo data and saves PNG screenshots (UI review tool).

    uv run python scripts/capturar_telas.py [--out DIR] [--size 1280x800] [--dark]

Development only: the data is synthetic and nothing is saved to a vault.
"""

import argparse
import os
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))
# "offscreen" has no font database on Windows; "minimal:enable_fonts" renders with Segoe UI.
os.environ.setdefault("QT_QPA_PLATFORM", "minimal:enable_fonts" if sys.platform == "win32" else "offscreen")


def demo_session(path: Path):  # type: ignore[no-untyped-def]
    from opesvault.domain.cards import record_installment_purchase
    from opesvault.domain.model import AccountType
    from opesvault.domain.recurrence import RecurrenceRule, add_rule
    from opesvault.importing import pipeline
    from opesvault.importing.pipeline import ImportRequest
    from opesvault.investments import service as inv
    from opesvault.investments.model import AssetClass, ValueNature
    from opesvault.session import Session
    from tests import synthetic_docs as docs
    from tests.domain_fixtures import category, family

    f = family()
    ledger = f.ledger
    session = Session.new(path, "Família Silva")
    session.ledger = ledger
    ledger.record_opening_balance(f.bank, "8450.00", date(2026, 1, 1))
    ledger.record_opening_balance(f.joint, "2300.00", date(2026, 1, 1))
    names = ["Mercado Pão de Açúcar", "Farmácia São Paulo", "Posto Shell", "Restaurante Bom Prato", "Padaria Real"]
    cats = ["Alimentação", "Saúde", "Transporte", "Alimentação", "Alimentação"]
    for month in range(1, 4):
        ledger.record_income(f.bank, f.salary, "7800.00", date(2026, month, 5), "Salário")
        for i, (name, cat) in enumerate(zip(names, cats, strict=True)):
            ledger.record_card_purchase(
                f.card, category(ledger, cat), Decimal(37 + 23 * i + month), date(2026, month, 3 + i * 4), name
            )
        ledger.record_expense(f.bank, category(ledger, "Moradia"), "2350.00", date(2026, month, 10), "Aluguel")
    record_installment_purchase(ledger, f.card, category(ledger, "Lazer"), "2400.00", date(2026, 2, 14), "TV 55", 6)
    add_rule(
        ledger,
        RecurrenceRule(
            description="Aluguel",
            account_id=f.bank,
            counterpart_id=category(ledger, "Moradia"),
            amount=Decimal("2350.00"),
            tolerance=Decimal("0"),
            day=10,
            start=date(2026, 1, 1),
        ),
    )
    pos = inv.create_position(
        ledger, "CDB Banco X 2028", AssetClass.FIXED_INCOME, date(2026, 1, 2), initial_cost="5000", from_account=f.bank
    )
    for month, value in ((1, "5040"), (2, "5085"), (3, "5131")):
        inv.add_valuation(ledger, pos.id, date(2026, month, 28), value, ValueNature.GROSS)
    pipeline.import_document(session, ImportRequest("fatura-nubank-03.pdf", docs.nubank_card_pdf()))
    from opesvault.domain import budget
    from opesvault.domain.model import YearMonth
    from opesvault.importing import rules

    today = YearMonth.of(date.today())
    for name, value in (
        ("Alimentação", "600.00"),
        ("Moradia", "2350.00"),
        ("Transporte", "120.00"),
        ("Saúde", "60.00"),
    ):
        for month in (YearMonth(year=2026, month=3), today):
            budget.set_budget(ledger, category(ledger, name), month, value)
    ledger.record_expense(f.bank, category(ledger, "Transporte"), "145.00", date.today(), "Posto Shell")
    ledger.record_expense(f.bank, category(ledger, "Alimentação"), "560.00", date.today(), "Mercado do mês")
    rules.add_rule(ledger, "padaria", category(ledger, "Alimentação"))
    _demo_planning(f, ledger)
    _ = AccountType
    return session


def _demo_planning(f, ledger) -> None:  # type: ignore[no-untyped-def]
    """Loans, tags, reimbursements, bank checks, deductibles and a subscription (review of 03/10/2026)."""
    from opesvault.domain import balance_checks, deductibles, loans, sharing, tags
    from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount
    from tests.domain_fixtures import category

    debt = ledger.add_account(
        LedgerAccount(name="Financiamento do carro", type=AccountType.LIABILITY, subtype=AccountSubtype.LOAN)
    )
    plan = loans.create_loan(
        ledger,
        loans.LoanPlan(
            name="Financiamento do carro",
            liability_account_id=debt.id,
            payment_account_id=f.bank,
            interest_category_id=category(ledger, "Juros e encargos"),
            principal=Decimal("38000.00"),
            monthly_rate=Decimal("0.0149"),
            term=36,
            system=loans.AmortizationSystem.PRICE,
            first_due=date(2026, 1, 20),
        ),
        loans.Opening.OPENING_BALANCE,
        on=date(2025, 12, 20),
    )
    for number, day in ((1, date(2026, 1, 20)), (2, date(2026, 2, 20))):
        loans.pay_installment(ledger, plan.id, number, day)
    for month in range(1, 4):
        ledger.record_card_purchase(
            f.card, category(ledger, "Serviços e assinaturas"), "55.90", date(2026, month, 12), "NETFLIX.COM"
        )
    trip = [
        ledger.record_card_purchase(f.card, category(ledger, "Lazer"), "1380.00", date(2026, 2, 2), "Pousada Serra"),
        ledger.record_card_purchase(f.card, category(ledger, "Alimentação"), "412.30", date(2026, 2, 3), "Restaurante"),
        ledger.record_card_purchase(
            f.card, category(ledger, "Transporte"), "260.00", date(2026, 2, 4), "Pedágio e posto"
        ),
    ]
    tags.add_tag(ledger, [op.id for op in trip], "Viagem Serra 2026")
    consult = ledger.record_expense(
        f.bank, category(ledger, "Saúde"), "450.00", date(2026, 3, 6), "Consulta pediatra", member_id=f.bruno
    )
    reimbursement = sharing.request(ledger, consult.id, "Plano de saúde", "300.00", date(2026, 3, 7))
    sharing.receive(ledger, reimbursement.id, f.bank, "150.00", date(2026, 3, 25))
    deductibles.mark(ledger, category(ledger, "Saúde"), deductibles.DeductibleKind.HEALTH)
    deductibles.mark(ledger, category(ledger, "Educação"), deductibles.DeductibleKind.EDUCATION)
    balance_checks.record(ledger, f.bank, date(2026, 3, 31), "9000.00", "extrato do aplicativo")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=ROOT / "build" / "telas")
    parser.add_argument("--size", default="1280x800")
    parser.add_argument("--dark", action="store_true")
    args = parser.parse_args()
    width, height = (int(v) for v in args.size.split("x"))

    from PySide6.QtWidgets import QApplication

    app = QApplication(sys.argv)
    from opesvault.ui.theme import apply_theme

    apply_theme(app, dark=args.dark if args.dark else None)
    from opesvault.ui.main_window import MainWindow

    args.out.mkdir(parents=True, exist_ok=True)
    window = MainWindow()
    window.resize(width, height)
    window.show()
    app.processEvents()  # let layout and styles settle before the first capture
    window.grab().save(str(args.out / "00-sem-cofre.png"))
    window.session = demo_session(args.out / "demo.opesvault")
    window._refresh()
    for index, page in enumerate(window.pages):
        window.show_page(index)
        for _ in range(5):
            app.processEvents()
        slug = page.title.lower().replace(" ", "-")
        window.grab().save(str(args.out / f"{index + 1:02d}-{slug}.png"))
    window.lock_screen()
    app.processEvents()
    window.grab().save(str(args.out / "99-bloqueado.png"))
    print(f"Telas em {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
