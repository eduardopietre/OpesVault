"""Phase 5: quantities, lots, corporate events, return methods and brokerage notes."""

from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from opesvault.domain import queries
from opesvault.domain.ledger import DomainError
from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount
from opesvault.investments import service as inv
from opesvault.investments.benchmarks import benchmark_return, import_benchmark_csv
from opesvault.investments.model import AssetClass, TrackingMode, ValueNature
from opesvault.investments.returns import modified_dietz, twr, xirr, xirr_from_flows
from opesvault.investments.trades import CostMethod, bonus, buy, holding, lots_of, opening_lot, quantity_on, sell, split

from .domain_fixtures import family

D = Decimal


def _stock(f, asset_class: AssetClass = AssetClass.STOCK):  # type: ignore[no-untyped-def]
    f.ledger.record_opening_balance(f.bank, "100000.00", date(2025, 12, 31))
    return inv.create_position(
        f.ledger, "PETR4", asset_class, date(2026, 1, 2), mode=TrackingMode.QUANTITY, ticker="PETR4"
    )


def test_average_cost_sell() -> None:
    f = family()
    pos = _stock(f)
    buy(f.ledger, pos.id, date(2026, 1, 2), "100", "10.00", f.bank, fees="1.00")
    buy(f.ledger, pos.id, date(2026, 2, 2), "100", "20.00", f.bank, fees="1.00")
    assert holding(f.ledger, pos.id).cost == D("3002.00")
    event = sell(f.ledger, pos.id, date(2026, 3, 2), "50", "25.00", f.bank, fees="0.50")
    assert event.cost_attributed == D("750.50")  # 3002 × 50/200
    assert event.realized_gain == D("1250.00") - D("750.50")
    remaining = holding(f.ledger, pos.id)
    assert remaining.quantity == D("150") and remaining.cost == D("2251.50")
    assert inv.remaining_cost(f.ledger, pos.id) == D("2251.50")
    assert "custo médio" in (event.cost_method or "")


def test_fifo_for_fixed_income_lots() -> None:
    f = family()
    pos = _stock(f, AssetClass.TREASURY)
    buy(f.ledger, pos.id, date(2026, 1, 2), "1", "1000.00", f.bank)
    buy(f.ledger, pos.id, date(2026, 2, 2), "1", "1100.00", f.bank)
    event = sell(f.ledger, pos.id, date(2026, 3, 2), "1", "1200.00", f.bank)
    assert event.cost_attributed == D("1000.00")  # oldest lot first
    assert [lot.remaining_quantity for lot in lots_of(f.ledger, pos.id)] == [D("0"), D("1")]


def test_specific_method_override_and_no_short_selling() -> None:
    f = family()
    pos = _stock(f, AssetClass.TREASURY)
    buy(f.ledger, pos.id, date(2026, 1, 2), "2", "100.00", f.bank)
    sell(f.ledger, pos.id, date(2026, 1, 3), "1", "110.00", f.bank, method=CostMethod.AVERAGE)
    with pytest.raises(DomainError):
        sell(f.ledger, pos.id, date(2026, 1, 4), "5", "110.00", f.bank)
    assert holding(f.ledger, pos.id).quantity == D("1")


def test_split_keeps_cost_and_bonus_adds_quantity() -> None:
    f = family()
    pos = _stock(f)
    buy(f.ledger, pos.id, date(2026, 1, 2), "100", "10.00", f.bank)
    split(f.ledger, pos.id, date(2026, 2, 1), "2")
    assert holding(f.ledger, pos.id) == holding(f.ledger, pos.id).__class__(D("200"), D("1000.00"))
    bonus(f.ledger, pos.id, date(2026, 3, 1), "20", "0")
    assert holding(f.ledger, pos.id).quantity == D("220")
    assert quantity_on(f.ledger, pos.id, date(2026, 2, 15)) == D("200")
    assert quantity_on(f.ledger, pos.id, date(2026, 1, 15)) == D("100")


def test_opening_lot_is_equity_not_income() -> None:
    f = family()
    pos = _stock(f)
    opening_lot(f.ledger, pos.id, date(2026, 1, 2), "300", "4500.00")
    assert holding(f.ledger, pos.id).average_price == D("15")
    assert (
        queries.income_statement(
            f.ledger, __import__("opesvault.domain.model", fromlist=["YearMonth"]).YearMonth(year=2026, month=1)
        ).total_income
        == 0
    )


def test_value_position_cannot_trade_quantities() -> None:
    f = family()
    f.ledger.record_opening_balance(f.bank, "1000", date(2025, 12, 31))
    pos = inv.create_position(
        f.ledger, "CDB", AssetClass.FIXED_INCOME, date(2026, 1, 1), initial_cost="100", from_account=f.bank
    )
    with pytest.raises(DomainError):
        buy(f.ledger, pos.id, date(2026, 1, 2), "1", "1", f.bank)


# ── return methods ───────────────────────────────────


def _value_position(f):  # type: ignore[no-untyped-def]
    f.ledger.record_opening_balance(f.bank, "100000.00", date(2025, 12, 31))
    return inv.create_position(
        f.ledger, "Fundo", AssetClass.FUND, date(2026, 1, 1), initial_cost="1000", from_account=f.bank
    )


def test_twr_with_valuations_on_flow_dates() -> None:
    f = family()
    pos = _value_position(f)
    # +10% until the flow, then +1000 contribution (closing value includes it), then −5%.
    inv.add_valuation(f.ledger, pos.id, date(2026, 2, 1), "2100", ValueNature.GROSS)
    inv.contribute(f.ledger, pos.id, "1000", date(2026, 2, 1), f.bank)
    inv.add_valuation(f.ledger, pos.id, date(2026, 3, 1), "1995", ValueNature.GROSS)
    result = twr(f.ledger, pos.id, date(2026, 1, 1), date(2026, 3, 1))
    assert result.value == D("1.1") * D("0.95") - 1


