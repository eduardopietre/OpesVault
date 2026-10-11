"""Chart datasets and rendering (docs/07 §4-5).

Datasets keep provenance in each point and never turn missing data into zero; the
widget shows that provenance in tooltips and hands the clicked point to the page.
"""

from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from matplotlib.backend_bases import MouseButton, MouseEvent
from PySide6.QtWidgets import QApplication

from opesvault.charts import data
from opesvault.charts.data import Chart, Point, Series
from opesvault.charts.render import ChartWidget, _label, _month_tick, draw
from opesvault.domain.cards import record_installment_purchase
from opesvault.domain.model import (
    AccountSubtype,
    AccountType,
    LedgerAccount,
    Operation,
    OperationKind,
    Posting,
    YearMonth,
)
from opesvault.domain.recurrence import RecurrenceRule, add_rule, skip
from opesvault.investments import service as inv
from opesvault.investments.model import AssetClass, TrackingMode, ValueNature

from .domain_fixtures import Family, family

D = Decimal
JAN, FEB, MAR = YearMonth(year=2026, month=1), YearMonth(year=2026, month=2), YearMonth(year=2026, month=3)


@pytest.fixture
def app() -> QApplication:
    instance = QApplication.instance()
    return instance if isinstance(instance, QApplication) else QApplication([])


def ys(series: Series) -> list[Decimal | None]:
    return [p.y for p in series.points]


# ── datasets ───────────────────────────────────────


def test_monthly_in_out_scope_depends_on_the_selection() -> None:
    f = family()
    f.ledger.record_income(f.bank, f.salary, "1000.00", date(2026, 1, 5), "Salário")
    f.ledger.record_transfer(f.bank, f.savings, "300.00", date(2026, 1, 6))
    consolidated = data.monthly_in_out(f.ledger, JAN, FEB)
    inflow, outflow = consolidated.series
    assert ys(inflow) == [D("1000.00"), D("0")] and ys(outflow) == [D("0"), D("0")]  # internal transfer excluded
    assert consolidated.regime == "caixa" and "consolidado" in consolidated.notes[0]
    bank_only = data.monthly_in_out(f.ledger, JAN, JAN, [f.bank])
    assert ys(bank_only.series[1]) == [D("300.00")]
    assert bank_only.series[0].points[0].info == {"regime": "caixa", "contas": "contas selecionadas"}


def test_monthly_result_member_view() -> None:
    f = family()
    f.ledger.record_income(f.bank, f.salary, "1000.00", date(2026, 1, 5), "Salário", member_id=f.ana)
    f.ledger.record_expense(f.bank, f.groceries, "200.00", date(2026, 1, 6), "Mercado", member_id=f.bruno)
    family_view = data.monthly_result(f.ledger, JAN, JAN)
    assert ys(family_view.series[0]) == [D("800.00")] and len(family_view.notes) == 1
    ana = data.monthly_result(f.ledger, JAN, JAN, f.ana)
    assert ana.title.endswith(" · Ana") and ys(ana.series[0]) == [D("1000.00")]
    assert ana.notes[1].startswith("Visão de Ana")


def test_cash_flow_balance_adds_month_end_balances() -> None:
    f = family()
    f.ledger.record_opening_balance(f.bank, "100.00", date(2025, 12, 31))
    f.ledger.record_income(f.bank, f.salary, "50.00", date(2026, 2, 5), "Salário")
    chart = data.cash_flow_balance(f.ledger, JAN, FEB)
    balance = chart.series[2]
    assert balance.style == "line" and ys(balance) == [D("100.00"), D("150.00")]
    only_savings = data.cash_flow_balance(f.ledger, JAN, JAN, [f.savings])
    assert ys(only_savings.series[2]) == [D("0")]


def test_expenses_by_category_are_net_of_refunds_and_say_so() -> None:
    f = family()
    health = next(a.id for a in f.ledger.categories(AccountType.EXPENSE) if a.name == "Saúde")
    f.ledger.record_expense(f.bank, f.groceries, "50.00", date(2026, 1, 5), "Mercado")
    f.ledger.record_expense(f.bank, health, "80.00", date(2026, 1, 6), "Farmácia")
    f.ledger.add_operation(
        Operation(
            kind=OperationKind.REFUND,
            description="Estorno mercado",
            postings=(
                Posting(account_id=f.bank, amount=D("10.00")),
                Posting(account_id=f.groceries, amount=D("-10.00")),
            ),
            occurred_on=date(2026, 1, 7),
            settled_on=date(2026, 1, 7),
        )
    )
    chart = data.expenses_by_category(f.ledger, JAN, JAN)
    points = chart.series[0].points
    assert [(p.x, p.y) for p in points] == [("Saúde", D("80.00")), ("Alimentação", D("40.00"))]
    assert points[0].info == {} and points[1].info == {"estornos no período": "10.00"}


