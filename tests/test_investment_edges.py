"""Edge cases of investments (docs/06): guards, unknown-is-None results and return-method limits.

Valuations never create flows, contributions are never income, and a figure the data
cannot support is unavailable with a reason, never zero.
"""

import re
from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import uuid4

import pytest

from opesvault.domain import queries
from opesvault.domain.ledger import DomainError
from opesvault.domain.model import YearMonth
from opesvault.importing.model import BatchStatus, DocFormat, ExtractedItem, ImportBatch, ItemKind, StatementHeader
from opesvault.investments import service as inv
from opesvault.investments.benchmarks import benchmark_return, import_benchmark_csv
from opesvault.investments.model import (
    AssetClass,
    EventKind,
    EventQuality,
    InvestmentEvent,
    TaxRule,
    TaxRuleKind,
    TrackingMode,
    ValueNature,
)
from opesvault.investments.notes import approve_note, guess_class, position_for
from opesvault.investments.performance import (
    Quality,
    composition,
    external_flows,
    period_result,
    realized,
    simple_return,
    unrealized,
    value_at,
)
from opesvault.investments.returns import modified_dietz, twr, xirr, xirr_from_flows
from opesvault.investments.simulation import simulate, tax_for
from opesvault.investments.trades import (
    CostMethod,
    Holding,
    bonus,
    buy,
    default_method,
    holding,
    lots_of,
    opening_lot,
    quantity_on,
    sell,
    split,
)

from .domain_fixtures import Family, family

D = Decimal
START = date(2026, 1, 1)


def exact(message: str) -> str:
    return f"^{re.escape(message)}$"


def funded() -> Family:
    f = family()
    f.ledger.record_opening_balance(f.bank, "100000.00", date(2025, 12, 31))
    return f


def cdb(f: Family, cost: str = "10000.00", on: date = START):  # type: ignore[no-untyped-def]
    return inv.create_position(f.ledger, "CDB", AssetClass.FIXED_INCOME, on, initial_cost=cost, from_account=f.bank)


def stock(f: Family, asset_class: AssetClass = AssetClass.STOCK):  # type: ignore[no-untyped-def]
    return inv.create_position(f.ledger, "PETR4", asset_class, START, mode=TrackingMode.QUANTITY, ticker="PETR4")


def category_total(f: Family, name: str, month: YearMonth) -> Decimal:
    statement = queries.income_statement(f.ledger, month)
    account = next(a for a in f.ledger.accounts.values() if a.name == name)
    return statement.income.get(account.id) or statement.expense.get(account.id) or D("0")


JAN = YearMonth(year=2026, month=1)


# ── positions and valuations ───────────────────────


def test_unknown_position_is_a_domain_error() -> None:
    f = funded()
    with pytest.raises(DomainError, match=exact("Posição inexistente.")):
        inv.position(f.ledger, uuid4())
    with pytest.raises(DomainError, match=exact("Posição inexistente.")):
        inv.contribute(f.ledger, uuid4(), "10", START, f.bank)


def test_flows_only_come_from_cash_accounts() -> None:
    f = funded()
    pos = cdb(f)
    other = cdb(f)
    message = exact("Escolha uma conta de dinheiro (corrente, poupança ou saldo em corretora).")
    for source in (inv.position(f.ledger, other.id).account_id, f.groceries, f.card_account):
        with pytest.raises(DomainError, match=message):
            inv.contribute(f.ledger, pos.id, "10", START, source)


def test_create_position_guards() -> None:
    f = funded()
    with pytest.raises(DomainError, match=exact("Informe o custo inicial ou um valor de referência.")):
        inv.create_position(f.ledger, "Sem dados", AssetClass.FUND, START)
    with pytest.raises(DomainError, match=r"^Posições por quantidade começam vazias"):
        inv.create_position(f.ledger, "X", AssetClass.STOCK, START, mode=TrackingMode.QUANTITY, initial_cost="10")
    empty = inv.create_position(f.ledger, "Y", AssetClass.STOCK, START, mode=TrackingMode.QUANTITY, initial_cost="0")
    assert empty.cost_known and inv.remaining_cost(f.ledger, empty.id) == 0
    assert inv.valuations_of(f.ledger, empty.id) == []


def test_known_cost_without_cash_account_is_an_opening_balance() -> None:
    f = funded()
    bank_before = queries.balance(f.ledger, f.bank)
    pos = inv.create_position(f.ledger, "CDB antigo", AssetClass.FIXED_INCOME, START, initial_cost="2500.00")
    assert queries.balance(f.ledger, f.bank) == bank_before  # no cash left any account
    assert inv.remaining_cost(f.ledger, pos.id) == D("2500.00")
    (event,) = inv.events_of(f.ledger, pos.id)
    assert event.kind is EventKind.CONTRIBUTION and event.note == "saldo de abertura" and event.net is None
    (valuation,) = inv.valuations_of(f.ledger, pos.id)
    assert (valuation.value, valuation.source, valuation.nature) == (D("2500.00"), "custo inicial", ValueNature.GROSS)
    assert queries.income_statement(f.ledger, JAN).total_income == 0


def test_cost_and_reference_value_keep_only_the_reference_observation() -> None:
    f = funded()
    pos = inv.create_position(
        f.ledger,
        "Fundo",
        AssetClass.FUND,
        START,
        initial_cost="1000",
        from_account=f.bank,
        reference_value="1100",
        reference_nature=ValueNature.NET_INFORMED,
    )
    (valuation,) = inv.valuations_of(f.ledger, pos.id)
    assert (valuation.value, valuation.source, valuation.nature) == (
        D("1100"),
        "referência inicial",
        ValueNature.NET_INFORMED,
    )
    assert pos.cost_known and inv.remaining_cost(f.ledger, pos.id) == D("1000")


