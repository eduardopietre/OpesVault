"""Bank accounts (bank, branch, number, holders, parts), values at a date and investment
characteristics, with the embedded lists (COMPE banks, IRPF codes)."""

from datetime import date
from decimal import Decimal

import pytest

from opesvault.catalogs import bank, banks, search
from opesvault.catalogs.irpf import ASSET_CODES, CHECKING, SAVINGS, investment_codes, is_asset_code
from opesvault.domain import balance_checks, banking, queries
from opesvault.domain.ledger import DomainError
from opesvault.domain.model import AccountSubtype
from opesvault.investments import profile as prof
from opesvault.investments import service as inv
from opesvault.investments.model import AssetClass
from opesvault.tax import declaration, ids, records
from opesvault.tax.model import IncomeNature, NatureSubject, TaxSubject

from .domain_fixtures import family


def test_bank_list_is_complete_and_consistent() -> None:
    listed = banks()
    assert len(listed) > 400
    assert len({b.code for b in listed}) == len(listed)
    assert all(len(b.code) == 3 and b.code.isdigit() for b in listed)
    assert all(not b.cnpj or ids.is_cnpj(b.cnpj) for b in listed)
    itau = bank("341")
    assert itau is not None and itau.cnpj == "60701190000104"
    assert bank("1") is not None and bank("1").code == "001"  # type: ignore[union-attr]
    assert any(b.code == "260" for b in search("nu pagamentos"))
    assert bank("999") is None or bank("999").code == "999"  # type: ignore[union-attr]


def test_irpf_codes() -> None:
    assert CHECKING == ("06", "01") and SAVINGS == ("04", "01")
    assert is_asset_code("04", "02") and is_asset_code("07", "03") and is_asset_code("99", "06")
    assert not is_asset_code("04", "77")
    assert set(ASSET_CODES) == {"01", "02", "03", "04", "05", "06", "07", "08", "99"}
    assert ("04", "01", ASSET_CODES["04"][1]["01"]) not in investment_codes()  # savings is a part, not an investment


def _bank(f, *, joint: bool = False, savings: bool = True):  # type: ignore[no-untyped-def]
    item = banking.build(
        name="Itaú da Ana",
        bank_code="341",
        bank_name=None,
        branch="0123",
        number="45678-X",
        holder_id=f.ana,
        co_holder_id=f.bruno if joint else None,
    )
    return banking.create(
        f.ledger,
        item,
        checking=True,
        savings=savings,
        opening={banking.Part.CHECKING: (Decimal("1000.00"), date(2025, 1, 2))},
    )


def test_bank_account_creates_its_parts_with_holders_and_cnpj() -> None:
    f = family()
    item = _bank(f, joint=True)
    ledger = f.ledger
    assert item.bank_name == "ITAÚ UNIBANCO S.A." and item.where == "ITAÚ UNIBANCO S.A. (341), ag. 0123, conta 45678-X"
    checking = ledger.account(item.checking_id)  # type: ignore[arg-type]
    savings = ledger.account(item.savings_id)  # type: ignore[arg-type]
    assert checking.subtype is AccountSubtype.CHECKING and savings.subtype is AccountSubtype.SAVINGS
    assert checking.holders == (f.ana, f.bruno)  # first holder first
    assert queries.balance(ledger, checking.id, date(2025, 1, 31)) == Decimal("1000.00")
    found = records.identity(ledger, TaxSubject.ACCOUNT, checking.id)
    assert found is not None and found.tax_id == "60701190000104"
    rows = {r.ref: r for r in declaration.assets(ledger, 2025)}
    assert (rows[checking.id].group, rows[checking.id].code, rows[checking.id].suggested) == ("06", "01", False)
    assert "ag. 0123" in rows[checking.id].description


def test_bank_account_rules() -> None:
    f = family()
    with pytest.raises(DomainError):
        banking.build(name="x", bank_code="341", bank_name=None, branch="01 23", number="1", holder_id=f.ana)
    with pytest.raises(DomainError):
        banking.build(name="x", bank_code="000", bank_name=None, branch="1", number="1", holder_id=f.ana)
    item = banking.build(
        name="", bank_code=None, bank_name="Cooperativa Local", branch="A1/b", number="#9", holder_id=f.ana
    )
    assert item.bank_code is None and item.branch == "A1/b" and item.number == "#9"
    same = banking.build(
        name="x", bank_code="341", bank_name=None, branch="1", number="1", holder_id=f.ana, co_holder_id=f.ana
    )
    with pytest.raises(DomainError):
        banking.create(f.ledger, same, checking=True)
    first = _bank(f, savings=False)
    other = banking.build(name="y", bank_code="001", bank_name=None, branch="1", number="2", holder_id=f.ana)
    with pytest.raises(DomainError):  # one ledger account belongs to one bank account
        banking.create(f.ledger, other, checking=first.checking_id)  # type: ignore[arg-type]
    updated = banking.update(f.ledger, first.model_copy(update={"co_holder_id": f.bruno}), add=(banking.Part.SAVINGS,))
    assert updated.savings_id is not None
    assert f.ledger.account(updated.checking_id).holders == (f.ana, f.bruno)  # type: ignore[arg-type]