def test_category_monthly_includes_sub_categories_at_any_depth() -> None:
    f = family()
    market = f.ledger.add_account(
        LedgerAccount(name="Mercado", type=AccountType.EXPENSE, subtype=AccountSubtype.CATEGORY, parent_id=f.groceries)
    )
    fair = f.ledger.add_account(
        LedgerAccount(name="Feira", type=AccountType.EXPENSE, subtype=AccountSubtype.CATEGORY, parent_id=market.id)
    )
    health = next(a.id for a in f.ledger.categories(AccountType.EXPENSE) if a.name == "Saúde")
    f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 1, 5), "a")
    f.ledger.record_expense(f.bank, market.id, "20.00", date(2026, 1, 6), "b")
    f.ledger.record_expense(f.bank, fair.id, "5.00", date(2026, 2, 6), "c")
    f.ledger.record_expense(f.bank, health, "99.00", date(2026, 1, 6), "d")
    chart = data.category_monthly(f.ledger, f.groceries, JAN, MAR)
    assert chart.title == "Despesas: Alimentação" and chart.regime == "competência"
    assert ys(chart.series[0]) == [D("30.00"), D("5.00"), D("0")]
    assert ys(data.category_monthly(f.ledger, market.id, JAN, FEB).series[0]) == [D("20.00"), D("5.00")]


def _priced_position(f: Family):  # type: ignore[no-untyped-def]
    f.ledger.record_opening_balance(f.bank, "10000.00", date(2025, 12, 31))
    return inv.create_position(
        f.ledger, "CDB", AssetClass.FIXED_INCOME, date(2026, 1, 1), initial_cost="1000", from_account=f.bank
    )


def test_net_worth_series_flags_partial_portfolios() -> None:
    f = family()
    _priced_position(f)
    complete = data.net_worth_series(f.ledger, JAN, JAN)
    assert [s.name for s in complete.series] == ["Ativos", "Passivos", "Patrimônio líquido"]
    assert ys(complete.series[2]) == [D("10000.00")]  # a contribution moves money, it does not create it
    assert "carteira" not in complete.series[0].points[0].info
    inv.create_position(f.ledger, "Ações", AssetClass.STOCK, date(2026, 1, 2), mode=TrackingMode.QUANTITY)
    partial = data.net_worth_series(f.ledger, JAN, JAN)
    assert partial.series[0].points[0].info["carteira"] == "parcial (ativos sem avaliação)"


def test_investment_evolution_separates_natures_and_marks_flows() -> None:
    f = family()
    pos = _priced_position(f)
    inv.add_valuation(f.ledger, pos.id, date(2026, 2, 1), "1010", ValueNature.NET_INFORMED, source="extrato")
    inv.distribute(f.ledger, pos.id, "5.00", date(2026, 2, 10), f.bank)
    inv.redeem_net_only(f.ledger, pos.id, date(2026, 2, 15), "100", f.bank)
    chart = data.investment_evolution(f.ledger, pos.id)
    names = [s.name for s in chart.series]
    assert names == ["Valor bruto", "Valor líquido informado", "Aporte", "Resgate", "Provento"]
    redemption = chart.series[3].points[0]
    assert redemption.y == D("100") and redemption.info == {"evento": "Resgate", "qualidade": "incomplete"}
    assert chart.series[1].points[0].info["fonte"] == "extrato"


def test_investment_result_needs_gross_observations() -> None:
    f = family()
    net_only = inv.create_position(
        f.ledger,
        "Fundo",
        AssetClass.FUND,
        date(2026, 1, 1),
        reference_value="100",
        reference_nature=ValueNature.NET_INFORMED,
    )
    assert data.investment_result(f.ledger, net_only.id).series[0].points == []
    pos = _priced_position(f)
    inv.add_valuation(f.ledger, pos.id, date(2026, 2, 1), "1030", ValueNature.GROSS)
    points = data.investment_result(f.ledger, pos.id).series[0].points
    assert [(p.x, p.y) for p in points] == [(date(2026, 1, 1), D("0")), (date(2026, 2, 1), D("30"))]