def test_zero_reference_value_posts_nothing_and_leaves_cost_unknown() -> None:
    f = funded()
    operations = len(f.ledger.operations)
    pos = inv.create_position(f.ledger, "Previdência", AssetClass.PENSION, START, reference_value="0")
    assert not pos.cost_known and len(f.ledger.operations) == operations
    assert [v.value for v in inv.valuations_of(f.ledger, pos.id)] == [D("0")]


def test_valuation_guards_and_disagreeing_sources() -> None:
    f = funded()
    pos = cdb(f)
    with pytest.raises(DomainError, match=exact("Valor de avaliação não pode ser negativo.")):
        inv.add_valuation(f.ledger, pos.id, START, "-1", ValueNature.GROSS)
    with pytest.raises(DomainError, match=r"^Já existe avaliação desta fonte nesta data"):
        inv.add_valuation(f.ledger, pos.id, START, "10001", ValueNature.GROSS, source="custo inicial")
    other = inv.add_valuation(f.ledger, pos.id, START, "10050", ValueNature.GROSS, source="extrato", quantity="1")
    assert not other.selected and other.quantity == D("1")
    assert value_at(f.ledger, pos.id, START).valuation.value == D("10000.00")  # type: ignore[union-attr]
    inv.select_valuation(f.ledger, other.id)
    assert value_at(f.ledger, pos.id, START).valuation.value == D("10050")  # type: ignore[union-attr]
    assert sum(v.selected for v in inv.valuations_of(f.ledger, pos.id)) == 1


def test_correct_valuation_guards_and_nature_change() -> None:
    f = funded()
    pos = cdb(f)
    (valuation,) = inv.valuations_of(f.ledger, pos.id)
    with pytest.raises(DomainError, match=exact("Avaliação inexistente.")):
        inv.correct_valuation(f.ledger, uuid4(), "1", "motivo")
    with pytest.raises(DomainError, match=exact("Correções exigem motivo.")):
        inv.correct_valuation(f.ledger, valuation.id, "1", " ")
    kept = inv.correct_valuation(f.ledger, valuation.id, "9990.00", "digitação")
    assert kept.nature is ValueNature.GROSS and kept.value == D("9990.00")
    changed = inv.correct_valuation(f.ledger, valuation.id, "9800", "era líquido", ValueNature.NET_INFORMED)
    assert changed.nature is ValueNature.NET_INFORMED
    assert f.ledger.history_of(valuation.id)[-1].reason == "era líquido"
    assert inv.remaining_cost(f.ledger, pos.id) == D("10000.00")  # a valuation never changes cost


# ── flows ─────────────────────────────────────────


@pytest.mark.parametrize("amount", ["0", "-1"])
def test_contribution_must_be_positive(amount: str) -> None:
    f = funded()
    pos = cdb(f)
    with pytest.raises(DomainError, match=exact("Informe um valor positivo.")):
        inv.contribute(f.ledger, pos.id, amount, START, f.bank)


@pytest.mark.parametrize(("gross", "tax"), [("0", "0"), ("100", "-1"), ("100", "100.01")])
def test_distribution_guards(gross: str, tax: str) -> None:
    f = funded()
    pos = cdb(f)
    with pytest.raises(DomainError, match=exact("Valores do provento inválidos.")):
        inv.distribute(f.ledger, pos.id, gross, START, f.bank, tax)


def test_distribution_with_withheld_tax_credits_the_net() -> None:
    f = funded()
    pos = cdb(f)
    bank_before = queries.balance(f.ledger, f.bank)
    event = inv.distribute(f.ledger, pos.id, "200.00", date(2026, 1, 15), f.bank, "30.00")
    assert (event.gross, event.tax_withheld, event.net) == (D("200.00"), D("30.00"), D("170.00"))
    assert queries.balance(f.ledger, f.bank) == bank_before + D("170.00")
    assert category_total(f, inv.INCOME_CATEGORY, JAN) == D("200.00")
    assert category_total(f, inv.TAX_CATEGORY, JAN) == D("30.00")
    assert inv.remaining_cost(f.ledger, pos.id) == D("10000.00")


def test_proportional_cost_needs_known_cost_and_a_gross_valuation() -> None:
    f = funded()
    unknown = inv.create_position(f.ledger, "Antigo", AssetClass.FUND, START, reference_value="500")
    with pytest.raises(DomainError, match=r"^Custo desconhecido"):
        inv.proportional_cost(f.ledger, unknown.id, D("100"), START)
    net_only = inv.create_position(
        f.ledger,
        "Líquido",
        AssetClass.FUND,
        START,
        initial_cost="1000",
        reference_value="1000",
        reference_nature=ValueNature.NET_INFORMED,
    )
    with pytest.raises(DomainError, match=r"^É preciso uma avaliação bruta"):
        inv.proportional_cost(f.ledger, net_only.id, D("100"), START)
    pos = cdb(f)
    with pytest.raises(DomainError, match=r"^É preciso uma avaliação bruta"):
        inv.proportional_cost(f.ledger, pos.id, D("100"), date(2025, 12, 31))  # before any valuation
    with pytest.raises(DomainError, match=exact("Resgate maior que o valor avaliado.")):
        inv.proportional_cost(f.ledger, pos.id, D("10000.01"), START)
    third = inv.proportional_cost(f.ledger, pos.id, D("3333.33"), START)
    assert third.amount == D("3333.33") and "proporcional" in third.method


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"gross": "0"}, "Valores do resgate inválidos."),
        ({"gross": "100", "fees": "-1"}, "Valores do resgate inválidos."),
        ({"gross": "100", "tax_withheld": "-1"}, "Valores do resgate inválidos."),
        ({"gross": "100", "tax_due_later": "-1"}, "Valores do resgate inválidos."),
        ({"gross": "100", "tax_withheld": "60", "fees": "41"}, "Impostos e taxas maiores que o valor bruto."),
        (
            {"gross": "100", "tax_withheld": "10", "net_informed": "95"},
            "O líquido informado não confere com bruto − imposto retido − taxas.",
        ),
        ({"gross": "100", "cost_attributed": "10000.01"}, "Custo atribuído maior que o custo remanescente."),
        ({"gross": "100", "cost_attributed": "-1"}, "Custo atribuído maior que o custo remanescente."),
    ],
)
def test_redeem_guards_leave_the_ledger_untouched(kwargs: dict[str, str], message: str) -> None:
    f = funded()
    pos = cdb(f)
    operations, events = len(f.ledger.operations), len(inv.events_of(f.ledger, pos.id))
    gross = kwargs.pop("gross")
    with pytest.raises(DomainError, match=exact(message)):
        inv.redeem(f.ledger, pos.id, date(2026, 2, 1), gross, f.bank, **kwargs)  # type: ignore[arg-type]
    assert (len(f.ledger.operations), len(inv.events_of(f.ledger, pos.id))) == (operations, events)


