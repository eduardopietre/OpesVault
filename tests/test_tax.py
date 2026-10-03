"""Support for the income tax return (docs/09 §1.3 F): ids, sheets, statements, checklist, issues,
variable income and the simplified/itemized simulation. All rates and tables are typed by the test."""

from datetime import date
from decimal import Decimal

import pytest

from opesvault.domain.deductibles import DeductibleKind, mark
from opesvault.domain.ledger import DomainError
from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount, YearMonth
from opesvault.tax import checklist, declaration, ids, issues, records, simulation, statements, variable_income
from opesvault.tax.model import (
    Bracket,
    Bucket,
    BucketRule,
    DeclaredAsset,
    FilingSubject,
    IncomeKind,
    IncomeNature,
    NatureSubject,
    PaymentPurpose,
    ReportField,
    ReportLine,
    ReportSource,
    TaxParameters,
    TaxSubject,
)

from . import synthetic_docs as docs
from .domain_fixtures import category, family

CNPJ = "11.222.333/0001-81"
CPF_ANA = "529.982.247-25"
CPF_BRUNO = "111.444.777-35"
Y = 2025


def test_tax_ids_check_digits() -> None:
    assert ids.is_cpf(CPF_ANA) and ids.is_cnpj(CNPJ)
    assert not ids.is_cpf("529.982.247-24") and not ids.is_cnpj("11.222.333/0001-80")
    assert not ids.is_cpf("111.111.111-11")
    assert ids.normalize(CNPJ) == "11222333000181"
    assert ids.display("52998224725") == CPF_ANA
    with pytest.raises(DomainError):
        ids.normalize("123")
    with pytest.raises(DomainError):
        ids.normalize(CNPJ, (ids.TaxIdKind.CPF,))
    assert ids.find_cnpj(f"Banco - CNPJ {CNPJ}") == "11222333000181"


def _salary_setup():  # type: ignore[no-untyped-def]
    f = family()
    ledger = f.ledger
    records.classify(ledger, NatureSubject.CATEGORY, f.salary, IncomeNature.TAXABLE_PJ)
    records.set_identity(ledger, TaxSubject.CATEGORY, f.salary, CNPJ, "Empresa Exemplo Ltda")
    jan = ledger.record_income(f.bank, f.salary, "4000.00", date(Y, 1, 5), "Salário", member_id=f.ana)
    records.set_income_detail(ledger, jan.id, IncomeKind.SALARY, "5000.00", "450.00", "550.00")
    dec = ledger.record_income(f.bank, f.salary, "2000.00", date(Y, 12, 20), "13º", member_id=f.ana)
    records.set_income_detail(ledger, dec.id, IncomeKind.THIRTEENTH, "2400.00", "150.00", None)
    ledger.record_income(f.bank, f.salary, "4000.00", date(Y, 2, 5), "Salário", member_id=f.ana)  # net only
    return f


def test_taxable_income_by_payer_uses_payslip_gross() -> None:
    f = _salary_setup()
    found = declaration.income(f.ledger, Y)
    [row] = found.taxable
    assert row.tax_id == "11222333000181" and row.payer == "Empresa Exemplo Ltda"
    assert row.taxable == Decimal("9000.00")  # 5000 gross + 4000 net-only
    assert row.withheld == Decimal("450.00") and row.social_security == Decimal("550.00")
    assert row.thirteenth == Decimal("2400.00") and row.thirteenth_withheld == Decimal("150.00")
    assert row.net_only == 1
    with pytest.raises(DomainError):
        records.set_income_detail(f.ledger, row.operations[0], IncomeKind.SALARY, "100.00")  # gross < received


