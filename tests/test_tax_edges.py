"""Edges of the income tax support (docs/09 §1.3 F): the guards of every tax record, the informe
reader field by field, what the app compares an informe with, the documents of the year, the
pendências and reminders, and the simplified/itemized simulation with hand-computed values.

Every rate and table here is typed by the test, as the user would (docs/00 §5)."""

from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from opesvault.catalogs import irpf
from opesvault.domain.alerts import Severity
from opesvault.domain.deductibles import DeductibleKind, mark
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount, YearMonth
from opesvault.investments.model import AssetClass
from opesvault.tax import checklist, declaration, issues, records, simulation, statements
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

from .domain_fixtures import Family, category, family
from .test_tax import CNPJ, CPF_ANA, CPF_BRUNO, Y, _salary_setup, _stock_setup

D = Decimal


def _income_category(f: Family, name: str, parent: UUID | None = None) -> LedgerAccount:
    return f.ledger.add_account(
        LedgerAccount(name=name, type=AccountType.INCOME, subtype=AccountSubtype.CATEGORY, parent_id=parent)
    )


def _unchanged(ledger: Ledger, action) -> object:  # type: ignore[no-untyped-def]
    """Runs `action` and checks that it wrote nothing (no new version, nothing to save)."""
    before = ledger.change_count
    result = action()
    assert ledger.change_count == before
    return result


def _table(**limits: object) -> TaxParameters:
    """Two brackets: exempt up to 5.000,00 and 10% above it with 500,00 to deduct (base × 10% − 500)."""
    return TaxParameters(
        year=Y,
        brackets=(
            Bracket(up_to=D("5000.00"), rate=D("0"), deduction=D("0")),
            Bracket(up_to=None, rate=D("0.10"), deduction=D("500.00")),
        ),
        **limits,  # type: ignore[arg-type]
    )


# ── catalogs.irpf ──────────


@pytest.mark.parametrize(
    ("group", "code", "label"),
    [
        (None, None, "a definir"),
        ("", "01", "a definir"),
        ("77", "01", "a definir"),  # a group the table does not have
        ("06", None, "06 — Depósitos à vista e numerário"),
        ("06", "", "06 — Depósitos à vista e numerário"),
        ("06", "01", "06.01 — Depósito em conta corrente ou conta pagamento"),
        ("04", "01", "04.01 — Depósito em conta poupança"),
        ("06", "55", "06.55 — código desconhecido"),
    ],
)
def test_asset_label_never_guesses_a_code(group: str | None, code: str | None, label: str) -> None:
    assert irpf.asset_label(group, code) == label


@pytest.mark.parametrize(
    ("group", "code", "valid"),
    [("01", "11", True), ("08", "01", True), ("99", "06", True), ("01", "04", False), ("09", "01", False)],
)
def test_asset_codes_come_only_from_the_table(group: str, code: str, valid: bool) -> None:
    assert irpf.is_asset_code(group, code) is valid


def test_investment_codes_leave_out_savings_and_goods() -> None:
    found = irpf.investment_codes()
    pairs = [(g, c) for g, c, _ in found]
    assert irpf.SAVINGS not in pairs  # savings is part of a bank account, not an investment
    assert ("04", "02") in pairs and ("07", "03") in pairs and ("08", "01") in pairs and ("99", "06") in pairs
    assert {g for g, _ in pairs} == {"04", "07", "03", "08", "99"}
    assert pairs[0][0] == "04"  # fixed income first, as the form lists it
    assert len(pairs) == sum(len(irpf.ASSET_CODES[g][1]) for g in ("04", "07", "03", "08", "99")) - 1
    assert all(description for _, _, description in found)


# ── records: CPF/CNPJ ──────────


def test_identity_needs_an_existing_account_or_a_merchant_name() -> None:
    f = family()
    with pytest.raises(DomainError, match="conta ou a categoria"):
        records.set_identity(f.ledger, TaxSubject.ACCOUNT, "Banco A", CNPJ)
    with pytest.raises(DomainError, match="conta ou a categoria"):
        records.set_identity(f.ledger, TaxSubject.CATEGORY, uuid4(), CNPJ)
    with pytest.raises(DomainError, match="estabelecimento"):
        records.set_identity(f.ledger, TaxSubject.MERCHANT, "   ", CNPJ)
    with pytest.raises(DomainError):
        records.set_identity(f.ledger, TaxSubject.MERCHANT, "CLINICA", "11.222.333/0001-80")  # bad check digit


def test_identity_is_updated_in_place_and_cleared() -> None:
    f = family()
    ledger = f.ledger
    first = records.set_identity(ledger, TaxSubject.ACCOUNT, f.bank, CNPJ, "  Banco   Exemplo  ")
    assert first.name == "Banco Exemplo" and first.tax_id == "11222333000181"
    same = _unchanged(ledger, lambda: records.set_identity(ledger, TaxSubject.ACCOUNT, f.bank, CNPJ, "Banco Exemplo"))
    assert same is first
    renamed = records.set_identity(ledger, TaxSubject.ACCOUNT, f.bank, CNPJ, "x" * 200)
    assert renamed.id == first.id and renamed.name == "x" * 150
    blank = records.set_identity(ledger, TaxSubject.ACCOUNT, f.bank, CPF_ANA, "   ")
    assert blank.id == first.id and blank.name is None and blank.tax_id == "52998224725"
    assert records.identity(ledger, TaxSubject.CATEGORY, f.bank) is None  # the subject is part of the key
    records.clear_identity(ledger, TaxSubject.ACCOUNT, f.bank)
    assert records.identity(ledger, TaxSubject.ACCOUNT, f.bank) is None
    _unchanged(ledger, lambda: records.clear_identity(ledger, TaxSubject.ACCOUNT, f.bank))


# ── records: people ──────────


def test_member_info_guards() -> None:
    f = family()
    ledger = f.ledger
    with pytest.raises(DomainError, match="Integrante inexistente"):
        records.set_member_info(ledger, uuid4(), cpf=None, birth_date=None, declared_by=None)
    with pytest.raises(DomainError, match="quem declara"):
        records.set_member_info(ledger, f.bruno, cpf=None, birth_date=None, declared_by=uuid4())
    with pytest.raises(DomainError, match="no futuro"):
        records.set_member_info(
            ledger, f.bruno, cpf=None, birth_date=date.today() + timedelta(days=1), declared_by=None
        )
    with pytest.raises(DomainError):
        records.set_member_info(ledger, f.bruno, cpf=CNPJ, birth_date=None, declared_by=None)  # a CNPJ is not a CPF
    carla = ledger.add_member("Carla").id
    records.set_member_info(ledger, f.bruno, cpf=None, birth_date=None, declared_by=f.ana)
    with pytest.raises(DomainError, match="não pode ser dependente na declaração"):
        records.set_member_info(ledger, carla, cpf=None, birth_date=None, declared_by=f.bruno)  # Bruno is a dependent


def test_member_info_declaring_oneself_files_alone() -> None:
    f = family()
    ledger = f.ledger
    info = records.set_member_info(
        ledger, f.ana, cpf="   ", birth_date=date(1985, 1, 1), declared_by=f.ana, relation="  " + "R" * 80
    )
    assert info.declared_by is None and info.cpf is None and info.relation == "R" * 60
    same = _unchanged(
        ledger,
        lambda: records.set_member_info(
            ledger, f.ana, cpf=None, birth_date=date(1985, 1, 1), declared_by=None, relation="R" * 60
        ),
    )
    assert same is info
    changed = records.set_member_info(ledger, f.ana, cpf=CPF_ANA, birth_date=None, declared_by=None, relation=" ")
    assert changed.id == info.id and changed.cpf == "52998224725" and changed.relation is None


def test_who_declares_others_cannot_become_a_dependent() -> None:
    f = family()
    ledger = f.ledger
    carla = ledger.add_member("Carla").id
    records.set_member_info(ledger, f.bruno, cpf=None, birth_date=None, declared_by=f.ana)
    with pytest.raises(DomainError, match="declara outras pessoas"):
        records.set_member_info(ledger, f.ana, cpf=None, birth_date=None, declared_by=carla)


def test_declarants_are_active_members_nobody_declares() -> None:
    f = family()
    ledger = f.ledger
    carla = ledger.add_member("carla")
    ledger.update_member(carla.model_copy(update={"active": False}), "saiu")
    records.set_member_info(ledger, f.bruno, cpf=CPF_BRUNO, birth_date=None, declared_by=f.ana)
    assert records.declarants(ledger) == [f.ana]
    assert records.dependents_of(ledger, f.ana) == [f.bruno] and records.dependents_of(ledger, f.bruno) == []
    assert records.people_of(ledger, None) is None
    assert records.people_of(ledger, f.bruno) == {f.bruno}