def test_redemption_at_a_loss_with_tax_due_later_ta28() -> None:
    f = funded()
    pos = cdb(f)
    bank_before = queries.balance(f.ledger, f.bank)
    event = inv.redeem(
        f.ledger, pos.id, date(2026, 1, 20), "900", f.bank, cost_attributed="1000", tax_due_later="5", fees="2"
    )
    assert event.realized_gain == D("-100") and event.cost_method == "custo informado"
    assert event.net == D("898") and len(event.operation_ids) == 2
    # Tax due later is an obligation: cash only moves when it is paid.
    assert queries.balance(f.ledger, f.bank) == bank_before + D("898")
    tax_account = inv.tax_payable_account(f.ledger)
    assert queries.balance(f.ledger, tax_account) == D("5")
    assert category_total(f, inv.LOSS_CATEGORY, JAN) == D("100")
    assert category_total(f, inv.FEE_CATEGORY, JAN) == D("2")
    assert category_total(f, inv.TAX_CATEGORY, JAN) == D("5")
    inv.pay_tax(f.ledger, "5", date(2026, 2, 28), f.bank)
    assert queries.balance(f.ledger, tax_account) == 0
    assert inv.tax_payable_account(f.ledger) == tax_account  # reused, never duplicated


def test_redeem_without_gain_posts_neither_income_nor_loss() -> None:
    f = funded()
    pos = cdb(f)
    event = inv.redeem(f.ledger, pos.id, date(2026, 1, 20), "1000", f.bank, cost_attributed="1000")
    op = f.ledger.operations[event.operation_ids[0]]
    assert len(op.postings) == 2 and event.realized_gain == 0


def test_redeem_with_zero_attributed_cost_is_all_gain() -> None:
    f = funded()
    pos = cdb(f)
    event = inv.redeem(f.ledger, pos.id, date(2026, 1, 20), "300", f.bank, cost_attributed="0")
    op = f.ledger.operations[event.operation_ids[0]]
    assert all(p.amount != 0 for p in op.postings) and pos.account_id not in {p.account_id for p in op.postings}
    assert event.realized_gain == D("300") and inv.remaining_cost(f.ledger, pos.id) == D("10000.00")
    assert category_total(f, inv.INCOME_CATEGORY, JAN) == D("300")


def test_total_redemption_closes_a_value_position() -> None:
    f = funded()
    pos = cdb(f)
    inv.add_valuation(f.ledger, pos.id, date(2026, 6, 30), "12000", ValueNature.GROSS)
    inv.redeem(f.ledger, pos.id, date(2026, 6, 30), "12000", f.bank, final=True)
    assert inv.remaining_cost(f.ledger, pos.id) == 0
    assert inv.position(f.ledger, pos.id).closed


def test_partial_or_unflagged_redemption_keeps_the_position_open() -> None:
    f = funded()
    partial, unflagged = cdb(f), cdb(f)
    inv.redeem(f.ledger, partial.id, date(2026, 6, 30), "100", f.bank, cost_attributed="100", final=True)
    inv.redeem(f.ledger, unflagged.id, date(2026, 6, 30), "12000", f.bank, cost_attributed="10000.00")
    assert not inv.position(f.ledger, partial.id).closed
    assert not inv.position(f.ledger, unflagged.id).closed


@pytest.mark.parametrize("net", ["0", "-10"])
def test_net_only_redemption_needs_a_positive_net(net: str) -> None:
    f = funded()
    pos = cdb(f)
    with pytest.raises(DomainError, match=exact("Informe o líquido recebido.")):
        inv.redeem_net_only(f.ledger, pos.id, START, net, f.bank)


def test_complete_redemption_only_accepts_incomplete_events() -> None:
    f = funded()
    pos = cdb(f)
    complete = inv.contribute(f.ledger, pos.id, "10", START, f.bank)
    for event_id in (uuid4(), complete.id):
        with pytest.raises(DomainError, match=exact("Resgate incompleto inexistente.")):
            inv.complete_redemption(f.ledger, event_id, "100")


def test_net_only_redemptions_reuse_the_suspense_account_and_mark_results_incomplete() -> None:
    f = funded()
    pos = cdb(f)
    first = inv.redeem_net_only(f.ledger, pos.id, date(2026, 2, 1), "100", f.bank)
    inv.redeem_net_only(f.ledger, pos.id, date(2026, 2, 2), "50", f.bank)
    suspense = [a for a in f.ledger.accounts.values() if a.name == inv.SUSPENSE]
    assert len(suspense) == 1 and queries.balance(f.ledger, suspense[0].id) == D("150")
    assert first.quality is EventQuality.INCOMPLETE and first.gross is None
    result = realized(f.ledger, pos.id)
    assert result.quality is Quality.INCOMPLETE and result.value == 0
    assert result.notes == ("resgate de 01/02/2026 sem decomposição", "resgate de 02/02/2026 sem decomposição")
    assert realized(f.ledger, pos.id, until=date(2026, 1, 31)).quality is Quality.OBSERVED