def test_portfolio_composition_marks_positions_without_valuation() -> None:
    f = family()
    _priced_position(f)
    inv.create_position(f.ledger, "VALE3", AssetClass.STOCK, date(2026, 1, 2), mode=TrackingMode.QUANTITY)
    chart = data.portfolio_composition(f.ledger, date(2026, 1, 31))
    priced, unpriced = chart.series[0].points
    assert priced.y == D("1000") and priced.info["data-base"] == "01/01/2026 (30 dias)"
    assert unpriced.y is None and unpriced.info == {"classe": "Ações", "situação": "sem avaliação"}
    assert chart.notes[-1] == "Total parcial: há ativos sem avaliação."


def test_commitments_projection_sums_installments_and_pending_forecasts() -> None:
    f = family()
    record_installment_purchase(f.ledger, f.card, f.groceries, "100.00", date(2026, 1, 2), "Geladeira", 3)
    base = {"account_id": f.bank, "day": 15, "start": date(2026, 1, 1)}
    rent = add_rule(f.ledger, RecurrenceRule(description="Aluguel", counterpart_id=f.groceries, amount=D("50"), **base))
    add_rule(f.ledger, RecurrenceRule(description="Salário", counterpart_id=f.salary, amount=D("1000"), **base))
    skip(f.ledger, rent.id, date(2026, 2, 15))
    chart = data.commitments_projection(f.ledger, JAN, 3)
    installments, out, inflow = chart.series
    assert [p.x for p in installments.points] == ["2026-01", "2026-02", "2026-03"]
    assert ys(installments) == [D("33.34"), D("33.33"), D("33.33")]
    assert ys(out) == [D("50"), D("0"), D("50")]  # a skipped forecast is no longer a commitment
    assert ys(inflow) == [D("1000"), D("1000"), D("1000")]
    assert all(s.style == "forecast" for s in chart.series)


def test_returns_chart_lists_unavailable_methods_with_their_reason() -> None:
    f = family()
    pos = _priced_position(f)
    inv.contribute(f.ledger, pos.id, "500", date(2026, 1, 15), f.bank)
    inv.add_valuation(f.ledger, pos.id, date(2026, 2, 1), "1530", ValueNature.GROSS)
    chart = data.returns_chart(f.ledger, pos.id, date(2026, 1, 1), date(2026, 2, 1))
    assert chart.unit == "%" and chart.title == "Rentabilidade 01/01/2026 a 01/02/2026"
    by_label = {p.x: p for p in chart.series[0].points}
    assert by_label["retorno simples do período"].y is None
    assert by_label["TWR"].y is None  # no valuation on the contribution date, no interpolation
    assert by_label["XIRR"].y is not None and by_label["Modified Dietz"].y is not None
    assert chart.notes == [
        "retorno simples do período: indisponível — Há aportes ou retiradas no período: use TWR, XIRR ou Dietz.",
        "TWR: indisponível — Faltam avaliações nas datas de fluxo ou extremos (15/01/2026); não há interpolação.",
    ]


def test_months_between_is_inclusive_and_empty_when_reversed() -> None:
    assert data.months_between(YearMonth(year=2025, month=12), FEB) == [YearMonth(year=2025, month=12), JAN, FEB]
    assert data.months_between(FEB, JAN) == []


# ── rendering ──────────────────────────────────────


@pytest.mark.parametrize(
    ("value", "unit", "expected"),
    [(None, "BRL", "sem informação"), (D("0.1234"), "%", "12,34%"), (D("-1234.5"), "BRL", "-R$ 1.234,50")],
)
def test_value_labels(value: Decimal | None, unit: str, expected: str) -> None:
    assert _label(value, unit) == expected


@pytest.mark.parametrize(
    ("label", "expected"),
    [("2026-03", "mar/26"), ("2026-12", "dez/26"), ("2026-13", "2026-13"), ("Saúde", "Saúde"), ("26-03", "26-03")],
)
def test_month_ticks(label: str, expected: str) -> None:
    assert _month_tick(label) == expected


def _categorical_chart() -> Chart:
    info = {"regime": "caixa"}
    return Chart(
        "Teste",
        "BRL",
        [
            Series("Entradas", [Point("2026-01", D("100"), info), Point("2026-02", None), Point("2026-03", D("80"))]),
            Series("Previsto", [Point("2026-01", D("50"))], style="forecast"),
            Series("Saldo", [Point("2026-01", D("300")), Point("2026-02", D("320"))], style="line", marker_points=True),
            Series("Vazia", [Point("2026-01", None)], style="line"),
        ],
        ["Nota de rodapé"],
        "caixa",
    )


def _event_at(widget: ChartWidget, x: float, y: float, name: str = "motion_notify_event") -> MouseEvent:
    ax = widget.figure.axes[0]
    px, py = ax.transData.transform((x, y))
    return MouseEvent(name, widget.canvas, px, py, button=MouseButton.LEFT if name == "button_press_event" else None)