# ── records: income nature ──────────


def test_subcategory_follows_its_parents_nature() -> None:
    f = family()
    ledger = f.ledger
    rent = _income_category(f, "Aluguel")
    room = _income_category(f, "Aluguel do quarto", rent.id)
    assert records.nature_of(ledger, NatureSubject.CATEGORY, room.id) is None  # unknown, never guessed
    records.classify(ledger, NatureSubject.CATEGORY, rent.id, IncomeNature.CARNE_LEAO)
    assert records.nature_of(ledger, NatureSubject.CATEGORY, room.id) is IncomeNature.CARNE_LEAO
    records.classify(ledger, NatureSubject.CATEGORY, room.id, IncomeNature.EXEMPT)  # its own choice wins
    assert records.nature_of(ledger, NatureSubject.CATEGORY, room.id) is IncomeNature.EXEMPT
    assert records.nature_of(ledger, NatureSubject.CATEGORY, uuid4()) is None


def test_classify_guards_and_changes() -> None:
    f = family()
    ledger = f.ledger
    for ref in (f.groceries, f.bank, uuid4()):
        with pytest.raises(DomainError, match="categorias de receita"):
            records.classify(ledger, NatureSubject.CATEGORY, ref, IncomeNature.EXEMPT)
    with pytest.raises(DomainError, match="Investimento inexistente"):
        records.classify(ledger, NatureSubject.POSITION, f.bank, IncomeNature.EXEMPT)
    _unchanged(ledger, lambda: records.classify(ledger, NatureSubject.CATEGORY, f.salary, None))
    records.classify(ledger, NatureSubject.CATEGORY, f.salary, "taxable_pj")  # type: ignore[arg-type]  # from a combo
    assert records.nature_of(ledger, NatureSubject.CATEGORY, f.salary) is IncomeNature.TAXABLE_PJ
    _unchanged(ledger, lambda: records.classify(ledger, NatureSubject.CATEGORY, f.salary, IncomeNature.TAXABLE_PJ))
    [first] = records.classifications(ledger).values()
    records.classify(ledger, NatureSubject.CATEGORY, f.salary, IncomeNature.IGNORED)
    [only] = records.classifications(ledger).values()
    assert only.nature is IncomeNature.IGNORED and only.id == first.id
    records.classify(ledger, NatureSubject.CATEGORY, f.salary, None)
    assert not records.classifications(ledger)


def _position(f: Family, name: str = "CDB X", asset_class: AssetClass = AssetClass.FIXED_INCOME):  # type: ignore[no-untyped-def]
    from opesvault.investments import service as inv

    f.ledger.record_opening_balance(f.bank, "100000.00", date(Y - 1, 12, 1))
    return inv.create_position(
        f.ledger, name, asset_class, date(Y, 1, 2), initial_cost="10000", from_account=f.bank, holder_id=f.ana
    )


@pytest.mark.parametrize(
    ("tax", "income_code", "nature", "code"),
    [
        (None, None, None, None),
        ("exempt", None, IncomeNature.EXEMPT, None),
        ("withheld", None, IncomeNature.EXCLUSIVE, None),
        ("come_cotas", None, IncomeNature.EXCLUSIVE, None),
        ("variable", None, None, None),  # declared month by month, not as a nature
        ("pension", None, None, None),
        ("withheld", "isento:12", IncomeNature.EXEMPT, "12"),  # the income code wins over the treatment
        (None, "exclusivo:06", IncomeNature.EXCLUSIVE, "06"),
    ],
)
def test_investment_nature_comes_from_its_characteristics(
    tax: str | None, income_code: str | None, nature: IncomeNature | None, code: str | None
) -> None:
    from opesvault.investments.profile import InvestmentProfile, TaxTreatment, save_profile

    f = family()
    pos = _position(f)
    assert records.nature_of(f.ledger, NatureSubject.POSITION, pos.id) is None  # no characteristics yet
    assert records.income_code_of(f.ledger, pos.id) is None
    save_profile(
        f.ledger,
        InvestmentProfile(position_id=pos.id, tax=TaxTreatment(tax) if tax else None, income_code=income_code),
    )
    assert records.nature_of(f.ledger, NatureSubject.POSITION, pos.id) is nature
    assert records.income_code_of(f.ledger, pos.id) == code
    records.classify(f.ledger, NatureSubject.POSITION, pos.id, IncomeNature.IGNORED)  # the user's choice wins
    assert records.nature_of(f.ledger, NatureSubject.POSITION, pos.id) is IncomeNature.IGNORED


# ── records: payslip detail ──────────


@pytest.mark.parametrize(
    ("gross", "withheld", "social", "message"),
    [
        ("-1.00", None, None, "O valor bruto: informe um valor positivo"),
        ("5000.001", None, None, "O valor bruto: informe um valor positivo"),
        (None, "-0.01", None, "O imposto retido: informe um valor positivo"),
        ("mil reais", None, None, "O valor bruto: valor inválido."),  # a DomainError, not a bare MoneyError
        (None, None, "10.5", None),  # 10,50 is valid: no error
        ("3999.99", None, None, "menor que o valor recebido"),
    ],
)
def test_income_detail_money_guards(
    gross: str | None, withheld: str | None, social: str | None, message: str | None
) -> None:
    f = family()
    op = f.ledger.record_income(f.bank, f.salary, "4000.00", date(Y, 1, 5), "Salário")
    if message is None:
        detail = records.set_income_detail(f.ledger, op.id, IncomeKind.SALARY, gross, withheld, social)
        assert detail is not None and detail.social_security == D("10.5")
        return
    with pytest.raises(DomainError, match=message):
        records.set_income_detail(f.ledger, op.id, IncomeKind.SALARY, gross, withheld, social)


def test_income_detail_only_for_active_income() -> None:
    f = family()
    ledger = f.ledger
    with pytest.raises(DomainError, match="lançamento ativo"):
        records.set_income_detail(ledger, uuid4(), IncomeKind.SALARY, "1.00")
    spent = ledger.record_expense(f.bank, f.groceries, "50.00", date(Y, 1, 5), "Mercado")
    with pytest.raises(DomainError, match="Só receitas"):
        records.set_income_detail(ledger, spent.id, IncomeKind.SALARY, "60.00")
    op = ledger.record_income(f.bank, f.salary, "100.00", date(Y, 1, 5), "Salário")
    ledger.cancel_operation(op.id, "duplicado")
    with pytest.raises(DomainError, match="lançamento ativo"):
        records.set_income_detail(ledger, op.id, IncomeKind.SALARY, "120.00")


def test_income_detail_empty_fields_stay_unknown() -> None:
    f = family()
    ledger = f.ledger
    op = ledger.record_income(f.bank, f.salary, "4000.00", date(Y, 1, 5), "Salário")
    assert records.set_income_detail(ledger, op.id, IncomeKind.SALARY, "", " ", None) is None
    assert records.detail_of(ledger, op.id) is None
    first = records.set_income_detail(ledger, op.id, IncomeKind.SALARY, "5000.00", "", "550.00")
    assert first is not None and first.withheld is None  # empty is unknown, never zero
    same = _unchanged(
        ledger, lambda: records.set_income_detail(ledger, op.id, IncomeKind.SALARY, D("5000.00"), None, "550.00")
    )
    assert same is first
    changed = records.set_income_detail(ledger, op.id, IncomeKind.SALARY, "5000.00", "450.00", "550.00")
    assert changed is not None and changed.id == first.id and changed.withheld == D("450.00")
    # A 13º with nothing typed still says what the deposit is; a salary with nothing typed has no detail.
    thirteenth = records.set_income_detail(ledger, op.id, IncomeKind.THIRTEENTH)
    assert thirteenth is not None and thirteenth.kind is IncomeKind.THIRTEENTH and thirteenth.gross is None
    assert records.set_income_detail(ledger, op.id, IncomeKind.SALARY) is None
    assert not records.income_details(ledger)


# ── records: Bens e Direitos ──────────


def test_filing_checks_the_code_and_keeps_its_id() -> None:
    f = family()
    ledger = f.ledger
    with pytest.raises(DomainError, match="grupo do bem"):
        records.set_filing(ledger, FilingSubject.ACCOUNT, f.bank, "10", "01", "")
    with pytest.raises(DomainError, match="tabela de Bens e Direitos"):
        records.set_filing(ledger, FilingSubject.ACCOUNT, f.bank, "06", "02", "")
    first = records.set_filing(ledger, FilingSubject.ACCOUNT, f.bank, "06", "01", "  Conta   no  Banco A ")
    assert first.description == "Conta no Banco A"
    same = _unchanged(
        ledger, lambda: records.set_filing(ledger, FilingSubject.ACCOUNT, f.bank, "06", "01", "Conta no Banco A")
    )
    assert same is first
    changed = records.set_filing(ledger, FilingSubject.ACCOUNT, f.bank, "04", "01", "y" * 600)
    assert changed.id == first.id and changed.group == "04" and len(changed.description) == 512