# ── quantity tracking ──────────────────────────────


def test_trades_need_a_quantity_position() -> None:
    f = funded()
    pos = cdb(f)
    with pytest.raises(DomainError, match=r"^Esta posição é acompanhada por valor"):
        buy(f.ledger, pos.id, START, "1", "10", f.bank)


@pytest.mark.parametrize(("qty", "price", "fees"), [("0", "10", "0"), ("1", "-1", "0"), ("1", "10", "-1")])
def test_buy_and_sell_reject_invalid_figures(qty: str, price: str, fees: str) -> None:
    f = funded()
    pos = stock(f)
    buy(f.ledger, pos.id, START, "10", "10", f.bank)
    with pytest.raises(DomainError, match=exact("Quantidade, preço ou custos inválidos.")):
        buy(f.ledger, pos.id, START, qty, price, f.bank, fees=fees)
    with pytest.raises(DomainError, match=exact("Quantidade, preço ou custos inválidos.")):
        sell(f.ledger, pos.id, START, qty, price, f.bank, fees=fees)
    with pytest.raises(DomainError, match=exact("Quantidade, preço ou custos inválidos.")):
        sell(f.ledger, pos.id, START, "1", "10", f.bank, tax_withheld="-1")


def test_overselling_is_refused_before_any_lot_changes() -> None:
    f = funded()
    pos = stock(f)
    buy(f.ledger, pos.id, START, "10", "10", f.bank)
    lots = lots_of(f.ledger, pos.id)
    with pytest.raises(DomainError, match=r"^Venda maior que a quantidade em carteira"):
        sell(f.ledger, pos.id, date(2026, 1, 2), "10.5", "10", f.bank)
    assert lots_of(f.ledger, pos.id) == lots


def test_fifo_sell_consumes_the_oldest_lot_first_with_exact_cents() -> None:
    f = funded()
    pos = inv.create_position(f.ledger, "Tesouro", AssetClass.TREASURY, START, mode=TrackingMode.QUANTITY)
    buy(f.ledger, pos.id, START, "1", "100.00", f.bank)
    buy(f.ledger, pos.id, date(2026, 2, 1), "3", "110.00", f.bank, fees="0.01")
    event = sell(f.ledger, pos.id, date(2026, 3, 1), "2", "120.00", f.bank)
    # Whole first lot (100.00) + one third of the second (330.01 / 3 = 110.0033… → 110.00).
    assert event.cost_attributed == D("210.00") and event.cost_method is not None
    assert event.cost_method.startswith("por lote")
    first, second = lots_of(f.ledger, pos.id)
    assert (first.remaining_quantity, first.remaining_cost) == (D("0"), D("0.00"))
    assert (second.remaining_quantity, second.remaining_cost) == (D("2"), D("220.01"))
    assert holding(f.ledger, pos.id) == Holding(D("2"), D("220.01"))
    assert inv.remaining_cost(f.ledger, pos.id) == D("220.01")  # ledger and lots agree


def test_selling_everything_on_average_cost_empties_every_lot() -> None:
    f = funded()
    pos = stock(f)
    buy(f.ledger, pos.id, START, "3", "10.00", f.bank)
    buy(f.ledger, pos.id, date(2026, 1, 5), "1", "14.00", f.bank)
    event = sell(f.ledger, pos.id, date(2026, 2, 1), "4", "9.00", f.bank, fees="1.00", tax_withheld="0.50")
    assert event.cost_attributed == D("44.00") and event.realized_gain == D("-8.00")
    assert event.net == D("34.50")
    assert holding(f.ledger, pos.id) == Holding(D("0"), D("0"))
    assert holding(f.ledger, pos.id).average_price is None
    assert inv.remaining_cost(f.ledger, pos.id) == 0
    feb = YearMonth(year=2026, month=2)
    assert category_total(f, inv.LOSS_CATEGORY, feb) == D("8.00")
    assert category_total(f, inv.TAX_CATEGORY, feb) == D("0.50")
    assert category_total(f, inv.FEE_CATEGORY, feb) == D("1.00")


def test_explicit_method_overrides_the_class_default() -> None:
    assert default_method(AssetClass.STOCK) is CostMethod.AVERAGE
    assert default_method(AssetClass.FIXED_INCOME) is CostMethod.FIFO
    f = funded()
    pos = stock(f)
    buy(f.ledger, pos.id, START, "1", "10.00", f.bank)
    buy(f.ledger, pos.id, date(2026, 1, 2), "1", "20.00", f.bank)
    event = sell(f.ledger, pos.id, date(2026, 1, 3), "1", "20.00", f.bank, method=CostMethod.FIFO)
    assert event.cost_attributed == D("10.00")


def test_split_bonus_and_quantity_replay() -> None:
    f = funded()
    pos = stock(f)
    with pytest.raises(DomainError, match=exact("Fator inválido.")):
        split(f.ledger, pos.id, START, "0")
    with pytest.raises(DomainError, match=exact("Quantidade ou custo inválidos.")):
        bonus(f.ledger, pos.id, START, "0")
    with pytest.raises(DomainError, match=exact("Quantidade ou custo inválidos.")):
        bonus(f.ledger, pos.id, START, "1", "-1")
    buy(f.ledger, pos.id, START, "10", "10.00", f.bank)
    split(f.ledger, pos.id, date(2026, 2, 1), "2")
    assert holding(f.ledger, pos.id) == Holding(D("20"), D("100.00"))  # cost unchanged
    free = bonus(f.ledger, pos.id, date(2026, 3, 1), "2")
    assert free.operation_ids == () and free.gross == 0
    paid = bonus(f.ledger, pos.id, date(2026, 3, 2), "1", "15.00")
    assert len(paid.operation_ids) == 1
    assert category_total(f, inv.INCOME_CATEGORY, YearMonth(year=2026, month=3)) == D("15.00")
    sell(f.ledger, pos.id, date(2026, 4, 1), "3", "10.00", f.bank)
    assert quantity_on(f.ledger, pos.id, date(2025, 12, 31)) == 0
    assert quantity_on(f.ledger, pos.id, date(2026, 1, 31)) == D("10")
    assert quantity_on(f.ledger, pos.id, date(2026, 2, 1)) == D("20")
    assert quantity_on(f.ledger, pos.id, date(2026, 3, 2)) == D("23")
    assert quantity_on(f.ledger, pos.id, date(2026, 4, 1)) == D("20") == holding(f.ledger, pos.id).quantity