def test_values_at_a_date_check_adjust_and_value_investments() -> None:
    f = family()
    ledger = f.ledger
    item = _bank(f)
    pos = inv.create_position(
        ledger,
        "CDB Itaú",
        AssetClass.FIXED_INCOME,
        date(2025, 2, 1),
        initial_cost="5000",
        from_account=item.checking_id,
    )
    prof.save_profile(
        ledger, prof.InvestmentProfile(position_id=pos.id, bank_account_id=item.id, irpf_group="04", irpf_code="02")
    )
    assert banking.positions_of(ledger, item.id) == [pos.id]
    checking, savings = item.checking_id, item.savings_id
    assert checking is not None and savings is not None
    on = date(2025, 6, 30)
    before = {v.ref: v.value for v in banking.values_at(ledger, item.id, on)}
    assert before[checking] == Decimal("-4000.00") and before[savings] == 0
    done = banking.record_values(
        ledger,
        item.id,
        on,
        {checking: "2500.00", savings: "300.00", pos.id: "5210.00"},
        adjust={savings},
    )
    assert (done.checks, done.adjustments, done.valuations) == (2, 1, 1)
    after = {v.ref: v.value for v in banking.values_at(ledger, item.id, on)}
    assert after[savings] == Decimal("300.00")  # adjusted: reports and net worth follow
    assert after[checking] == Decimal("-4000.00")  # only checked: the difference stays visible
    assert after[pos.id] == Decimal("5210.00")
    [check] = [c for c in balance_checks.results(ledger, item.checking_id)]
    assert check.difference == Decimal("6500.00")
    banking.record_values(ledger, item.id, on, {pos.id: "5300.00"})  # same day again: corrected, not duplicated
    assert {v.ref: v.value for v in banking.values_at(ledger, item.id, on)}[pos.id] == Decimal("5300.00")
    with pytest.raises(DomainError):
        banking.record_values(ledger, item.id, date(2999, 1, 1), {pos.id: "1"})


def test_investment_characteristics_feed_the_tax_sheets() -> None:
    f = family()
    ledger = f.ledger
    item = _bank(f)
    pos = inv.create_position(
        ledger,
        "LCA Banco X",
        AssetClass.FIXED_INCOME,
        date(2025, 2, 1),
        initial_cost="3000",
        from_account=item.checking_id,
    )
    saved = prof.save_profile(
        ledger,
        prof.InvestmentProfile(
            position_id=pos.id,
            bank_account_id=item.id,
            irpf_group="04",
            irpf_code="03",
            issuer="Banco X S.A.",
            issuer_tax_id="11222333000181",
            indexer=prof.Indexer.CDI,
            rate=Decimal("95"),
            applied_on=date(2025, 2, 1),
            maturity=date(2027, 2, 1),
            liquidity=prof.Liquidity.AT_MATURITY,
            tax=prof.TaxTreatment.EXEMPT,
            income_code="isento:12",
            fgc=True,
        ),
    )
    assert prof.yield_text(saved) == "95% do CDI"
    assert records.nature_of(ledger, NatureSubject.POSITION, pos.id) is IncomeNature.EXEMPT
    row = next(r for r in declaration.assets(ledger, 2025) if r.ref == pos.id)
    assert (row.group, row.code, row.suggested) == ("04", "03", False)
    assert "Banco X S.A." in row.description and "95% do CDI" in row.description and "ag. 0123" in row.description
    assert row.tax_id == "60701190000104"  # the custodian bank, from the COMPE list
    inv.distribute(ledger, pos.id, "40.00", date(2025, 8, 1), item.checking_id)  # type: ignore[arg-type]
    [other] = declaration.income(ledger, 2025).other
    assert other.nature is IncomeNature.EXEMPT and other.code == "12"
    with pytest.raises(DomainError):
        prof.save_profile(ledger, saved.model_copy(update={"irpf_code": "77"}))
    with pytest.raises(DomainError):
        prof.save_profile(ledger, saved.model_copy(update={"income_code": "isento:99"}))
    assert prof.class_for("07", "03") is AssetClass.REIT and prof.class_for("03", "01") is AssetClass.STOCK


def test_bank_records_survive_save() -> None:
    from opesvault.domain.ledger import Ledger

    f = family()
    item = _bank(f)
    restored = Ledger.from_records(f.ledger.to_records())
    assert banking.bank_accounts(restored)[item.id].number == "45678-X"