def test_unclassified_income_is_flagged_not_guessed() -> None:
    f = family()
    rent = f.ledger.add_account(
        LedgerAccount(name="Aluguel recebido", type=AccountType.INCOME, subtype=AccountSubtype.CATEGORY)
    )
    f.ledger.record_income(f.bank, rent.id, "1500.00", date(Y, 3, 1), "Aluguel", member_id=f.ana)
    found = declaration.income(f.ledger, Y)
    assert [r.source for r in found.unclassified] == ["Aluguel recebido"]
    titles = [i.title for i in issues.issues(f.ledger, Y, None, date(Y + 1, 3, 1))]
    assert "Natureza do rendimento: Aluguel recebido" in titles
    records.classify(f.ledger, NatureSubject.CATEGORY, rent.id, IncomeNature.CARNE_LEAO)
    found = declaration.income(f.ledger, Y)
    assert not found.unclassified
    [month] = found.carne_leao
    assert month.month == YearMonth(year=Y, month=3) and month.amount == Decimal("1500.00") and month.paid == 0
    found_issues = issues.issues(f.ledger, Y, None, date(Y, 4, 10))
    assert any(i.title.startswith("Carnê-Leão 03/2025") for i in found_issues)
    records.record_payment(
        f.ledger, PaymentPurpose.CARNE_LEAO, YearMonth(year=Y, month=3), "100.00", date(Y, 4, 20), f.bank, f.ana
    )
    assert declaration.income(f.ledger, Y).carne_leao[0].paid == Decimal("100.00")


def test_payments_show_paid_and_reimbursed_parts_per_payee() -> None:
    from opesvault.domain import sharing

    f = family()
    ledger = f.ledger
    health = category(ledger, "Saúde")
    mark(ledger, health, DeductibleKind.HEALTH)
    op = ledger.record_expense(f.bank, health, "800.00", date(Y, 5, 2), "CLINICA SORRISO LTDA", member_id=f.bruno)
    ledger.record_expense(f.bank, health, "200.00", date(Y, 6, 2), "CLINICA SORRISO LTDA", member_id=f.bruno)
    item = sharing.request(ledger, op.id, "Plano de saúde", "300.00")
    sharing.receive(ledger, item.id, f.bank, "300.00", date(Y, 5, 20))
    [row] = declaration.payments(ledger, Y)
    assert row.paid == Decimal("1000.00") and row.not_deductible == Decimal("300.00") and row.net == Decimal("700.00")
    assert row.beneficiary_id == f.bruno and row.without_receipt == 2 and row.tax_id is None
    found = issues.issues(ledger, Y, None, date(Y + 1, 3, 1))
    assert any(i.title == f"CPF/CNPJ de quem recebeu: {row.payee}" for i in found)
    records.set_identity(ledger, TaxSubject.MERCHANT, row.payee_key, CNPJ)
    assert declaration.payments(ledger, Y)[0].tax_id == "11222333000181"


def test_assets_at_cost_and_debts_on_december_31() -> None:
    from opesvault.investments import service as inv
    from opesvault.investments.model import AssetClass, ValueNature

    f = family()
    ledger = f.ledger
    ledger.record_opening_balance(f.bank, "3000.00", date(Y - 1, 6, 1))
    pos = inv.create_position(
        ledger,
        "CDB X",
        AssetClass.FIXED_INCOME,
        date(Y, 2, 1),
        initial_cost="5000",
        from_account=f.bank,
        holder_id=f.ana,
    )
    inv.add_valuation(ledger, pos.id, date(Y, 12, 31), "5400", ValueNature.GROSS)
    car = records.save_declared_asset(
        ledger,
        DeclaredAsset(
            name="Carro", group="02", code="01", owner_id=f.ana, acquired_on=date(Y, 3, 1), cost=Decimal("60000.00")
        ),
    )
    loan = ledger.add_account(
        LedgerAccount(name="Financiamento", type=AccountType.LIABILITY, subtype=AccountSubtype.LOAN, holders=(f.ana,))
    )
    ledger.record_opening_balance(loan.id, "-20000.00", date(Y, 3, 1))
    rows = {r.name: r for r in declaration.assets(ledger, Y)}
    assert rows["CDB X"].current == Decimal("5000.00")  # cost, not the 5400 market value
    assert rows["CDB X"].previous == 0 and rows["CDB X"].suggested and rows["CDB X"].group == "04"
    assert rows["Carro"].current == Decimal("60000.00") and rows["Carro"].previous == 0
    assert rows["Banco A"].previous == Decimal("3000.00")
    records.set_filing(ledger, FilingSubject.POSITION, pos.id, "04", "02", "CDB do Banco X")
    assert next(r for r in declaration.assets(ledger, Y) if r.name == "CDB X").suggested is False
    [debt] = declaration.debts(ledger, Y)
    assert debt.name == "Financiamento" and abs(debt.current) == Decimal("20000.00")
    assert car.id in records.declared_assets(ledger)