def test_opening_lot_guards_and_zero_cost() -> None:
    f = funded()
    pos = stock(f)
    for qty, cost in (("0", "10"), ("1", "-1")):
        with pytest.raises(DomainError, match=exact("Quantidade ou custo inválidos.")):
            opening_lot(f.ledger, pos.id, START, qty, cost)
    operations = len(f.ledger.operations)
    lot = opening_lot(f.ledger, pos.id, START, "5", "0")
    assert lot.source == "posição inicial" and len(f.ledger.operations) == operations
    assert quantity_on(f.ledger, pos.id, START) == D("5")


# ── performance and returns ────────────────────────


def test_period_result_and_simple_return_need_matching_endpoints() -> None:
    f = funded()
    pos = cdb(f)
    end = date(2026, 3, 31)
    assert period_result(f.ledger, pos.id, START, end).notes == (
        "Faltam avaliações exatamente no início e no fim do período.",
    )
    inv.add_valuation(f.ledger, pos.id, end, "10200", ValueNature.NET_INFORMED)
    mixed = period_result(f.ledger, pos.id, START, end)
    assert mixed.value is None and mixed.quality is Quality.UNAVAILABLE and "naturezas" in mixed.notes[0]
    assert simple_return(f.ledger, pos.id, START, end).notes == ("Naturezas diferentes nos extremos.",)
    assert simple_return(f.ledger, pos.id, START, date(2026, 2, 1)).notes == ("Faltam avaliações no início e no fim.",)


def test_simple_return_needs_a_positive_start_and_can_leave_distributions_out() -> None:
    f = funded()
    zero = inv.create_position(f.ledger, "Zerado", AssetClass.OTHER, START, reference_value="0")
    inv.add_valuation(f.ledger, zero.id, date(2026, 2, 1), "10", ValueNature.GROSS)
    assert simple_return(f.ledger, zero.id, START, date(2026, 2, 1)).notes == ("Valor inicial não positivo.",)
    pos = cdb(f)
    inv.distribute(f.ledger, pos.id, "200.00", date(2026, 2, 15), f.bank)
    inv.add_valuation(f.ledger, pos.id, date(2026, 3, 31), "10100", ValueNature.GROSS)
    without = simple_return(f.ledger, pos.id, START, date(2026, 3, 31), include_distributions=False)
    assert without.value == D("0.01") and without.notes == ("sem anualização",)


def test_unrealized_quality_depends_on_valuation_age_and_nature() -> None:
    f = funded()
    pos = cdb(f)
    assert unrealized(f.ledger, pos.id, date(2025, 12, 31)).notes == ("Sem avaliação até a data.",)
    fresh = unrealized(f.ledger, pos.id, date(2026, 2, 15))
    assert fresh.value == 0 and fresh.quality is Quality.OBSERVED
    old = unrealized(f.ledger, pos.id, date(2026, 2, 16))  # 46 days after the only valuation
    assert old.quality is Quality.ESTIMATE and old.notes[-1] == "avaliação antiga"
    inv.add_valuation(f.ledger, pos.id, date(2026, 3, 1), "9900", ValueNature.NET_ESTIMATED)
    net = unrealized(f.ledger, pos.id, date(2026, 3, 1))
    assert net.value is None and net.notes[0].startswith("Última avaliação não é bruta")


def test_external_flows_skip_events_without_amounts() -> None:
    f = funded()
    pos = cdb(f)
    for kind in (EventKind.CONTRIBUTION, EventKind.WITHDRAWAL, EventKind.SPLIT):
        f.ledger.put("investment_event", InvestmentEvent(position_id=pos.id, kind=kind, on=date(2026, 1, 10)))
    f.ledger.put(
        "investment_event",
        InvestmentEvent(position_id=pos.id, kind=EventKind.WITHDRAWAL, on=date(2026, 1, 11), net=D("40")),
    )
    flows = external_flows(f.ledger, pos.id, START, date(2026, 1, 31))
    assert [(fl.on, fl.amount) for fl in flows] == [(date(2026, 1, 11), D("-40"))]
    # The opening contribution happened on START itself: flows are strictly after `after`.
    assert [fl.amount for fl in external_flows(f.ledger, pos.id, date(2025, 12, 31), START)] == [D("10000.00")]


def test_composition_skips_future_and_emptied_positions_and_flags_missing_values() -> None:
    f = funded()
    held = cdb(f)
    future = cdb(f, on=date(2026, 6, 1))
    emptied = cdb(f)
    inv.add_valuation(f.ledger, emptied.id, date(2026, 1, 10), "0", ValueNature.GROSS)
    f.ledger.put("position", inv.position(f.ledger, emptied.id).model_copy(update={"closed": True}), reason="teste")
    unvalued = inv.create_position(
        f.ledger, "Sem valor", AssetClass.STOCK, START, mode=TrackingMode.QUANTITY, ticker="VALE3"
    )
    result = composition(f.ledger, date(2026, 1, 31))
    ids = [line.position_id for line in result.lines]
    assert held.id in ids and unvalued.id in ids
    assert future.id not in ids and emptied.id not in ids
    assert result.partial and result.total == D("10000.00")