@pytest.mark.parametrize(
    ("subtype", "asset_class", "group"),
    [
        (AccountSubtype.CHECKING, None, "06"),
        (AccountSubtype.CASH, None, "06"),
        (AccountSubtype.BROKERAGE_CASH, None, "06"),
        (AccountSubtype.SAVINGS, None, "04"),
        (AccountSubtype.LOAN, None, None),
        (AccountSubtype.SAVINGS, AssetClass.STOCK, "04"),  # the account's subtype is asked first
        (None, AssetClass.FIXED_INCOME, "04"),
        (None, AssetClass.TREASURY, "04"),
        (None, AssetClass.STOCK, "03"),
        (None, AssetClass.REIT, "07"),
        (None, AssetClass.FUND, "07"),
        (None, AssetClass.ETF, "07"),
        (None, AssetClass.CRYPTO, "08"),
        (None, None, None),
    ],
)
def test_suggested_group(subtype: AccountSubtype | None, asset_class: AssetClass | None, group: str | None) -> None:
    assert records.suggested_group(subtype, asset_class) == group


def _car(f: Family, **changes: object) -> DeclaredAsset:
    fields: dict[str, object] = {
        "name": "Carro",
        "group": "02",
        "code": "01",
        "owner_id": f.ana,
        "acquired_on": date(Y, 3, 1),
        "cost": D("60000.00"),
    }
    fields.update(changes)
    return DeclaredAsset(**fields)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"group": "10"}, "grupo do bem"),
        ({"code": "07"}, "tabela de Bens e Direitos"),
        ({"cost": D("-1.00")}, "custo de aquisição"),
        ({"cost": D("0.001")}, "custo de aquisição"),
        ({"sale_value": D("-5.00"), "sold_on": date(Y, 6, 1)}, "valor de venda"),
        ({"sold_on": date(Y, 2, 28)}, "antes da aquisição"),
        ({"owner_id": uuid4()}, "dono do bem"),
    ],
)
def test_declared_asset_guards(changes: dict[str, object], message: str) -> None:
    f = family()
    with pytest.raises(DomainError, match=message):
        records.save_declared_asset(f.ledger, _car(f, **changes))
    assert not records.declared_assets(f.ledger)


def test_declared_asset_is_corrected_and_removed() -> None:
    f = family()
    ledger = f.ledger
    car = records.save_declared_asset(ledger, _car(f, owner_id=None))  # nobody in particular is allowed
    sold = records.save_declared_asset(
        ledger, car.model_copy(update={"sold_on": date(Y, 3, 1), "sale_value": D("0.00")})
    )  # sold on the day it was bought, for nothing: both allowed
    assert sold.id == car.id and list(records.declared_assets(ledger).values()) == [sold]
    records.remove_declared_asset(ledger, car.id)
    assert not records.declared_assets(ledger)
    _unchanged(ledger, lambda: records.remove_declared_asset(ledger, car.id))


# ── records: informes ──────────


def test_report_guards() -> None:
    f = family()
    ledger = f.ledger
    line = ReportLine(field=ReportField.TAXABLE, amount=D("1.00"))
    with pytest.raises(DomainError, match="Ano inválido"):
        records.save_report(ledger, 1989, ReportSource.CATEGORY, f.salary, [line])
    with pytest.raises(DomainError, match="de quem é o informe"):
        records.save_report(ledger, Y, ReportSource.CATEGORY, uuid4(), [line])
    with pytest.raises(DomainError, match="conta do banco"):
        records.save_report(ledger, Y, ReportSource.ACCOUNT, f.salary, [line])
    with pytest.raises(DomainError, match="categoria de receita"):
        records.save_report(ledger, Y, ReportSource.CATEGORY, f.bank, [line])
    with pytest.raises(DomainError, match="reais e centavos"):
        records.save_report(
            ledger, Y, ReportSource.CATEGORY, f.salary, [ReportLine(field=ReportField.TAXABLE, amount=D("1.005"))]
        )
    loan = ledger.add_account(
        LedgerAccount(name="Financiamento", type=AccountType.LIABILITY, subtype=AccountSubtype.LOAN)
    )
    assert records.save_report(ledger, Y, ReportSource.ACCOUNT, loan.id, []).source_id == loan.id  # a creditor's


def test_report_is_corrected_in_place_and_removed() -> None:
    f = family()
    ledger = f.ledger
    first = records.save_report(
        ledger,
        Y,
        ReportSource.CATEGORY,
        f.salary,
        [ReportLine(field=ReportField.TAXABLE, amount=D("9000.00"))],
        payer_tax_id=CNPJ,
        payer_name="   ",
        note="  conferido  ",
    )
    assert first.payer_tax_id == "11222333000181" and first.payer_name is None and first.note == "conferido"
    fixed = records.save_report(
        ledger, Y, ReportSource.CATEGORY, f.salary, [], payer_name="Empresa", report_id=first.id
    )
    assert fixed.id == first.id and fixed.payer_tax_id is None and fixed.payer_name == "Empresa" and not fixed.lines
    other_year = records.save_report(ledger, Y - 1, ReportSource.CATEGORY, f.salary, [])
    assert [r.id for r in records.reports_of(ledger, Y)] == [first.id]
    records.remove_report(ledger, first.id)
    assert list(records.reports(ledger)) == [other_year.id]
    _unchanged(ledger, lambda: records.remove_report(ledger, first.id))


# ── records: parameters and rules ──────────


@pytest.mark.parametrize(
    ("brackets", "limits", "message"),
    [
        ((Bracket(up_to=D("10"), rate=D("0"), deduction=D("0")),) * 2, {}, "precisam crescer"),
        ((Bracket(up_to=None, rate=D("1.01"), deduction=D("0")),), {}, "Alíquota da faixa"),
        ((Bracket(up_to=None, rate=D("-0.01"), deduction=D("0")),), {}, "Alíquota da faixa"),
        ((Bracket(up_to=None, rate=D("0.1"), deduction=D("-1")),), {}, "parcela a deduzir"),
        ((Bracket(up_to=None, rate=D("0.1"), deduction=D("0.001")),), {}, "parcela a deduzir"),
        ((), {"simplified_rate": D("2")}, "Desconto simplificado"),
        ((), {"pension_cap_rate": D("1.5")}, "previdência privada"),
        ((), {"simplified_cap": D("-1")}, "teto do desconto simplificado"),
        ((), {"dependent_deduction": D("1.001")}, "dedução por dependente"),
        ((), {"education_cap": D("-0.01")}, "limite de educação"),
    ],
)
def test_parameter_guards(brackets: tuple[Bracket, ...], limits: dict[str, object], message: str) -> None:
    f = family()
    with pytest.raises(DomainError, match=message):
        records.set_parameters(f.ledger, TaxParameters(year=Y, brackets=brackets, **limits))  # type: ignore[arg-type]
    assert records.parameters(f.ledger, Y) is None


def test_parameters_are_one_per_year_and_kept_when_unchanged() -> None:
    f = family()
    ledger = f.ledger
    with pytest.raises(DomainError, match="Ano inválido"):
        records.set_parameters(ledger, TaxParameters.model_construct(year=1900, brackets=()))
    first = records.set_parameters(ledger, _table(simplified_rate=D("0.20")))
    same = _unchanged(ledger, lambda: records.set_parameters(ledger, _table(simplified_rate=D("0.20"))))
    assert same is first
    changed = records.set_parameters(ledger, _table(simplified_rate=D("0.25")))
    assert changed.id == first.id and records.parameters(ledger, Y) == changed
    assert records.parameters(ledger, Y + 1) is None