def test_draw_skips_missing_points_and_empty_series(app: QApplication) -> None:
    widget = ChartWidget()
    widget.show_chart(_categorical_chart())
    hover = widget._hover
    assert [name for _, _, name in hover] == ["Entradas", "Previsto", "Saldo"]  # "Vazia" has no known point
    entradas_points = hover[0][1]
    assert [p.x for p in entradas_points] == ["2026-01", "2026-03"]  # a gap, never zero
    ax = widget.figure.axes[0]
    assert [t.get_text() for t in ax.get_xticklabels()] == ["jan/26", "fev/26", "mar/26"]
    legend = ax.get_legend()
    assert legend is not None and len(legend.get_texts()) == 3


def test_hover_shows_provenance_and_click_inspects_the_point(app: QApplication) -> None:
    inspected: list[tuple[str, Point]] = []
    widget = ChartWidget(on_inspect=lambda name, point: inspected.append((name, point)))
    widget.resize(800, 450)
    widget.show_chart(_categorical_chart())
    widget.canvas.draw()
    annotation = widget._annotation
    assert annotation is not None
    # Two bar series share each slot: "Entradas" sits left of the label, "Previsto" right.
    widget._on_move(_event_at(widget, -0.2, 50))
    assert annotation.get_visible()
    assert annotation.get_text() == "Entradas\njan/26\nR$ 100,00 (BRL)\nregime: caixa\nregime: caixa"
    widget._on_move(_event_at(widget, 1, 320))  # the line marker of "Saldo" in February
    assert annotation.get_text().startswith("Saldo\nfev/26\nR$ 320,00 (BRL)")
    widget._on_move(_event_at(widget, 1.9, 250))  # empty area hides the tooltip
    assert not annotation.get_visible()
    widget._on_click(_event_at(widget, 0.2, 25, "button_press_event"))
    assert [(name, point.y) for name, point in inspected] == [("Previsto", D("50"))]
    widget._on_click(_event_at(widget, 1.9, 250, "button_press_event"))
    assert len(inspected) == 1


def test_events_outside_the_axes_are_ignored(app: QApplication) -> None:
    inspected: list[str] = []
    widget = ChartWidget(on_inspect=lambda name, _point: inspected.append(name))
    widget.show_chart(_categorical_chart())
    outside = MouseEvent("button_press_event", widget.canvas, -50, -50, button=MouseButton.LEFT)
    assert outside.inaxes is None
    widget._on_move(outside)
    widget._on_click(outside)
    assert inspected == [] and not widget._annotation.get_visible()  # type: ignore[union-attr]
    ChartWidget()._on_move(outside)  # no chart shown yet: nothing to do


def test_scatter_points_on_a_date_axis(app: QApplication) -> None:
    chart = Chart(
        "Evolução",
        "%",
        [
            Series("Valor", [Point(date(2026, 1, 1), D("0.1")), Point(date(2026, 2, 1), D("0.15"))], style="line"),
            Series("Aporte", [Point(date(2026, 1, 15), D("0.12"), {"evento": "Aporte"})], style="scatter"),
        ],
    )
    widget = ChartWidget()
    widget.resize(800, 450)
    widget.show_chart(chart)
    widget.canvas.draw()
    from matplotlib.dates import date2num

    widget._on_move(_event_at(widget, date2num(date(2026, 1, 15)), 0.12))
    assert widget._annotation.get_text() == "Aporte\n15/01/2026\n12,00%\nevento: Aporte"  # type: ignore[union-attr]


def test_tooltip_for_missing_values_and_charts_without_regime(app: QApplication) -> None:
    widget = ChartWidget()
    widget.show_chart(Chart("Sem regime", "BRL", [Series("S", [Point("Saúde", D("1"))])]))
    assert widget.tooltip_text("S", Point("Saúde", None)) == "S\nSaúde\nsem informação (BRL)"


def test_draw_writes_the_notes_as_a_footer(app: QApplication) -> None:
    from matplotlib.figure import Figure

    figure = Figure()
    draw(figure, _categorical_chart())
    assert "Nota de rodapé" in [t.get_text() for t in figure.texts]
    draw(figure, Chart("Sem notas", "BRL", [Series("S", [Point("a", D("1"))])]))
    assert figure.texts == [] and figure.axes[0].get_legend() is None


def test_export_png(app: QApplication, tmp_path: Path) -> None:
    widget = ChartWidget()
    widget.show_chart(_categorical_chart())
    target = tmp_path / "grafico.png"
    widget.export_png(str(target))
    assert target.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