def test_declarant_sees_own_and_dependents_items() -> None:
    f = _salary_setup()
    ledger = f.ledger
    records.set_member_info(ledger, f.ana, cpf=CPF_ANA, birth_date=date(1985, 1, 1), declared_by=None)
    records.set_member_info(
        ledger, f.bruno, cpf=CPF_BRUNO, birth_date=date(2015, 1, 1), declared_by=f.ana, relation="Filho(a)"
    )
    assert records.declarants(ledger) == [f.ana]
    assert records.people_of(ledger, f.ana) == {f.ana, f.bruno}
    with pytest.raises(DomainError):
        records.set_member_info(ledger, f.ana, cpf=CPF_BRUNO, birth_date=None, declared_by=None)  # CPF already used
    with pytest.raises(DomainError):
        records.set_member_info(ledger, f.ana, cpf=CPF_ANA, birth_date=None, declared_by=f.bruno)  # declares someone
    [dependent] = declaration.dependents(ledger, f.ana)
    assert dependent.cpf == "11144477735"
    other = ledger.add_member("Carla").id
    ledger.record_income(f.bank, f.salary, "100.00", date(Y, 3, 5), "Bico", member_id=other)
    assert len(declaration.income(ledger, Y, records.people_of(ledger, f.ana)).taxable) == 1


def test_informe_is_read_and_checked_against_the_records() -> None:
    f = family()
    ledger = f.ledger
    parsed = statements.read(docs.bank_income_report_pdf(Y))
    assert parsed.year == Y and parsed.payer_tax_id == "11222333000181"
    fields = {line.field: line.amount for line in parsed.lines}
    assert fields[ReportField.BALANCE_PREVIOUS] == Decimal("1000.00")
    assert fields[ReportField.BALANCE_END] == Decimal("2500.00")
    assert fields[ReportField.EXEMPT] == Decimal("12.34")
    assert fields[ReportField.WITHHELD] == Decimal("10.26")
    ledger.record_opening_balance(f.bank, "1000.00", date(Y - 1, 1, 2))
    ledger.record_income(f.bank, f.salary, "1400.00", date(Y, 6, 1), "Depósito")
    report = records.save_report(
        ledger, Y, ReportSource.ACCOUNT, f.bank, parsed.lines, payer_tax_id=parsed.payer_tax_id
    )
    diffs = statements.differences(ledger, report)
    assert [d.field for d in diffs] == [ReportField.BALANCE_END]  # 2.500 informed, 2.400 recorded
    assert diffs[0].difference == Decimal("100.00")
    with pytest.raises(DomainError):
        records.save_report(ledger, Y, ReportSource.ACCOUNT, f.bank, [])  # one per source and year
    found = issues.issues(ledger, Y, None, date(Y + 1, 3, 1))
    assert any(i.title == "Informe diferente do registrado: Banco A" for i in found)


def test_parser_never_raises_on_garbage() -> None:
    parsed = statements.parse(["", "R$ ,00", "Saldo em 31/12/abcd 1,00", "x" * 5000, "CNPJ 00.000.000/0000-00"])
    assert parsed.payer_tax_id is None
    assert all(line.amount >= 0 for line in parsed.lines)