def test_variable_rules_in_force_on_a_date() -> None:
    f = family()
    ledger = f.ledger
    assert records.variable_rules(ledger) is None
    with pytest.raises(DomainError, match="Alíquota"):
        records.set_variable_rules(ledger, date(2020, 1, 1), [BucketRule(bucket=Bucket.COMMON, rate=D("15"))], "")
    with pytest.raises(DomainError, match="limite de vendas isentas"):
        records.set_variable_rules(
            ledger, date(2020, 1, 1), [BucketRule(bucket=Bucket.COMMON, exempt_sales_limit=D("-1"))], ""
        )
    old = records.set_variable_rules(ledger, date(2020, 1, 1), [BucketRule(bucket=Bucket.COMMON, rate=D("0.15"))], " ")
    assert old.source == "informado pelo usuário"
    new = records.set_variable_rules(
        ledger, date(2024, 7, 1), [BucketRule(bucket=Bucket.COMMON, rate=D("0.175"))], "lei"
    )
    assert records.variable_rules(ledger) == new  # without a date: the latest
    assert records.variable_rules(ledger, date(2024, 6, 30)) == old
    assert records.variable_rules(ledger, date(2024, 7, 1)) == new
    assert records.variable_rules(ledger, date(2019, 12, 31)) is None
    same = _unchanged(
        ledger,
        lambda: records.set_variable_rules(
            ledger, date(2024, 7, 1), [BucketRule(bucket=Bucket.COMMON, rate=D("0.175"))], "lei"
        ),
    )
    assert same is new
    fixed = records.set_variable_rules(ledger, date(2024, 7, 1), [], "lei corrigida")
    assert fixed.id == new.id and fixed.rules == () and fixed.source == "lei corrigida"


# ── records: DARF payments ──────────


def test_payment_guards() -> None:
    f = family()
    month = YearMonth(year=Y, month=3)
    for amount, message in (("0.00", "Informe o valor pago"), (None, "Informe o valor pago"), ("-1", "positivo")):
        with pytest.raises(DomainError, match=message):
            records.record_payment(f.ledger, PaymentPurpose.CARNE_LEAO, month, amount, date(Y, 4, 1), f.bank)
    for account in (f.card_account, f.salary, uuid4()):
        with pytest.raises(DomainError, match="de onde saiu"):
            records.record_payment(f.ledger, PaymentPurpose.CARNE_LEAO, month, "10.00", date(Y, 4, 1), account)
    assert not records.payments(f.ledger)


def test_payment_leaves_the_account_and_counts_for_its_person() -> None:
    from opesvault.domain import queries

    f = family()
    ledger = f.ledger
    march, april = YearMonth(year=Y, month=3), YearMonth(year=Y, month=4)
    paid = records.record_payment(ledger, PaymentPurpose.CARNE_LEAO, march, "100.00", date(Y, 4, 20), f.bank, f.ana)
    records.record_payment(ledger, PaymentPurpose.CARNE_LEAO, march, "30.00", date(Y, 4, 21), f.bank)  # nobody's
    records.record_payment(ledger, PaymentPurpose.VARIABLE_INCOME, march, "7.00", date(Y, 4, 21), f.bank)
    assert paid.operation_id is not None
    op = ledger.operations[paid.operation_id]
    assert op.description == "DARF do Carnê-Leão — 03/2025" and op.member_id == f.ana
    assert queries.balance(ledger, f.bank, date(Y, 12, 31)) == D("-137.00")
    assert records.paid(ledger, PaymentPurpose.CARNE_LEAO, march) == D("130.00")
    assert records.paid(ledger, PaymentPurpose.CARNE_LEAO, march, f.ana) == D("130.00")  # a payment of nobody counts
    assert records.paid(ledger, PaymentPurpose.CARNE_LEAO, march, f.bruno) == D("30.00")
    assert records.paid(ledger, PaymentPurpose.CARNE_LEAO, april) == 0
    assert simulation.carne_leao_paid(ledger, Y) == D("130.00")
    assert simulation.carne_leao_paid(ledger, Y + 1) == 0


# ── records: checklist marks ──────────


def test_checklist_mark_by_hand_and_back_to_automatic() -> None:
    f = family()
    ledger = f.ledger
    _unchanged(ledger, lambda: records.set_mark(ledger, Y, "bem:compra:x", None))
    records.set_mark(ledger, Y, "bem:compra:x", False, "  pedir ao cartório ")
    mark_ = records.mark_of(ledger, Y, "bem:compra:x")
    assert mark_ is not None and not mark_.received and mark_.note == "pedir ao cartório"
    _unchanged(ledger, lambda: records.set_mark(ledger, Y, "bem:compra:x", False, "pedir ao cartório"))
    records.set_mark(ledger, Y, "bem:compra:x", True, "")
    updated = records.mark_of(ledger, Y, "bem:compra:x")
    assert updated is not None and updated.id == mark_.id and updated.received and updated.note is None
    assert records.mark_of(ledger, Y + 1, "bem:compra:x") is None
    records.set_mark(ledger, Y, "bem:compra:x", None)
    assert not records.marks(ledger)


# ── statements: reading an informe ──────────


@pytest.mark.parametrize(
    ("line", "field"),
    [
        ("Saldo em 31/12/2024 1.000,00", ReportField.BALANCE_PREVIOUS),
        ("Saldo em 31/12/2025 R$ 1.000,00", ReportField.BALANCE_END),
        ("Saldo anterior em 31/12 1.000,00", ReportField.BALANCE_PREVIOUS),
        ("Saldo atual 31/12 1.000,00", ReportField.BALANCE_END),
        ("Contribuição previdenciária oficial 1.000,00", ReportField.SOCIAL_SECURITY),
        ("Previdência oficial 1.000,00", ReportField.SOCIAL_SECURITY),
        ("Previdência privada 1.000,00", None),  # not the official one: never guessed
        ("13º salário 1.000,00", ReportField.THIRTEENTH),
        ("13 salario 1.000,00", ReportField.THIRTEENTH),
        ("Décimo terceiro salário 1.000,00", ReportField.THIRTEENTH),
        ("IRRF sobre 13º salário 1.000,00", None),  # exclusive to the 13º: not the year's withholding
        ("Imposto sobre a renda retido na fonte 1.000,00", ReportField.WITHHELD),
        ("IRRF 1.000,00", ReportField.WITHHELD),
        ("Rendimentos sujeitos à tributação exclusiva 1.000,00", ReportField.EXCLUSIVE),
        ("Tributação definitiva 1.000,00", ReportField.EXCLUSIVE),
        ("Rendimentos isentos e não tributáveis 1.000,00", ReportField.EXEMPT),
        ("Lucros não tributáveis 1.000,00", ReportField.EXEMPT),
        ("Rendimentos tributáveis 1.000,00", ReportField.TAXABLE),
        ("Total dos rendimentos (inclusive férias) 1.000,00", ReportField.TAXABLE),
        ("Tarifa de manutenção 1.000,00", None),
    ],
)
def test_informe_field_of_each_line(line: str, field: ReportField | None) -> None:
    parsed = statements.parse(["Ano-calendário: 2025", line])
    assert parsed.year == Y
    if field is None:
        assert parsed.lines == [] and parsed.skipped == [line]
        return
    assert [(x.field, x.amount, x.label) for x in parsed.lines] == [(field, D("1000.00"), line)]
    assert parsed.skipped == []


def test_balance_year_without_the_calendar_year_is_the_years_end() -> None:
    parsed = statements.parse(["Saldo em 31/12/2024 1.000,00"])
    assert parsed.year is None and parsed.lines[0].field is ReportField.BALANCE_END


@pytest.mark.parametrize(
    ("header", "year"),
    [
        ("ANO-CALENDÁRIO 2025", 2025),
        ("Ano calendário de 2024", 2024),
        ("Exercício 2026", 2025),  # the return's year is the next one
        ("Exercício de 2026 Ano-calendário 2025", 2025),
        ("Ano-calendário 1980", None),  # out of range: unknown
        ("Exercício 3001", None),
        ("Informe de rendimentos", None),
    ],
)
def test_informe_year(header: str, year: int | None) -> None:
    assert statements.parse([header]).year == year


def test_informe_sections_totals_and_lines_left_out() -> None:
    lines: list[object] = [
        "Exercício 2026",
        "Banco Exemplo S.A. - CNPJ: 11.222.333/0001-81",
        123,  # not text: ignored
        "3. Rendimentos isentos e não tributáveis",
        "Poupança 12,34",
        "LCI 7,66",
        "Total 20,00",
        "4. Outras informações",
        "Tarifa 1,00",
        "Fundo X CNPJ 11.222.333/0001-81 50,00",  # an id with an amount: neither a field nor a skipped line
        "Saldo em 31/12/2025 -R$ 100,00",
        "Saldo em 31/12/2025 -R$ -5,00",  # conflicting signs: not an amount
        "Rendimentos tributáveis " + "x" * 130,  # a long line without an amount is no heading
        "Juros 3,00",
    ]
    parsed = statements.parse(lines)  # type: ignore[arg-type]
    assert parsed.year == Y
    assert parsed.payer_tax_id == "11222333000181" and parsed.payer_name == "Banco Exemplo S.A."
    assert [(x.field, x.amount) for x in parsed.lines] == [
        (ReportField.EXEMPT, D("20.00")),  # the total, not the items under it
        (ReportField.BALANCE_END, D("100.00")),  # amounts are kept positive
    ]
    assert parsed.skipped == ["Tarifa 1,00", "Juros 3,00"]


