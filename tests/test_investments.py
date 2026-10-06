"""Normative examples A-F (docs/06 §8) and investment acceptance tests (TA-20..TA-28, TA-36)."""

from datetime import date
from decimal import Decimal

import pytest

from opesvault.domain import queries
from opesvault.domain.ledger import DomainError
from opesvault.domain.model import YearMonth
from opesvault.investments import service as inv
from opesvault.investments.model import AssetClass, EventQuality, TaxRule, TaxRuleKind, TrackingMode, ValueNature
from opesvault.investments.performance import (
    Quality,
    composition,
    period_result,
    realized,
    selected_series,
    simple_return,
    unrealized,
)
from opesvault.investments.simulation import simulate

from .domain_fixtures import family

D = Decimal
FICTITIOUS_15 = TaxRule(name="Regra fictícia 15% sobre ganho", kind=TaxRuleKind.RATE_ON_POSITIVE_GAIN, rate=D("0.15"))


def _cdb(f, cost: str = "10000.00", on: date = date(2026, 1, 1)):  # type: ignore[no-untyped-def]
    f.ledger.record_opening_balance(f.bank, "100000.00", date(2025, 12, 31))
    return inv.create_position(
        f.ledger, "CDB Banco X", AssetClass.FIXED_INCOME, on, initial_cost=cost, from_account=f.bank
    )


def test_example_a_successive_valuations_ta20() -> None:
    f = family()
    pos = _cdb(f)
    for when, value in ((date(2026, 1, 31), "10100"), (date(2026, 2, 28), "10250"), (date(2026, 3, 31), "10400")):
        inv.add_valuation(f.ledger, pos.id, when, value, ValueNature.GROSS)
    assert len(selected_series(f.ledger, pos.id)) == 4
    result = period_result(f.ledger, pos.id, date(2026, 1, 1), date(2026, 3, 31))
    assert result.value == D("400.00")
    assert simple_return(f.ledger, pos.id, date(2026, 1, 1), date(2026, 3, 31)).value == D("0.04")
    assert unrealized(f.ledger, pos.id, date(2026, 3, 31)).value == D("400.00")


def test_example_b_contribution_is_not_income_ta21() -> None:
    f = family()
    pos = _cdb(f)
    inv.contribute(f.ledger, pos.id, "5000.00", date(2026, 2, 10), f.bank)
    inv.add_valuation(f.ledger, pos.id, date(2026, 3, 31), "15300", ValueNature.GROSS)
    assert period_result(f.ledger, pos.id, date(2026, 1, 1), date(2026, 3, 31)).value == D("300.00")
    ret = simple_return(f.ledger, pos.id, date(2026, 1, 1), date(2026, 3, 31))
    assert ret.value is None and "aportes" in ret.notes[0]
    # The contribution moved money between own accounts: no income, same net worth.
    assert queries.income_statement(f.ledger, YearMonth(year=2026, month=2)).total_income == 0


def test_example_c_total_redemption_simulated_tax_ta22() -> None:
    f = family()
    pos = _cdb(f)
    inv.add_valuation(f.ledger, pos.id, date(2026, 6, 30), "12000", ValueNature.GROSS)
    balance_before = queries.balance(f.ledger, f.bank)
    sim = simulate(f.ledger, pos.id, date(2026, 6, 30), "12000", FICTITIOUS_15, fees="20")
    assert (sim.cost_attributed, sim.gain, sim.tax, sim.net, sim.net_gain) == (
        D("10000.00"),
        D("2000.00"),
        D("300.00"),
        D("11680.00"),
        D("1680.00"),
    )
    assert sim.gross_return == D("0.2") and sim.net_return == D("0.168")
    assert queries.balance(f.ledger, f.bank) == balance_before  # a simulation never posts cash
    inv.redeem(f.ledger, pos.id, date(2026, 6, 30), "12000", f.bank, tax_withheld="300", fees="20", final=True)
    assert queries.balance(f.ledger, f.bank) == balance_before + D("11680.00")
    assert inv.remaining_cost(f.ledger, pos.id) == 0
    assert realized(f.ledger, pos.id).value == D("2000.00")
    # A total redemption closes a value-mode position.
    assert inv.position(f.ledger, pos.id).closed