def test_checklist_lists_informes_and_receipts() -> None:
    f = _salary_setup()
    ledger = f.ledger
    items = {i.key: i for i in checklist.expected(ledger, Y)}
    assert f"informe:conta:{f.bank}" in items and f"informe:fonte:{f.salary}" in items
    assert not items[f"informe:conta:{f.bank}"].received
    records.save_report(
        ledger, Y, ReportSource.CATEGORY, f.salary, [ReportLine(field=ReportField.TAXABLE, amount=Decimal("9000.00"))]
    )
    items = {i.key: i for i in checklist.expected(ledger, Y)}
    assert items[f"informe:fonte:{f.salary}"].received
    records.set_mark(ledger, Y, f"informe:conta:{f.bank}", True)
    items = {i.key: i for i in checklist.expected(ledger, Y)}
    assert items[f"informe:conta:{f.bank}"].received and items[f"informe:conta:{f.bank}"].by_hand


def _stock_setup():  # type: ignore[no-untyped-def]
    from opesvault.investments import service as inv
    from opesvault.investments import trades
    from opesvault.investments.model import AssetClass, TrackingMode

    f = family()
    ledger = f.ledger
    ledger.record_opening_balance(f.bank, "100000.00", date(Y - 1, 12, 1))
    pos = inv.create_position(
        ledger, "PETR4", AssetClass.STOCK, date(Y, 1, 2), mode=TrackingMode.QUANTITY, holder_id=f.ana
    )
    trades.buy(ledger, pos.id, date(Y, 1, 2), "1000", "20.00", f.bank)
    return f, pos


def test_variable_income_exemption_losses_and_day_trade() -> None:
    from opesvault.investments import trades

    f, pos = _stock_setup()
    ledger = f.ledger
    records.set_variable_rules(
        ledger,
        date(2000, 1, 1),
        [
            BucketRule(bucket=Bucket.COMMON, rate=Decimal("0.15"), exempt_sales_limit=Decimal("20000.00")),
            BucketRule(bucket=Bucket.DAY_TRADE, rate=Decimal("0.20")),
        ],
        "teste",
    )
    trades.sell(ledger, pos.id, date(Y, 2, 10), "100", "25.00", f.bank)  # 2.500 in sales, +500: exempt
    trades.sell(ledger, pos.id, date(Y, 3, 10), "500", "18.00", f.bank)  # -1.000: loss carried
    trades.sell(ledger, pos.id, date(Y, 4, 10), "400", "70.00", f.bank)  # 28.000 sales, +20.000 taxable
    trades.buy(ledger, pos.id, date(Y, 5, 5), "100", "10.00", f.bank)
    trades.sell(ledger, pos.id, date(Y, 5, 5), "100", "12.00", f.bank)  # day trade +200
    rows = {(r.month.month, r.bucket): r for r in variable_income.months(ledger, Y)}
    feb, mar, apr = rows[(2, Bucket.COMMON)], rows[(3, Bucket.COMMON)], rows[(4, Bucket.COMMON)]
    assert feb.exempt_gain == Decimal("500.00") and feb.tax == 0
    assert mar.result == Decimal("-1000.00") and mar.loss_carried == Decimal("1000.00")
    assert apr.compensated == Decimal("1000.00") and apr.base == Decimal("19000.00")
    assert apr.tax == Decimal("2850.00") and apr.due_date == date(Y, 5, 30)
    day = rows[(5, Bucket.DAY_TRADE)]
    assert day.result == Decimal("200.00") and day.tax == Decimal("40.00") and day.approximate
    due = variable_income.due_by_month(list(rows.values()))
    assert due[YearMonth(year=Y, month=4)][0] == Decimal("2850.00")
    records.record_payment(
        ledger, PaymentPurpose.VARIABLE_INCOME, YearMonth(year=Y, month=4), "2850.00", date(Y, 5, 20), f.bank
    )
    due = variable_income.due_by_month(variable_income.months(ledger, Y))
    assert due[YearMonth(year=Y, month=4)][1] == Decimal("2850.00")