def test_informe_without_a_payer_name_before_the_cnpj() -> None:
    parsed = statements.parse([f"CNPJ: {CNPJ}"])
    assert parsed.payer_tax_id == "11222333000181" and parsed.payer_name is None
    assert statements.parse(["CNPJ: sem número"]).payer_tax_id is None


def test_informe_reads_only_the_first_lines() -> None:
    lines = ["Ano-calendário 2025"] + ["texto"] * (statements.MAX_LINES - 1) + ["Imposto retido 1,00"]
    assert statements.parse(lines).lines == []


@pytest.mark.parametrize("separator", [";", ","])
def test_informe_from_a_spreadsheet(separator: str) -> None:
    # The year in its own cell: the reader used to miss it ("ANO-CALENDARIO;2025" did not match).
    data = f'Ano-calendário{separator}2025\nImposto retido na fonte{separator}"45,67"\n'.encode()
    parsed = statements.read(data)
    assert parsed.year == Y
    assert [(x.field, x.amount) for x in parsed.lines] == [(ReportField.WITHHELD, D("45.67"))]


def test_informe_from_an_ofx_has_nothing_to_read() -> None:
    from . import synthetic_docs as docs

    assert statements.read(docs.ofx_bank()) == statements.ParsedReport(None, None, None)


def test_check_tolerates_one_cent_and_unknown_is_not_a_difference() -> None:
    assert statements.Check(ReportField.TAXABLE, D("10.00"), D("9.99")).matches
    assert not statements.Check(ReportField.TAXABLE, D("10.00"), D("9.98")).matches
    assert statements.Check(ReportField.TAXABLE, D("10.00"), D("9.98")).difference == D("0.02")
    unknown = statements.Check(ReportField.TAXABLE, D("10.00"), None)
    assert not unknown.matches and unknown.difference is None


# ── statements: what the app recorded for the same source ──────────


def test_payer_informe_is_compared_with_payslips_subcategories_and_the_13th() -> None:
    f = family()
    ledger = f.ledger
    bonus = _income_category(f, "Bônus", f.salary)
    other = _income_category(f, "Aluguel")
    jan = ledger.record_income(f.bank, f.salary, "4000.00", date(Y, 1, 5), "Salário")
    records.set_income_detail(ledger, jan.id, IncomeKind.SALARY, "5000.00", "450.00", "550.00")
    ledger.record_income(f.bank, f.salary, "4000.00", date(Y, 2, 5), "Salário")  # net only: counted as received
    ledger.record_income(f.bank, bonus.id, "1000.00", date(Y, 3, 5), "Bônus")
    dec = ledger.record_income(f.bank, f.salary, "2000.00", date(Y, 12, 20), "13º")
    records.set_income_detail(ledger, dec.id, IncomeKind.THIRTEENTH, "2400.00", "150.00", "200.00")
    ledger.record_income(f.bank, f.salary, "3000.00", date(Y - 1, 12, 20), "Salário")  # another year
    ledger.record_income(f.bank, other.id, "700.00", date(Y, 4, 1), "Aluguel")  # another payer
    ledger.record_expense(f.bank, f.groceries, "50.00", date(Y, 4, 2), "Mercado")
    report = records.save_report(
        ledger,
        Y,
        ReportSource.CATEGORY,
        f.salary,
        [
            ReportLine(field=ReportField.TAXABLE, amount=D("6000.00")),
            ReportLine(field=ReportField.TAXABLE, amount=D("4000.00")),
            ReportLine(field=ReportField.THIRTEENTH, amount=D("2400.00")),
            ReportLine(field=ReportField.WITHHELD, amount=D("450.00")),
            ReportLine(field=ReportField.SOCIAL_SECURITY, amount=D("550.01")),
            ReportLine(field=ReportField.EXEMPT, amount=D("10.00")),
        ],
    )
    assert statements.totals(report)[ReportField.TAXABLE] == D("10000.00")
    assert statements.recorded(ledger, report) == {
        ReportField.TAXABLE: D("10000.00"),  # 5.000 gross + 4.000 net-only + 1.000 of the subcategory
        ReportField.THIRTEENTH: D("2400.00"),  # its withholding and INSS are the 13º's own
        ReportField.WITHHELD: D("450.00"),
        ReportField.SOCIAL_SECURITY: D("550.00"),
    }
    checks = {c.field: c for c in statements.check(ledger, report)}
    assert checks[ReportField.EXEMPT].recorded is None  # nothing to compare with
    assert all(c.matches for k, c in checks.items() if k is not ReportField.EXEMPT)  # 1 cent apart still matches
    assert statements.differences(ledger, report) == []


def test_bank_informe_is_compared_with_investment_income() -> None:
    from opesvault.investments import service as inv
    from opesvault.investments.profile import InvestmentProfile, TaxTreatment, save_profile

    f = family()
    ledger = f.ledger
    ledger.record_opening_balance(f.bank, "100000.00", date(Y - 2, 12, 1))

    def open_(name: str):  # type: ignore[no-untyped-def]
        return inv.create_position(
            ledger,
            name,
            AssetClass.FIXED_INCOME,
            date(Y - 1, 6, 1),
            initial_cost="10000",
            from_account=f.bank,
            holder_id=f.ana,
        )

    cdb, lci, loose = open_("CDB"), open_("LCI"), open_("Debênture")
    save_profile(ledger, InvestmentProfile(position_id=cdb.id, tax=TaxTreatment.WITHHELD))
    save_profile(ledger, InvestmentProfile(position_id=lci.id, income_code="isento:12"))
    inv.distribute(ledger, lci.id, "100.00", date(Y, 3, 1), f.bank)
    inv.distribute(ledger, loose.id, "50.00", date(Y, 3, 1), f.bank, tax_withheld="5.00")
    inv.distribute(ledger, lci.id, "999.00", date(Y - 1, 9, 1), f.bank)  # last year
    inv.contribute(ledger, loose.id, "100.00", date(Y, 2, 1), f.bank)  # an aporte is not income
    inv.redeem(ledger, cdb.id, date(Y, 6, 1), "10500.00", f.bank, tax_withheld="75.00", final=True)
    report = records.save_report(
        ledger,
        Y,
        ReportSource.ACCOUNT,
        f.bank,
        [
            ReportLine(field=ReportField.EXEMPT, amount=D("100.00")),
            ReportLine(field=ReportField.EXCLUSIVE, amount=D("500.00")),
            ReportLine(field=ReportField.WITHHELD, amount=D("80.00")),
            ReportLine(field=ReportField.TAXABLE, amount=D("1.00")),
        ],
    )
    found = statements.recorded(ledger, report)
    assert found[ReportField.EXEMPT] == D("100.00")  # the LCI's provento
    assert found[ReportField.EXCLUSIVE] == D("500.00")  # the CDB's gain: 10.500 − 10.000
    assert found[ReportField.WITHHELD] == D("80.00")  # 75 on the CDB + 5 on the unclassified debênture
    assert ReportField.TAXABLE not in found
    diffs = statements.differences(ledger, report)
    assert [d.field for d in diffs] == []
    empty = records.save_report(ledger, Y, ReportSource.ACCOUNT, f.savings, [])
    assert set(statements.recorded(ledger, empty)) == {ReportField.BALANCE_END, ReportField.BALANCE_PREVIOUS}


# ── simulation ──────────


TWO = (
    Bracket(up_to=D("5000.00"), rate=D("0"), deduction=D("0")),
    Bracket(up_to=D("10000.00"), rate=D("0.10"), deduction=D("500.00")),
)


@pytest.mark.parametrize(
    ("brackets", "base", "tax"),
    [
        (TWO, D("0"), D("0")),
        (TWO, D("-10.00"), D("0")),
        ((), D("1000.00"), D("0")),
        (TWO, D("5000.00"), D("0")),  # on the limit: still the first bracket
        (TWO, D("5000.01"), D("0.00")),  # 500,001 − 500 rounds to zero
        (TWO, D("7000.00"), D("200.00")),
        (TWO, D("12000.00"), D("700.00")),  # above every limit: the last bracket's rate
        ((Bracket(up_to=None, rate=D("0.05"), deduction=D("0")),), D("100.10"), D("5.01")),  # 5,005: half up
        ((Bracket(up_to=None, rate=D("0.05"), deduction=D("0")),), D("100.30"), D("5.02")),  # 5,015
        ((Bracket(up_to=None, rate=D("0.10"), deduction=D("900.00")),), D("1000.00"), D("0")),  # never negative
    ],
)
def test_table_tax(brackets: tuple[Bracket, ...], base: Decimal, tax: Decimal) -> None:
    assert simulation.table_tax(brackets, base) == tax