def test_twr_unavailable_without_valuation_at_flow_ta27() -> None:
    f = family()
    pos = _value_position(f)
    inv.contribute(f.ledger, pos.id, "1000", date(2026, 2, 1), f.bank)
    inv.add_valuation(f.ledger, pos.id, date(2026, 3, 1), "2100", ValueNature.GROSS)
    result = twr(f.ledger, pos.id, date(2026, 1, 1), date(2026, 3, 1))
    assert result.value is None and "interpolação" in result.notes[0]


def test_modified_dietz_matches_formula() -> None:
    f = family()
    pos = _value_position(f)
    inv.contribute(f.ledger, pos.id, "500", date(2026, 1, 11), f.bank)  # 20 of 30 days remain
    inv.add_valuation(f.ledger, pos.id, date(2026, 1, 31), "1560", ValueNature.GROSS)
    result = modified_dietz(f.ledger, pos.id, date(2026, 1, 1), date(2026, 1, 31))
    expected = (D("1560") - D("1000") - D("500")) / (D("1000") + D("500") * D(20) / D(30))
    assert result.value == expected and result.quality.value == "estimate"


def test_xirr_simple_case() -> None:
    rate, _ = xirr_from_flows([(date(2025, 1, 1), D("-1000")), (date(2026, 1, 1), D("1100"))])
    assert rate is not None and abs(rate - D("0.1")) < D("1e-9")


def test_xirr_no_solution_or_multiple_roots_is_unavailable() -> None:
    assert xirr_from_flows([(date(2025, 1, 1), D("100")), (date(2026, 1, 1), D("100"))])[0] is None
    # Sign changes twice: two roots (10% and 20%); no arbitrary choice.
    flows = [(date(2024, 1, 1), D("-100")), (date(2025, 1, 1), D("230")), (date(2026, 1, 1), D("-132"))]
    rate, reason = xirr_from_flows(flows)
    assert rate is None and "Múltiplas" in reason


def test_xirr_on_position() -> None:
    f = family()
    pos = _value_position(f)
    inv.add_valuation(f.ledger, pos.id, date(2027, 1, 1), "1100", ValueNature.GROSS)
    result = xirr(f.ledger, pos.id, date(2026, 1, 1), date(2027, 1, 1))
    assert result.value is not None and abs(result.value - D("0.1")) < D("1e-9")


def test_benchmark_from_local_file() -> None:
    f = family()
    bench = import_benchmark_csv(
        f.ledger, "CDI", b"data;valor\n01/01/2026;100,00\n01/03/2026;102,00\n", "arquivo do usuário"
    )
    assert benchmark_return(bench, date(2026, 1, 1), date(2026, 3, 1)).value == D("0.02")
    assert benchmark_return(bench, date(2026, 1, 2), date(2026, 3, 1)).value is None


# ── brokerage notes ──────────────────────────────────


def test_note_approval_creates_trades_with_allocated_costs(tmp_path: Path) -> None:
    from opesvault.importing import pipeline
    from opesvault.importing.pipeline import ImportRequest
    from opesvault.session import Session

    from . import synthetic_docs as docs

    session = Session.new(tmp_path / "x.opesvault")
    ledger = session.ledger
    broker = ledger.add_account(
        LedgerAccount(name="Corretora", type=AccountType.ASSET, subtype=AccountSubtype.BROKERAGE_CASH)
    )
    ledger.record_opening_balance(broker.id, "10000.00", date(2026, 3, 1))
    vale = inv.create_position(
        ledger, "VALE3", AssetClass.STOCK, date(2026, 1, 1), mode=TrackingMode.QUANTITY, ticker="VALE3"
    )
    opening_lot(ledger, vale.id, date(2026, 1, 1), "100", "5000.00")
    batch = pipeline.import_document(session, ImportRequest("nota.pdf", docs.sinacor_note_pdf(), account_id=broker.id))
    result = pipeline.approve(ledger, batch.id)
    assert result.created == 3
    # Cash moved exactly by the note's net (−106,95), on the settlement date.
    assert queries.balance(ledger, broker.id) == D("10000.00") - D("106.95")
    assert queries.balance(ledger, broker.id, date(2026, 3, 3)) == D("10000.00")
    petr = next(p for p in inv.positions(ledger).values() if inv.assets(ledger)[p.asset_id].ticker == "PETR4")
    # 1,95 of costs split by value: 3000/6105 of it on PETR4 → 0,96.
    assert holding(ledger, petr.id).cost == D("3000.96")
    assert holding(ledger, vale.id).quantity == D("50")
    assert pipeline.batches(ledger)[batch.id].status.value == "approved"


def test_note_selling_more_than_held_is_refused(tmp_path: Path) -> None:
    from opesvault.importing import pipeline
    from opesvault.importing.pipeline import ImportRequest
    from opesvault.session import Session

    from . import synthetic_docs as docs

    session = Session.new(tmp_path / "x.opesvault")
    broker = session.ledger.add_account(
        LedgerAccount(name="Corretora", type=AccountType.ASSET, subtype=AccountSubtype.BROKERAGE_CASH)
    )
    batch = pipeline.import_document(session, ImportRequest("nota.pdf", docs.sinacor_note_pdf(), account_id=broker.id))
    with pytest.raises(DomainError):
        pipeline.approve(session.ledger, batch.id)