def test_example_d_partial_redemption_ta23() -> None:
    f = family()
    pos = _cdb(f)
    inv.add_valuation(f.ledger, pos.id, date(2026, 6, 30), "12000", ValueNature.GROSS)
    sim = simulate(f.ledger, pos.id, date(2026, 6, 30), "3000", FICTITIOUS_15, fees="10", current_value="12000")
    assert (sim.cost_attributed, sim.gain, sim.tax, sim.net) == (D("2500.00"), D("500.00"), D("75.00"), D("2915.00"))
    assert sim.remaining_value == D("9000") and sim.remaining_cost == D("7500.00")
    event = inv.redeem(f.ledger, pos.id, date(2026, 6, 30), "3000", f.bank, tax_withheld="75", fees="10")
    assert event.cost_attributed == D("2500.00") and event.net == D("2915.00")
    assert inv.remaining_cost(f.ledger, pos.id) == D("7500.00")
    # The whole R$ 2.000 gain is not taxed on a partial redemption.
    assert event.realized_gain == D("500.00")


def test_example_e_external_distribution_ta24() -> None:
    f = family()
    pos = _cdb(f)
    inv.distribute(f.ledger, pos.id, "200.00", date(2026, 2, 15), f.bank)
    inv.add_valuation(f.ledger, pos.id, date(2026, 3, 31), "10100", ValueNature.GROSS)
    assert period_result(f.ledger, pos.id, date(2026, 1, 1), date(2026, 3, 31)).value == D("300.00")
    total = simple_return(f.ledger, pos.id, date(2026, 1, 1), date(2026, 3, 31))
    assert total.value == D("0.03") and any("distribuições" in n for n in total.notes)
    # Counted once: as income in the ledger, not again as a change in the position's cost.
    assert inv.remaining_cost(f.ledger, pos.id) == D("10000.00")


def test_example_f_unknown_cost_ta25() -> None:
    f = family()
    pos = inv.create_position(f.ledger, "Fundo antigo", AssetClass.FUND, date(2026, 6, 1), reference_value="50000.00")
    inv.add_valuation(f.ledger, pos.id, date(2026, 7, 1), "50500", ValueNature.GROSS)
    assert period_result(f.ledger, pos.id, date(2026, 6, 1), date(2026, 7, 1)).value == D("500.00")
    gain = unrealized(f.ledger, pos.id, date(2026, 7, 1))
    assert gain.value is None and gain.quality is Quality.UNAVAILABLE
    sim = simulate(f.ledger, pos.id, date(2026, 7, 1), "1000", FICTITIOUS_15)
    assert sim.tax is None and sim.gain is None


def test_disagreeing_sources_same_date_ta26() -> None:
    f = family()
    pos = _cdb(f)
    first = inv.add_valuation(f.ledger, pos.id, date(2026, 1, 31), "10100", ValueNature.GROSS, source="extrato banco")
    second = inv.add_valuation(f.ledger, pos.id, date(2026, 1, 31), "10120", ValueNature.GROSS, source="app")
    assert first.selected and not second.selected
    inv.select_valuation(f.ledger, second.id)
    [jan31] = [v for v in selected_series(f.ledger, pos.id) if v.on == date(2026, 1, 31)]
    assert jan31.value == D("10120")  # chosen, never an average
    assert len(inv.valuations_of(f.ledger, pos.id)) == 3
    with pytest.raises(DomainError):
        inv.add_valuation(f.ledger, pos.id, date(2026, 1, 31), "1", ValueNature.GROSS, source="app")


def test_valuation_does_not_change_cost_or_cash() -> None:
    f = family()
    pos = _cdb(f)
    bank = queries.balance(f.ledger, f.bank)
    inv.add_valuation(f.ledger, pos.id, date(2026, 5, 1), "99999", ValueNature.GROSS)
    assert inv.remaining_cost(f.ledger, pos.id) == D("10000.00")
    assert queries.balance(f.ledger, f.bank) == bank