def _expense(f: Family, name: str, kind: DeductibleKind) -> UUID:
    account = f.ledger.add_account(LedgerAccount(name=name, type=AccountType.EXPENSE, subtype=AccountSubtype.CATEGORY))
    mark(f.ledger, account.id, kind)
    return account.id


def _full_year() -> Family:
    """Ana declares Bruno. Taxable 70.000 (60.000 gross salary + 10.000 Carnê-Leão), every deduction kind."""
    f = family()
    ledger = f.ledger
    records.set_member_info(ledger, f.ana, cpf=CPF_ANA, birth_date=date(1985, 1, 1), declared_by=None)
    records.set_member_info(ledger, f.bruno, cpf=CPF_BRUNO, birth_date=date(2015, 1, 1), declared_by=f.ana)
    records.classify(ledger, NatureSubject.CATEGORY, f.salary, IncomeNature.TAXABLE_PJ)
    records.set_identity(ledger, TaxSubject.CATEGORY, f.salary, CNPJ, "Empresa")
    pay = ledger.record_income(f.bank, f.salary, "50000.00", date(Y, 1, 5), "Salário", member_id=f.ana)
    records.set_income_detail(ledger, pay.id, IncomeKind.SALARY, "60000.00", "5000.00", "6000.00")
    rent = _income_category(f, "Aluguel")
    records.classify(ledger, NatureSubject.CATEGORY, rent.id, IncomeNature.CARNE_LEAO)
    ledger.record_income(f.bank, rent.id, "10000.00", date(Y, 3, 1), "Aluguel", member_id=f.ana)
    records.record_payment(
        ledger, PaymentPurpose.CARNE_LEAO, YearMonth(year=Y, month=3), "200.00", date(Y, 4, 20), f.bank, f.ana
    )
    for name, kind, amount, who in (
        ("Médico", DeductibleKind.HEALTH, "3000.00", f.ana),
        ("Escola", DeductibleKind.EDUCATION, "4000.00", f.ana),
        ("Escola infantil", DeductibleKind.EDUCATION, "1000.00", f.bruno),
        ("PGBL", DeductibleKind.PENSION, "10000.00", f.ana),
        ("Pensão", DeductibleKind.ALIMONY, "2000.00", f.ana),
        ("Doação", DeductibleKind.DONATION, "500.00", f.ana),
        ("Outra dedução", DeductibleKind.OTHER, "300.00", f.ana),
    ):
        ledger.record_expense(f.bank, _expense(f, name, kind), amount, date(Y, 5, 2), name.upper(), member_id=who)
    return f


LIMITS: dict[str, Decimal] = {
    "simplified_rate": D("0.20"),
    "simplified_cap": D("16754.34"),
    "dependent_deduction": D("2275.08"),
    "education_cap": D("3561.50"),
    "pension_cap_rate": D("0.12"),
}


def test_itemized_return_with_every_limit() -> None:
    f = _full_year()
    records.set_parameters(f.ledger, _table(**LIMITS))
    found = simulation.compare(f.ledger, Y, f.ana)
    assert found.taxable == D("70000.00") and found.withheld == D("5200.00")  # IRRF + Carnê-Leão paid
    assert found.deductions == {
        "Previdência oficial (INSS)": D("6000.00"),
        "Despesas médicas": D("3000.00"),
        "Instrução (até o limite por pessoa)": D("4561.50"),  # 3.561,50 (capped) + 1.000,00
        "Previdência privada (até o limite)": D("8400.00"),  # 12% of 70.000, below the 10.000 paid
        "Pensão alimentícia": D("2000.00"),
        "Dependentes (1)": D("2275.08"),
    }
    assert found.left_out == {"Doações (deduzidas do imposto)": D("500.00"), "Outras": D("300.00")}
    assert found.missing == []
    assert found.itemized == simulation.Model("Completa", D("26236.58"), D("43763.42"), D("3876.34"))
    # 20% of 70.000 = 14.000, under the cap; (70.000 − 14.000) × 10% − 500
    assert found.simplified == simulation.Model("Simplificada", D("14000.00"), D("56000.00"), D("5100.00"))
    assert found.best is found.itemized
    assert found.balance(found.itemized) == D("-1323.66")  # refund
    assert found.balance(found.simplified) == D("-100.00")


def test_simplified_discount_stops_at_the_cap() -> None:
    f = _full_year()
    records.set_parameters(f.ledger, _table(**{**LIMITS, "simplified_cap": D("10000.00")}))
    found = simulation.compare(f.ledger, Y, f.ana)
    assert found.simplified == simulation.Model("Simplificada", D("10000.00"), D("60000.00"), D("5500.00"))


def test_missing_limits_make_the_affected_model_unknown() -> None:
    f = _full_year()
    records.set_parameters(f.ledger, _table())
    found = simulation.compare(f.ledger, Y, f.ana)
    assert found.missing == [
        "o limite anual de educação",
        "o limite da previdência privada",
        "a dedução por dependente",
        "o desconto simplificado (percentual e teto)",
    ]
    assert found.itemized == simulation.Model("Completa", None, None, None)
    assert found.simplified == simulation.Model("Simplificada", None, None, None)
    assert found.best is None and found.balance(found.itemized) is None and found.balance(None) is None
    assert "Instrução (até o limite por pessoa)" not in found.deductions


def test_without_the_years_table_nothing_is_computed() -> None:
    f = _full_year()
    found = simulation.compare(f.ledger, Y, f.ana)
    assert found.missing[0] == "a tabela anual de 2025"
    assert found.simplified is None and found.itemized is None and found.best is None
    records.set_parameters(f.ledger, TaxParameters(year=Y, **LIMITS))  # type: ignore[arg-type]  # limits, no brackets
    found = simulation.compare(f.ledger, Y, f.ana)
    assert found.missing == ["a tabela anual de 2025"] and found.itemized is None


def test_only_one_model_known_has_no_best() -> None:
    f = _full_year()
    records.set_parameters(f.ledger, _table(**{**LIMITS, "simplified_rate": None}))
    found = simulation.compare(f.ledger, Y, f.ana)
    assert found.itemized is not None and found.itemized.tax == D("3876.34")
    assert found.best is None


def test_the_whole_project_has_no_dependents_to_deduct() -> None:
    f = _full_year()
    records.set_parameters(f.ledger, _table(**LIMITS))
    found = simulation.compare(f.ledger, Y, None)
    assert not any(label.startswith("Dependentes") for label in found.deductions)


# ── checklist: documents of the year ──────────


def test_documents_of_the_year() -> None:
    from opesvault.domain import sharing

    f = family()
    ledger = f.ledger
    ledger.record_opening_balance(f.bank, "1000.00", date(Y - 1, 6, 1))
    ledger.record_opening_balance(f.card_account, "-100.00", date(Y, 2, 1))  # a card: no informe
    wallet = ledger.add_account(LedgerAccount(name="Carteira", type=AccountType.ASSET, subtype=AccountSubtype.CASH))
    ledger.record_opening_balance(wallet.id, "50.00", date(Y, 2, 1))
    brunos = ledger.add_account(
        LedgerAccount(
            name="Conta do Bruno", type=AccountType.ASSET, subtype=AccountSubtype.CHECKING, holders=(f.bruno,)
        )
    )
    ledger.record_opening_balance(brunos.id, "10.00", date(Y, 2, 1))
    loan = ledger.add_account(
        LedgerAccount(name="Financiamento", type=AccountType.LIABILITY, subtype=AccountSubtype.LOAN, holders=(f.ana,))
    )
    ledger.record_opening_balance(loan.id, "-20000.00", date(Y, 3, 1))
    car = records.save_declared_asset(ledger, _car(f, acquired_on=date(Y - 2, 1, 1), sold_on=date(Y, 8, 1)))
    moto = records.save_declared_asset(ledger, _car(f, name="Moto", owner_id=f.bruno))
    records.save_declared_asset(ledger, _car(f, name="Lancha", owner_id=None, acquired_on=date(Y - 1, 1, 1)))
    # Paid last year, reimbursed this year: nothing paid in the year, no receipts to ask for.
    health = _expense(f, "Saúde", DeductibleKind.HEALTH)
    op = ledger.record_expense(f.bank, health, "800.00", date(Y - 1, 11, 2), "CLINICA", member_id=f.ana)
    item = sharing.request(ledger, op.id, "Plano", "800.00")
    sharing.receive(ledger, item.id, f.bank, "800.00", date(Y, 1, 20))

    everyone = {i.key: i for i in checklist.expected(ledger, Y)}
    assert set(everyone) == {
        f"informe:conta:{f.bank}",
        f"informe:conta:{brunos.id}",
        f"divida:{loan.id}",
        f"bem:venda:{car.id}",
        f"bem:compra:{moto.id}",  # the Lancha was bought last year and nobody owns it
    }
    debt = everyone[f"divida:{loan.id}"]
    assert debt.title == "Saldo devedor em 31/12 — Financiamento" and debt.action == "report" and not debt.received
    titles = sorted(i.title for i in everyone.values() if i.action == "mark")
    assert titles == ["Documento de compra — Moto", "Documento de venda — Carro"]

    anas = {i.key for i in checklist.expected(ledger, Y, {f.ana})}
    assert f"informe:conta:{brunos.id}" not in anas and f"divida:{loan.id}" in anas
    assert not any("Moto" in k for k in anas)
    records.save_report(ledger, Y, ReportSource.ACCOUNT, loan.id, [])
    items = checklist.expected(ledger, Y, {f.ana})
    assert next(i for i in items if i.key == f"divida:{loan.id}").received
    assert [i.key for i in checklist.missing(items)] == [f"informe:conta:{f.bank}", f"bem:venda:{car.id}"]