def test_twr_chains_subperiods_around_flows() -> None:
    f = funded()
    pos = cdb(f, cost="1000")
    inv.contribute(f.ledger, pos.id, "500", date(2026, 2, 1), f.bank)
    inv.add_valuation(f.ledger, pos.id, date(2026, 2, 1), "1600", ValueNature.GROSS)
    inv.add_valuation(f.ledger, pos.id, date(2026, 3, 1), "1700", ValueNature.GROSS)
    result = twr(f.ledger, pos.id, START, date(2026, 3, 1))
    # (1600 − 500) / 1000 × 1700 / 1600 − 1
    assert result.value == D("0.16875") and result.quality is Quality.OBSERVED


def test_twr_unavailable_cases() -> None:
    f = funded()
    pos = cdb(f, cost="1000")
    inv.contribute(f.ledger, pos.id, "500", date(2026, 2, 1), f.bank)
    inv.add_valuation(f.ledger, pos.id, date(2026, 3, 1), "1700", ValueNature.GROSS)
    missing = twr(f.ledger, pos.id, START, date(2026, 3, 1))
    assert missing.value is None and "01/02/2026" in missing.notes[0]
    zero = inv.create_position(f.ledger, "Zero", AssetClass.OTHER, START, reference_value="0")
    inv.add_valuation(f.ledger, zero.id, date(2026, 2, 1), "10", ValueNature.GROSS)
    assert twr(f.ledger, zero.id, START, date(2026, 2, 1)).notes == ("Valor não positivo em 01/01/2026.",)
    inv.add_valuation(f.ledger, zero.id, date(2026, 3, 1), "10", ValueNature.NET_INFORMED)
    assert twr(f.ledger, zero.id, START, date(2026, 3, 1)).notes == ("Série mistura valores brutos e líquidos.",)


def test_dietz_and_xirr_unavailable_cases() -> None:
    f = funded()
    pos = cdb(f, cost="1000")
    end = date(2026, 3, 1)
    for method in (modified_dietz, xirr):
        assert method(f.ledger, pos.id, START, end).notes == ("Faltam avaliações no início e no fim.",)
    assert modified_dietz(f.ledger, pos.id, START, START).notes == ("Período de duração zero.",)
    inv.add_valuation(f.ledger, pos.id, end, "990", ValueNature.NET_INFORMED)
    for method in (modified_dietz, xirr):
        assert method(f.ledger, pos.id, START, end).notes == ("Série mistura valores brutos e líquidos.",)


def test_dietz_rejects_a_non_positive_denominator() -> None:
    f = funded()
    pos = cdb(f, cost="100")
    inv.redeem(f.ledger, pos.id, date(2026, 1, 2), "1000", f.bank, cost_attributed="0")
    inv.add_valuation(f.ledger, pos.id, date(2026, 1, 11), "50", ValueNature.GROSS)
    result = modified_dietz(f.ledger, pos.id, START, date(2026, 1, 11))
    assert result.value is None and result.notes[0].startswith("Denominador zero ou negativo")


def test_dietz_estimate_with_a_mid_period_contribution() -> None:
    f = funded()
    pos = cdb(f, cost="1000")
    inv.contribute(f.ledger, pos.id, "100", date(2026, 1, 6), f.bank)
    inv.add_valuation(f.ledger, pos.id, date(2026, 1, 11), "1150", ValueNature.GROSS)
    result = modified_dietz(f.ledger, pos.id, START, date(2026, 1, 11))
    # (1150 − 1000 − 100) / (1000 + 100 × 5/10)
    assert result.value == D("50") / D("1050") and result.quality is Quality.ESTIMATE


def test_xirr_of_a_one_year_ten_percent_investment() -> None:
    rate, reason = xirr_from_flows([(date(2025, 1, 1), D("-100")), (date(2026, 1, 1), D("110"))])
    assert reason == "" and rate is not None and abs(rate - D("0.1")) < D("1e-9")


@pytest.mark.parametrize(
    ("flows", "reason"),
    [
        (
            [(date(2025, 1, 1), D("-100")), (date(2026, 1, 1), D("-10"))],
            "É preciso ao menos um fluxo negativo e um positivo.",
        ),
        # Positive NPV at every rate: lending 1 and getting 100 back the same day plus a loss later.
        (
            [(date(2025, 1, 1), D("100")), (date(2025, 1, 1), D("-1")), (date(2026, 1, 1), D("1"))],
            "Sem solução no domínio r > −100%.",
        ),
        # −100, +230, −132 has roots at 10% and 20%: no rate is chosen arbitrarily.
        (
            [(date(2024, 1, 1), D("-100")), (date(2025, 1, 1), D("230")), (date(2026, 1, 1), D("-132"))],
            "Múltiplas raízes possíveis; taxa não escolhida arbitrariamente.",
        ),
    ],
)
def test_xirr_without_a_unique_root_is_unavailable(flows: list[tuple[date, Decimal]], reason: str) -> None:
    assert xirr_from_flows(flows) == (None, reason)


def test_xirr_of_a_position_flags_short_periods() -> None:
    f = funded()
    pos = cdb(f, cost="1000")
    inv.add_valuation(f.ledger, pos.id, date(2026, 7, 2), "1050", ValueNature.GROSS)
    result = xirr(f.ledger, pos.id, START, date(2026, 7, 2))
    assert result.value is not None and result.value > D("0.05")
    assert "período menor que um ano" in result.notes[-1]
    flat = cdb(f, cost="1000")
    inv.add_valuation(f.ledger, flat.id, date(2026, 7, 2), "0", ValueNature.GROSS)
    lost = xirr(f.ledger, flat.id, START, date(2026, 7, 2))
    assert lost.value is None and lost.notes == ("É preciso ao menos um fluxo negativo e um positivo.",)


# ── simulation ─────────────────────────────────────


