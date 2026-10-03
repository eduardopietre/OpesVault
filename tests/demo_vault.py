"""A vault with synthetic data in every feature: screenshots and whole-window tests use it.

Development only: names, documents and numbers are invented; nothing is saved to disk.
"""

from datetime import date
from decimal import Decimal
from pathlib import Path


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
    session = Session.new(path, "Projeto Silva")
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
    _demo_tax(f, ledger)
    _demo_banking(f, ledger)
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
    from opesvault.domain import goals, merchants

    goals.add_goal(
        ledger,
        goals.Goal(
            name="Reserva de emergência",
            kind=goals.GoalKind.ACCOUNTS,
            target=Decimal("30000.00"),
            target_date=date(2027, 12, 31),
            account_ids=(f.bank, f.savings),
            created_on=date(2026, 1, 1),
        ),
    )
    merchants.name_merchant(ledger, "NETFLIX.COM", "Netflix")


def _demo_tax(f, ledger) -> None:  # type: ignore[no-untyped-def]
    """CPF/CNPJ, natures, a payslip and an informe, so the Imposto de renda page has content."""
    from opesvault.domain.model import AccountType
    from opesvault.tax import records
    from opesvault.tax.model import (
        IncomeKind,
        IncomeNature,
        NatureSubject,
        ReportField,
        ReportLine,
        ReportSource,
        TaxSubject,
    )
    from tests.domain_fixtures import category

    records.set_member_info(ledger, f.ana, cpf="529.982.247-25", birth_date=date(1985, 4, 2), declared_by=None)
    records.set_member_info(
        ledger, f.bruno, cpf="111.444.777-35", birth_date=date(2016, 8, 9), declared_by=f.ana, relation="Filho(a)"
    )
    records.classify(ledger, NatureSubject.CATEGORY, f.salary, IncomeNature.TAXABLE_PJ)
    records.set_identity(ledger, TaxSubject.CATEGORY, f.salary, "11.222.333/0001-81", "Empresa Exemplo Ltda")
    first = next(op for op in ledger.active_operations() if op.description == "Salário")
    records.set_income_detail(ledger, first.id, IncomeKind.SALARY, "9600.00", "1210.00", "908.86")
    records.set_identity(ledger, TaxSubject.ACCOUNT, f.bank, "11.222.333/0001-81", "Banco A S.A.")
    records.save_report(
        ledger,
        2026,
        ReportSource.ACCOUNT,
        f.bank,
        [ReportLine(field=ReportField.BALANCE_END, amount=Decimal("16052.00"), label="Saldo em 31/12/2026")],
        payer_tax_id="11.222.333/0001-81",
    )
    _ = (category, AccountType)


def _demo_banking(f, ledger) -> None:  # type: ignore[no-untyped-def]
    """The demo's bank and savings as one bank account, the CDB held there, and an LCA."""
    from opesvault.domain import banking
    from opesvault.investments import profile as prof
    from opesvault.investments import service as inv

    item = banking.build(
        name="Itaú da Ana",
        bank_code="341",
        bank_name=None,
        branch="0123",
        number="45678-9",
        holder_id=f.ana,
        co_holder_id=f.bruno,
    )
    item = banking.create(ledger, item, checking=f.bank, savings=f.savings)
    cdb = next(p for p in inv.positions(ledger).values())
    prof.save_profile(
        ledger,
        prof.InvestmentProfile(
            position_id=cdb.id,
            bank_account_id=item.id,
            irpf_group="04",
            irpf_code="02",
            issuer="Banco X S.A.",
            indexer=prof.Indexer.CDI,
            rate=Decimal("110"),
            applied_on=date(2026, 1, 2),
            maturity=date(2028, 1, 3),
            liquidity=prof.Liquidity.AT_MATURITY,
            tax=prof.TaxTreatment.WITHHELD,
            income_code="exclusivo:06",
            fgc=True,
        ),
    )
    nubank = banking.create(
        ledger,
        banking.build(
            name="Nubank do Bruno",
            bank_code="260",
            bank_name=None,
            branch="0001",
            number="9876543-2",
            holder_id=f.bruno,
        ),
        checking=True,
        opening={banking.Part.CHECKING: (Decimal("640.00"), date(2026, 1, 1))},
    )
    assert nubank.checking_id is not None
    banking.record_values(ledger, nubank.id, date(2026, 3, 31), {nubank.checking_id: "712.40"}, adjust=set())