# ── issues: pendências ──────────


def _found(ledger: Ledger, declarant: object = None, today: date = date(Y + 1, 3, 1)) -> dict[str, issues.Issue]:
    return {i.title: i for i in issues.issues(ledger, Y, declarant, today)}  # type: ignore[arg-type]


def test_people_without_cpf_or_birth_date() -> None:
    f = family()
    ledger = f.ledger
    assert not any(i.action == "member" for i in _found(ledger).values())  # the whole project: nobody to check
    records.set_member_info(ledger, f.bruno, cpf=None, birth_date=None, declared_by=f.ana)
    found = _found(ledger, f.ana)
    assert found["CPF: Ana"] == issues.Issue(Severity.URGENT, "CPF: Ana", "Declarante sem CPF", "member", f.ana)
    assert found["CPF: Bruno"].detail == "Dependente sem CPF"
    records.set_member_info(ledger, f.bruno, cpf=CPF_BRUNO, birth_date=None, declared_by=f.ana)
    records.set_member_info(ledger, f.ana, cpf=CPF_ANA, birth_date=None, declared_by=None)
    found = _found(ledger, f.ana)
    assert "CPF: Ana" not in found and "CPF: Bruno" not in found
    assert "Data de nascimento: Ana" not in found  # asked only of dependents
    assert found["Data de nascimento: Bruno"] == issues.Issue(
        Severity.INFO, "Data de nascimento: Bruno", "pedida na ficha de dependentes", "member", f.bruno
    )


def test_payers_without_cnpj() -> None:
    f = family()
    ledger = f.ledger
    records.classify(ledger, NatureSubject.CATEGORY, f.salary, IncomeNature.TAXABLE_PJ)
    ledger.record_income(f.bank, f.salary, "4000.00", date(Y, 1, 5), "Salário", member_id=f.ana)
    grant = _income_category(f, "Bolsa")
    records.classify(ledger, NatureSubject.CATEGORY, grant.id, IncomeNature.EXEMPT)
    ledger.record_income(f.bank, grant.id, "300.00", date(Y, 2, 5), "Bolsa", member_id=f.ana)
    found = _found(ledger)
    assert found["CNPJ da fonte pagadora: Salário"] == issues.Issue(
        Severity.URGENT,
        "CNPJ da fonte pagadora: Salário",
        "obrigatório na ficha de rendimentos",
        "identity",
        (TaxSubject.CATEGORY, f.salary),
    )
    assert found["CNPJ da fonte: Bolsa"] == issues.Issue(
        Severity.INFO,
        "CNPJ da fonte: Bolsa",
        "pedido na ficha de isentos e exclusivos",
        "identity",
        (TaxSubject.CATEGORY, grant.id),
    )
    assert found["Bruto, imposto retido e INSS: Salário"].detail.startswith("1 depósito(s)")
    records.set_identity(ledger, TaxSubject.CATEGORY, f.salary, CNPJ, "Empresa")
    records.set_identity(ledger, TaxSubject.CATEGORY, grant.id, CNPJ)
    found = _found(ledger)
    assert not any(t.startswith("CNPJ da fonte") for t in found)


def test_income_of_nobody_is_left_out_of_a_declarants_return() -> None:
    f = family()
    ledger = f.ledger
    records.classify(ledger, NatureSubject.CATEGORY, f.salary, IncomeNature.TAXABLE_PJ)
    ledger.record_income(f.joint, f.salary, "100.00", date(Y, 1, 5), "Depósito")  # joint account, no member
    assert "Receitas sem integrante" not in _found(ledger)  # the whole project sees it
    issue = _found(ledger, f.ana)["Receitas sem integrante"]
    assert issue.detail.startswith("1 lançamento(s)") and issue.action == "ledger"


def test_fully_reimbursed_payment_needs_no_receipt_nor_cpf() -> None:
    from opesvault.domain import sharing

    f = family()
    ledger = f.ledger
    health = category(ledger, "Saúde")
    mark(ledger, health, DeductibleKind.HEALTH)
    op = ledger.record_expense(f.bank, health, "800.00", date(Y, 5, 2), "CLINICA SORRISO", member_id=f.ana)
    assert "Comprovante não anexado: Clinica Sorriso" in _found(ledger)
    item = sharing.request(ledger, op.id, "Plano", "800.00")
    sharing.receive(ledger, item.id, f.bank, "800.00", date(Y, 5, 20))
    found = _found(ledger)
    assert not any("Clinica Sorriso" in t for t in found)


def test_assets_without_cost_code_or_institution() -> None:
    from opesvault.investments import service as inv

    f = family()
    ledger = f.ledger
    ledger.record_opening_balance(f.bank, "1000.00", date(Y - 1, 6, 1))
    pos = inv.create_position(ledger, "Ações antigas", AssetClass.STOCK, date(Y - 3, 1, 1), reference_value="5000")
    found = _found(ledger)
    assert found["Custo de aquisição desconhecido: Ações antigas"] == issues.Issue(
        Severity.SOON,
        "Custo de aquisição desconhecido: Ações antigas",
        "Bens e Direitos usa o custo, não o valor de mercado",
        "investments",
        pos.id,
    )
    assert found["Grupo e código do bem: Ações antigas"].ref == ("position", pos.id)
    assert found["CNPJ da instituição: Banco A"].ref == (TaxSubject.ACCOUNT, f.bank)
    records.set_identity(ledger, TaxSubject.ACCOUNT, f.bank, CNPJ)
    records.set_filing(ledger, FilingSubject.ACCOUNT, f.bank, "06", "01", "Conta")
    found = _found(ledger)
    assert "CNPJ da instituição: Banco A" not in found and "Grupo e código do bem: Banco A" not in found


def test_informe_with_nothing_recorded_says_zero_was_recorded() -> None:
    """Bug: a field the app recorded as zero was shown as 'registrado' with the informe's own value."""
    f = family()
    records.save_report(
        f.ledger, Y, ReportSource.CATEGORY, f.salary, [ReportLine(field=ReportField.TAXABLE, amount=D("1000.00"))]
    )
    issue = _found(f.ledger)["Informe diferente do registrado: Salário"]
    assert issue.detail == "Rendimentos tributáveis: informe R$ 1.000,00, registrado R$ 0,00"
    assert issue.severity is Severity.URGENT and issue.action == "report"


def test_missing_documents_and_incomplete_simulation() -> None:
    f = family()
    ledger = f.ledger
    ledger.record_opening_balance(f.bank, "1000.00", date(Y - 1, 6, 1))
    found = _found(ledger)
    assert found["1 documento(s) ainda não recebido(s)"].action == "checklist"
    assert found["Simulação incompleta"].detail == "falta informar a tabela anual de 2025"
    records.set_mark(ledger, Y, f"informe:conta:{f.bank}", True)
    records.set_parameters(ledger, _table(simplified_rate=D("0.20"), simplified_cap=D("16754.34")))
    found = _found(ledger)
    assert not any("documento(s)" in t for t in found) and "Simulação incompleta" not in found