def test_tax_rules_by_kind_and_validity() -> None:
    fixed = TaxRule(name="Taxa fixa", kind=TaxRuleKind.FIXED, fixed_amount=D("12.34"))
    on_gain = TaxRule(name="15%", kind=TaxRuleKind.RATE_ON_POSITIVE_GAIN, rate=D("0.15"))
    on_base = TaxRule(
        name="Base",
        kind=TaxRuleKind.RATE_ON_INFORMED_BASE,
        rate=D("0.1"),
        valid_from=date(2026, 1, 1),
        valid_to=date(2026, 12, 31),
    )
    assert tax_for(fixed, None) == D("12.34")
    assert tax_for(TaxRule(name="Sem valor", kind=TaxRuleKind.FIXED), None) == 0
    assert tax_for(on_gain, D("-50")) == 0  # a loss is not taxed
    assert tax_for(on_gain, D("33.33")) == D("5.00")  # 4.9995 → half-up
    assert tax_for(on_gain, None) is None
    assert tax_for(on_base, D("100"), None, date(2026, 6, 1)) is None
    assert tax_for(on_base, None, D("100.05"), date(2026, 6, 1)) == D("10.01")
    for outside in (date(2025, 12, 31), date(2027, 1, 1)):
        with pytest.raises(DomainError, match=exact("Regra fora da vigência na data.")):
            tax_for(on_base, D("1"), D("1"), outside)


def test_simulation_with_informed_cost_fixed_rule_and_informed_base() -> None:
    f = funded()
    pos = cdb(f)
    operations = len(f.ledger.operations)
    fixed = TaxRule(name="Fixa", kind=TaxRuleKind.FIXED, fixed_amount=D("10"))
    sim = simulate(f.ledger, pos.id, date(2026, 2, 1), "3000", fixed, cost_attributed="2500")
    assert (sim.cost_method, sim.gain, sim.tax, sim.tax_base, sim.net) == (
        "custo informado",
        D("500"),
        D("10"),
        None,
        D("2990"),
    )
    assert sim.estimated_fields == ("imposto (simulado: Fixa)",) and sim.remaining_cost == D("7500.00")
    assert sim.remaining_value is None and sim.rule == "Fixa v1 (informado pelo usuário)"
    base_rule = TaxRule(name="Base", kind=TaxRuleKind.RATE_ON_INFORMED_BASE, rate=D("0.2"))
    based = simulate(f.ledger, pos.id, date(2026, 2, 1), "3000", base_rule, cost_attributed="2500", informed_base="100")
    assert (based.tax_base, based.tax, based.net_gain) == (D("100"), D("20.0"), D("480"))
    assert len(f.ledger.operations) == operations  # a simulation never writes


def test_simulation_with_zero_cost_has_no_return_ratio() -> None:
    f = funded()
    pos = cdb(f)
    rule = TaxRule(name="15%", kind=TaxRuleKind.RATE_ON_POSITIVE_GAIN, rate=D("0.15"))
    sim = simulate(f.ledger, pos.id, START, "100", rule, cost_attributed="0")
    assert sim.gain == D("100") and sim.gross_return is None and sim.net_return is None


# ── benchmarks ─────────────────────────────────────


def test_benchmark_csv_import_and_return() -> None:
    f = funded()
    data = b"data;valor\n01/01/2026;1.000,00\nlinha solta\n31/01/2026;1.010,50\n28/02/2026;1020.5\n"
    bench = import_benchmark_csv(f.ledger, "CDI", data, "arquivo do usuário")
    assert bench.points == (
        (date(2026, 1, 1), D("1000.00")),
        (date(2026, 1, 31), D("1010.50")),
        (date(2026, 2, 28), D("1020.5")),
    )
    result = benchmark_return(bench, date(2026, 1, 1), date(2026, 1, 31))
    assert result.value == D("0.0105") and result.quality is Quality.OBSERVED
    assert benchmark_return(bench, date(2026, 1, 2), date(2026, 1, 31)).value is None


def test_benchmark_csv_with_commas_and_bad_rows() -> None:
    f = funded()
    comma = import_benchmark_csv(f.ledger, "IPCA", b"01/01/2026,100\n01/02/2026,101\n", "x")
    assert [level for _, level in comma.points] == [D("100"), D("101")]
    with pytest.raises(DomainError, match=exact("Valor inválido na linha de 01/02/2026.")):
        import_benchmark_csv(f.ledger, "X", b"01/01/2026;100\n01/02/2026;abc\n", "x")
    with pytest.raises(DomainError, match=exact("O arquivo precisa de ao menos duas datas com valores.")):
        import_benchmark_csv(f.ledger, "X", b"01/01/2026;100\n01/01/2026;101\n", "x")


@pytest.mark.parametrize(
    ("written", "level"),
    [
        ("1.234", D("1234")),  # Brazilian thousands, not 1.234
        ("12.345.678", D("12345678")),
        ("1.234,5", D("1234.5")),
        ("1234.56", D("1234.56")),  # a decimal point outside thousands positions stays a decimal
        ("1.5", D("1.5")),
    ],
)
def test_benchmark_levels_follow_the_brazilian_format(written: str, level: Decimal) -> None:
    f = funded()
    bench = import_benchmark_csv(f.ledger, "X", f"01/01/2026;1\n01/02/2026;{written}\n".encode(), "x")
    assert bench.points[1][1] == level


def test_benchmark_with_non_positive_start_is_unavailable() -> None:
    f = funded()
    bench = import_benchmark_csv(f.ledger, "X", b"01/01/2026;0\n01/02/2026;1\n", "x")
    assert benchmark_return(bench, date(2026, 1, 1), date(2026, 2, 1)).notes == ("Nível inicial não positivo.",)


# ── brokerage notes ────────────────────────────────