def test_gross_and_net_points_are_not_mixed() -> None:
    f = family()
    pos = _cdb(f)
    inv.add_valuation(f.ledger, pos.id, date(2026, 3, 31), "10300", ValueNature.NET_INFORMED)
    assert period_result(f.ledger, pos.id, date(2026, 1, 1), date(2026, 3, 31)).value is None
    assert unrealized(f.ledger, pos.id, date(2026, 3, 31)).value is None


def test_tax_due_later_reduces_cash_only_when_paid_ta28() -> None:
    f = family()
    pos = _cdb(f)
    inv.add_valuation(f.ledger, pos.id, date(2026, 6, 30), "12000", ValueNature.GROSS)
    before = queries.balance(f.ledger, f.bank)
    inv.redeem(f.ledger, pos.id, date(2026, 6, 30), "12000", f.bank, tax_due_later="300", final=True)
    assert queries.balance(f.ledger, f.bank) == before + D("12000")
    assert queries.net_worth(f.ledger).liabilities == D("300")
    inv.pay_tax(f.ledger, "300", date(2026, 7, 31), f.bank)
    assert queries.balance(f.ledger, f.bank, date(2026, 7, 30)) == before + D("12000")
    assert queries.balance(f.ledger, f.bank) == before + D("11700")
    july = YearMonth(year=2026, month=7)
    assert queries.income_statement(f.ledger, july).total_expense == 0  # the cost was recognized once, in June


def test_net_only_redemption_is_incomplete_then_completed() -> None:
    f = family()
    pos = _cdb(f)
    inv.add_valuation(f.ledger, pos.id, date(2026, 6, 30), "12000", ValueNature.GROSS)
    worth = queries.net_worth(f.ledger).net
    event = inv.redeem_net_only(f.ledger, pos.id, date(2026, 6, 30), "2915.00", f.bank)
    assert event.quality is EventQuality.INCOMPLETE and event.tax_withheld == 0 and event.gross is None
    assert queries.net_worth(f.ledger).net == worth  # nothing inferred
    assert period_result(f.ledger, pos.id, date(2026, 1, 1), date(2026, 6, 30)).quality is Quality.INCOMPLETE
    with pytest.raises(DomainError):
        inv.complete_redemption(f.ledger, event.id, "3000", tax_withheld="80", fees="10")  # does not add up
    done = inv.complete_redemption(f.ledger, event.id, "3000", tax_withheld="75", fees="10")
    assert done.quality is EventQuality.COMPLETE and done.cost_attributed == D("2500.00")
    assert queries.balance(f.ledger, f.bank) == D("100000.00") - D("10000.00") + D("2915.00")


def test_composition_partial_without_price_ta36() -> None:
    f = family()
    a = _cdb(f)
    inv.create_position(f.ledger, "Ação sem preço", AssetClass.STOCK, date(2026, 1, 1), mode=TrackingMode.QUANTITY)
    inv.add_valuation(f.ledger, a.id, date(2026, 2, 1), "10100", ValueNature.GROSS)
    portfolio = composition(f.ledger, date(2026, 2, 10))
    assert portfolio.partial and portfolio.total == D("10100")
    line = next(line for line in portfolio.lines if line.position_id == a.id)
    assert line.as_of == date(2026, 2, 1) and line.age_days == 9


def test_redeem_more_than_cost_is_refused() -> None:
    f = family()
    pos = _cdb(f)
    with pytest.raises(DomainError):
        inv.redeem(f.ledger, pos.id, date(2026, 2, 1), "100", f.bank, cost_attributed="20000")


def test_simulation_rule_validity() -> None:
    f = family()
    pos = _cdb(f)
    inv.add_valuation(f.ledger, pos.id, date(2026, 6, 30), "12000", ValueNature.GROSS)
    rule = FICTITIOUS_15.model_copy(update={"valid_to": date(2025, 12, 31)})
    with pytest.raises(DomainError):
        simulate(f.ledger, pos.id, date(2026, 6, 30), "12000", rule)