def test_variable_income_darf_before_and_after_its_due_date() -> None:
    from opesvault.investments import trades

    f, pos = _stock_setup()
    ledger = f.ledger
    records.set_variable_rules(
        ledger,
        date(2000, 1, 1),
        [BucketRule(bucket=Bucket.COMMON, rate=D("0.15"), exempt_sales_limit=D("20000.00"))],
        "",
    )
    trades.sell(ledger, pos.id, date(Y, 4, 10), "1000", "30.00", f.bank)  # 30.000 sold, +10.000: 1.500 due
    title = "DARF de renda variável 04/2025"
    before = _found(ledger, today=date(Y, 5, 30))[title]
    assert before.severity is Severity.SOON and before.detail == "valor de R$ 1.500,00; vence em 30/05/2025"
    assert before.ref == ("variable_income", YearMonth(year=Y, month=4))
    after = _found(ledger, today=date(Y, 5, 31))[title]
    assert after.severity is Severity.URGENT and after.detail == "valor de R$ 1.500,00; venceu em 30/05/2025"
    records.record_payment(
        ledger, PaymentPurpose.VARIABLE_INCOME, YearMonth(year=Y, month=4), "1000.00", date(Y, 5, 20), f.bank
    )
    assert _found(ledger, today=date(Y, 5, 31))[title].detail == "valor de R$ 500,00; venceu em 30/05/2025"
    records.record_payment(
        ledger, PaymentPurpose.VARIABLE_INCOME, YearMonth(year=Y, month=4), "500.00", date(Y, 5, 21), f.bank
    )
    assert title not in _found(ledger, today=date(Y, 5, 31))


def test_carne_leao_paid_is_no_longer_pending() -> None:
    f = family()
    ledger = f.ledger
    rent = _income_category(f, "Aluguel")
    records.classify(ledger, NatureSubject.CATEGORY, rent.id, IncomeNature.CARNE_LEAO)
    ledger.record_income(f.bank, rent.id, "1500.00", date(Y, 3, 1), "Aluguel", member_id=f.ana)
    soon = _found(ledger, today=date(Y, 4, 30))["Carnê-Leão 03/2025: Ana"]
    assert soon.severity is Severity.SOON and "o DARF vence em 30/04/2025" in soon.detail
    late = _found(ledger, today=date(Y, 5, 1))["Carnê-Leão 03/2025: Ana"]
    assert late.severity is Severity.URGENT and "o DARF venceu em 30/04/2025" in late.detail
    assert late.ref == ("carne_leao", YearMonth(year=Y, month=3), f.ana)
    records.record_payment(
        ledger, PaymentPurpose.CARNE_LEAO, YearMonth(year=Y, month=3), "10.00", date(Y, 4, 20), f.bank, f.ana
    )
    assert "Carnê-Leão 03/2025: Ana" not in _found(ledger, today=date(Y, 5, 1))


def test_issues_are_sorted_by_severity_and_cached_until_a_change() -> None:
    f = _salary_setup()
    ledger = f.ledger
    first = issues.issues(ledger, Y, None, date(Y + 1, 3, 1))
    order = [i.severity for i in first]
    rank = {Severity.URGENT: 0, Severity.SOON: 1, Severity.INFO: 2}
    assert order == sorted(order, key=rank.__getitem__)
    assert issues.issues(ledger, Y, None, date(Y + 1, 3, 1)) is first
    assert issues.issues(ledger, Y, None, date(Y + 1, 3, 2)) is not first  # another day
    records.set_identity(ledger, TaxSubject.ACCOUNT, f.bank, CNPJ)
    again = issues.issues(ledger, Y, None, date(Y + 1, 3, 1))
    assert again is not first and len(again) == len(first) - 1


# ── reminders for the Atenção panel ──────────


def test_no_reminders_before_any_tax_record() -> None:
    f = family()
    rent = _income_category(f, "Aluguel")
    f.ledger.record_income(f.bank, rent.id, "1500.00", date(Y, 3, 1), "Aluguel", member_id=f.ana)
    assert not issues.engaged(f.ledger)
    assert issues.reminders(f.ledger, date(Y, 4, 20), 15) == []


def test_variable_income_reminder_inside_the_window() -> None:
    from opesvault.investments import trades

    f, pos = _stock_setup()
    ledger = f.ledger
    trades.sell(ledger, pos.id, date(Y, 4, 10), "1000", "30.00", f.bank)
    # Stocks but no tax record yet: the DARF is unknown without a rate, so nothing to remind.
    assert not issues.engaged(ledger)
    assert issues.reminders(ledger, date(Y, 5, 20), 15) == []
    records.set_variable_rules(ledger, date(2000, 1, 1), [BucketRule(bucket=Bucket.COMMON, rate=D("0.15"))], "")
    soon = issues.reminders(ledger, date(Y, 5, 20), 15)
    assert soon == [
        (
            Severity.SOON,
            "DARF de renda variável 04/2025",
            "R$ 1.500,00",
            date(Y, 5, 30),
            ("variable_income", YearMonth(year=Y, month=4)),
        )
    ]
    assert issues.reminders(ledger, date(Y, 5, 20), 15) is soon  # cached
    assert issues.reminders(ledger, date(Y, 5, 10), 15) == []  # 30/05 is beyond the horizon
    late = issues.reminders(ledger, date(Y, 6, 5), 15)
    assert [(r[0], r[1]) for r in late] == [(Severity.URGENT, "DARF de renda variável 04/2025")]
    assert issues.reminders(ledger, date(Y, 7, 15), 15) == []  # older than the lookback: history


def test_carne_leao_reminder_once_paid_is_gone() -> None:
    f = family()
    ledger = f.ledger
    rent = _income_category(f, "Aluguel")
    records.classify(ledger, NatureSubject.CATEGORY, rent.id, IncomeNature.CARNE_LEAO)
    ledger.record_income(f.bank, rent.id, "1500.00", date(Y, 8, 1), "Aluguel", member_id=f.ana)
    [late] = issues.reminders(ledger, date(Y, 10, 1), 15)
    assert late[0] is Severity.URGENT and late[1] == "Carnê-Leão 08/2025: Ana" and late[3] == date(Y, 9, 30)
    assert late[2] == "R$ 1.500,00 recebido(s) de pessoa física ou do exterior"
    records.record_payment(
        ledger, PaymentPurpose.CARNE_LEAO, YearMonth(year=Y, month=8), "50.00", date(Y, 9, 29), f.bank, f.ana
    )
    assert issues.reminders(ledger, date(Y, 10, 1), 15) == []


@pytest.mark.parametrize(
    ("today", "shown"),
    [(date(Y + 1, 1, 31), False), (date(Y + 1, 2, 1), True), (date(Y + 1, 5, 31), True), (date(Y + 1, 6, 1), False)],
)
def test_season_reminder_counts_the_years_pending_items(today: date, shown: bool) -> None:
    f = family()
    ledger = f.ledger
    records.classify(ledger, NatureSubject.CATEGORY, f.salary, IncomeNature.TAXABLE_PJ)
    ledger.record_income(f.bank, f.salary, "4000.00", date(Y, 1, 5), "Salário", member_id=f.ana)
    found = [r for r in issues.reminders(ledger, today, 15) if r[4] == ("year", Y)]
    if not shown:
        assert found == []
        return
    pending = [i for i in issues.issues(ledger, Y, None, today) if i.severity is not Severity.INFO]
    assert len(pending) == 1  # the payer's CNPJ
    assert found == [
        (
            Severity.INFO,
            "Declaração de 2025: 1 pendência(s)",
            "CPF/CNPJ, comprovantes, informes e natureza dos rendimentos",
            today,
            ("year", Y),
        )
    ]


def test_season_reminder_needs_pending_items() -> None:
    f = family()
    records.set_mark(f.ledger, Y, "qualquer", True)  # engaged, nothing urgent
    assert issues.engaged(f.ledger)
    assert issues.reminders(f.ledger, date(Y + 1, 3, 1), 15) == []


def test_payee_with_cnpj_and_receipts_is_complete(tmp_path: Path) -> None:
    from opesvault.domain import attachments
    from opesvault.session import Session

    f = _full_year()
    ledger = f.ledger
    session = Session.new(tmp_path / "x.opesvault")
    session.ledger = ledger
    found = _found(ledger, f.ana)
    assert not any(t.startswith(("CNPJ da fonte pagadora", "Bruto, imposto retido")) for t in found)
    health = next(r for r in declaration.payments(ledger, Y) if r.kind is DeductibleKind.HEALTH)
    assert f"Comprovante não anexado: {health.payee}" in found
    attachments.attach(session, health.operations[0], "recibo.pdf", b"%PDF-1.4\n%recibo\n")
    records.set_identity(ledger, TaxSubject.MERCHANT, health.payee_key, CNPJ, "Clínica")
    found = _found(ledger, f.ana)
    assert not any(t.endswith((health.payee, "Clínica")) for t in found)
    item = next(i for i in checklist.expected(ledger, Y, {f.ana}) if i.title == "Recibos e notas — Clínica")
    assert item.received and item.detail == "1 de 1 pagamento(s) com comprovante anexado."