@pytest.mark.parametrize(
    ("spec", "ticker", "expected"),
    [
        ("FII HGLG11 CI", "HGLG11", AssetClass.REIT),
        ("ETF ISHARES BOVA11", "BOVA11", AssetClass.ETF),
        # "CI" marks quotas of both kinds; the issuer's name tells an ETF apart.
        ("ISHARES BOVA11 CI ER", "BOVA11", AssetClass.ETF),
        ("IT NOW IMAB CI", "IMAB11", AssetClass.ETF),
        ("TREND ACWI CI", "ACWI11", AssetClass.ETF),
        ("FII XPML11 CI ER", "XPML11", AssetClass.REIT),
        ("XPLOG CI", "XPLG11", AssetClass.REIT),
        ("PETROBRAS PN", "PETR4", AssetClass.STOCK),
        ("DEBENTURE XYZ", None, AssetClass.OTHER),
    ],
)
def test_guess_class(spec: str, ticker: str | None, expected: AssetClass) -> None:
    assert guess_class(spec, ticker) is expected


def test_position_for_reuses_open_quantity_positions() -> None:
    f = funded()
    first = position_for(f.ledger, "PETR4", "Compra PETROBRAS PN", START)
    again = position_for(f.ledger, "PETR4", "Venda PETROBRAS PN", START)
    assert first.id == again.id and first.mode is TrackingMode.QUANTITY
    by_name = position_for(f.ledger, None, "Compra DEBENTURE XYZ", START)
    assert inv.assets(f.ledger)[by_name.asset_id].name == "DEBENTURE XYZ"
    assert position_for(f.ledger, None, "Venda DEBENTURE XYZ", START).id == by_name.id


def test_position_for_accepts_a_description_without_spaces() -> None:
    f = funded()
    pos = position_for(f.ledger, None, "DEBENTURE", START)
    assert inv.assets(f.ledger)[pos.asset_id].name == "DEBENTURE"
    assert position_for(f.ledger, None, "DEBENTURE", START).id == pos.id


def _batch(f: Family, *, account: bool = True, trade_date: date | None = START) -> ImportBatch:
    return ImportBatch(
        document_id=uuid4(),
        parser_id="teste",
        parser_version="1",
        doc_format=DocFormat.PDF,
        status=BatchStatus.IN_REVIEW,
        created_at=datetime(2026, 1, 2, tzinfo=UTC),
        account_id=f.bank if account else None,
        header=StatementHeader(trade_date=trade_date),
    )


def _trade(**fields: object) -> ExtractedItem:
    base: dict[str, object] = {
        "batch_id": uuid4(),
        "kind": ItemKind.TRADE,
        "occurred_on": START,
        "description": "Compra PETROBRAS PN",
        "amount": D("100"),
        "quantity": D("10"),
        "unit_price": D("10"),
        "ticker": "PETR4",
    }
    return ExtractedItem(**{**base, **fields})  # type: ignore[arg-type]


def test_approve_note_guards() -> None:
    f = funded()
    with pytest.raises(DomainError, match=r"^Escolha a conta"):
        approve_note(f.ledger, _batch(f, account=False), [_trade()])
    with pytest.raises(DomainError, match=exact("Nenhum negócio a incorporar.")):
        approve_note(f.ledger, _batch(f), [_trade(kind=ItemKind.FEE)])
    with pytest.raises(DomainError, match=exact("Há negócios sem quantidade, preço ou valor.")):
        approve_note(f.ledger, _batch(f), [_trade(quantity=None)])
    with pytest.raises(DomainError, match=exact("Data do pregão desconhecida.")):
        approve_note(f.ledger, _batch(f, trade_date=None), [_trade()])
    assert inv.positions(f.ledger) == {}  # nothing was created by a refused note


# ── plain strings at the entry points (Qt combos return StrEnum values as str) ──


def test_create_position_accepts_plain_string_enums() -> None:
    f = funded()
    pos = inv.create_position(f.ledger, "PETR4", "stock", START, mode="quantity", ticker="PETR4")  # type: ignore[arg-type]
    assert pos.mode is TrackingMode.QUANTITY and pos.cost_known
    ref = inv.create_position(
        f.ledger,
        "Fundo",
        "fund",  # type: ignore[arg-type]
        START,
        reference_value="100",
        reference_nature="net_informed",  # type: ignore[arg-type]
    )
    assert inv.valuations_of(f.ledger, ref.id)[0].nature is ValueNature.NET_INFORMED


def test_sell_with_a_plain_string_method_uses_that_method() -> None:
    f = funded()
    pos = inv.create_position(f.ledger, "Tesouro", AssetClass.TREASURY, START, mode=TrackingMode.QUANTITY)
    buy(f.ledger, pos.id, START, "1", "10.00", f.bank)
    buy(f.ledger, pos.id, date(2026, 1, 2), "1", "20.00", f.bank)
    event = sell(f.ledger, pos.id, date(2026, 1, 3), "1", "20.00", f.bank, method="average")  # type: ignore[arg-type]
    assert event.cost_attributed == D("15.00") and event.cost_method is not None
    assert event.cost_method.startswith("custo médio")


def test_valuation_natures_accept_plain_strings() -> None:
    f = funded()
    pos = cdb(f)
    added = inv.add_valuation(f.ledger, pos.id, date(2026, 2, 1), "10100", "gross", source="extrato")  # type: ignore[arg-type]
    assert added.nature is ValueNature.GROSS
    fixed = inv.correct_valuation(f.ledger, added.id, "10090", "era líquido", "net_informed")  # type: ignore[arg-type]
    assert fixed.nature is ValueNature.NET_INFORMED
    found = value_at(f.ledger, pos.id, date(2026, 2, 1), "net_informed")  # type: ignore[arg-type]
    assert found is not None and found.valuation.id == added.id
    with pytest.raises(ValueError):
        inv.add_valuation(f.ledger, pos.id, date(2026, 2, 2), "1", "bruto")  # type: ignore[arg-type]


@pytest.mark.parametrize("amount", ["0", "-50"])
def test_tax_payment_must_be_positive(amount: str) -> None:
    f = funded()
    with pytest.raises(DomainError, match="pagamento de imposto inválido"):
        inv.pay_tax(f.ledger, amount, date(2026, 2, 28), f.bank)