def test_variable_income_without_rate_is_unknown_not_zero() -> None:
    from opesvault.investments import trades

    f, pos = _stock_setup()
    trades.sell(f.ledger, pos.id, date(Y, 4, 10), "1000", "30.00", f.bank)
    [row] = variable_income.months(f.ledger, Y)
    assert row.base == Decimal("10000.00") and row.tax is None and row.due is None and row.missing_rate
    assert any(i.title == "Alíquotas de renda variável" for i in issues.issues(f.ledger, Y, None, date(Y + 1, 3, 1)))


def test_simplified_and_itemized_with_the_users_table() -> None:
    f = _salary_setup()
    ledger = f.ledger
    health = category(ledger, "Saúde")
    mark(ledger, health, DeductibleKind.HEALTH)
    ledger.record_expense(f.bank, health, "3000.00", date(Y, 5, 2), "Hospital", member_id=f.ana)
    comparison = simulation.compare(ledger, Y, None)
    assert comparison.simplified is None and "a tabela anual de 2025" in comparison.missing
    records.set_parameters(
        ledger,
        TaxParameters(
            year=Y,
            brackets=(
                Bracket(up_to=Decimal("5000.00"), rate=Decimal("0"), deduction=Decimal("0")),
                Bracket(up_to=None, rate=Decimal("0.10"), deduction=Decimal("500.00")),
            ),
            simplified_rate=Decimal("0.20"),
            simplified_cap=Decimal("1000.00"),
        ),
    )
    comparison = simulation.compare(ledger, Y, None)
    assert comparison.taxable == Decimal("9000.00") and comparison.withheld == Decimal("450.00")
    assert comparison.deductions == {
        "Previdência oficial (INSS)": Decimal("550.00"),
        "Despesas médicas": Decimal("3000.00"),
    }
    assert comparison.simplified is not None and comparison.simplified.tax == Decimal("300.00")  # 8000*10%-500
    assert comparison.itemized is not None and comparison.itemized.tax == Decimal("45.00")  # 5450*10%-500
    assert comparison.best is comparison.itemized
    assert comparison.balance(comparison.itemized) == Decimal("-405.00")
    with pytest.raises(DomainError):
        records.set_parameters(
            ledger,
            TaxParameters(
                year=Y,
                brackets=(
                    Bracket(up_to=None, rate=Decimal("0.1"), deduction=Decimal("0")),
                    Bracket(up_to=Decimal("1"), rate=Decimal("0"), deduction=Decimal("0")),
                ),
            ),
        )


def test_tax_reminders_reach_the_attention_panel() -> None:
    from opesvault.domain.alerts import Target, alerts

    f = family()
    rent = f.ledger.add_account(
        LedgerAccount(name="Aluguel recebido", type=AccountType.INCOME, subtype=AccountSubtype.CATEGORY)
    )
    records.classify(f.ledger, NatureSubject.CATEGORY, rent.id, IncomeNature.CARNE_LEAO)
    f.ledger.record_income(f.bank, rent.id, "1500.00", date(2026, 8, 1), "Aluguel", member_id=f.ana)
    found = [a for a in alerts(f.ledger, date(2026, 9, 25)) if a.target is Target.TAX]
    assert [a.title for a in found] == ["Carnê-Leão 08/2026: Ana"]
    assert found[0].due_on == date(2026, 9, 30)


def test_tax_records_survive_save_and_undo() -> None:
    from opesvault.domain.ledger import Ledger

    f = _salary_setup()
    restored = Ledger.from_records(f.ledger.to_records())
    assert declaration.income(restored, Y).taxable[0].tax_id == "11222333000181"


def test_report_for_the_return_lists_the_sheets() -> None:
    from opesvault.exports import tax_report_html

    f = _salary_setup()
    html = tax_report_html(f.ledger, Y, None)
    assert "Empresa Exemplo Ltda" in html and "11.222.333/0001-81" in html
    assert "Bens e direitos" in html and "Pendências" in html
