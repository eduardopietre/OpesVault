"""Every chart the app draws, built on the demo vault and on an empty one (charts/data).

Each builder must run without an error on both, keep money exact (Decimal or unknown, never a
float), and its table of values must say the same as its series: one row per x, the total of a
flow equal to the sum of its known values, and no total for positions such as balances.
"""

from collections.abc import Callable
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from opesvault.charts import data as charts
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountType, YearMonth
from opesvault.domain.money import ZERO
from opesvault.investments import service as inv
from opesvault.session import Session

from .demo_vault import demo_session

START, END = YearMonth(year=2026, month=1), YearMonth(year=2026, month=6)
TODAY = date(2026, 3, 31)


def _first(ids: object) -> object:
    return next(iter(ids), None)  # type: ignore[call-overload]


def builders(ledger: Ledger) -> dict[str, Callable[[], charts.Chart]]:
    """Every public builder with arguments taken from what this ledger holds (or plain ones)."""
    from opesvault.domain import goals, loans, tags

    expense = ledger.categories(AccountType.EXPENSE)[0]
    account = next((a for a in ledger.accounts.values() if a.type is AccountType.ASSET), None)
    position = _first(inv.positions(ledger))
    card = _first(ledger.cards)
    plan = _first(loans.plans(ledger))
    goal = _first(g.id for g in goals.goals(ledger))
    tag = _first(tags.all_tags(ledger))
    found: dict[str, Callable[[], charts.Chart]] = {
        "monthly_in_out": lambda: charts.monthly_in_out(ledger, START, END),
        "monthly_result": lambda: charts.monthly_result(ledger, START, END),
        "cash_flow_balance": lambda: charts.cash_flow_balance(ledger, START, END),
        "monthly_summary": lambda: charts.monthly_summary(ledger, START, END),
        "projected_balance": lambda: charts.projected_balance(ledger, TODAY),
        "commitments_projection": lambda: charts.commitments_projection(ledger, START),
        "annual_chart": lambda: charts.annual_chart(ledger, 2026),
        "expenses_by_category": lambda: charts.expenses_by_category(ledger, START, END),
        "category_monthly": lambda: charts.category_monthly(ledger, expense.id, START, END),
        "category_comparison_chart": lambda: charts.category_comparison_chart(ledger, YearMonth(year=2026, month=3)),
        "budget_history": lambda: charts.budget_history(ledger, START, END),
        "tags_overview": lambda: charts.tags_overview(ledger),
        "merchants_chart": lambda: charts.merchants_chart(ledger, date(2026, 1, 1), date(2026, 6, 30)),
        "net_worth_series": lambda: charts.net_worth_series(ledger, START, END),
        "portfolio_composition": lambda: charts.portfolio_composition(ledger, TODAY),
    }
    if account is not None:
        found["account_balance_history"] = lambda: charts.account_balance_history(ledger, account.id, START, END)
    if tag is not None:
        found["tag_chart"] = lambda: charts.tag_chart(ledger, tag)  # type: ignore[arg-type]
    if card is not None:
        found["card_bills_history"] = lambda: charts.card_bills_history(ledger, card, [START, START.add(1)])  # type: ignore[arg-type]
    if plan is not None:
        found["loan_chart"] = lambda: charts.loan_chart(ledger, plan)  # type: ignore[arg-type]
    if goal is not None:
        found["goal_chart"] = lambda: charts.goal_chart(ledger, goal, END)  # type: ignore[arg-type]
    if position is not None:
        found["investment_evolution"] = lambda: charts.investment_evolution(ledger, position)  # type: ignore[arg-type]
        found["investment_result"] = lambda: charts.investment_result(ledger, position)  # type: ignore[arg-type]
        found["returns_chart"] = lambda: charts.returns_chart(ledger, position, date(2026, 1, 2), TODAY)  # type: ignore[arg-type]
    return found


def _check(name: str, chart: charts.Chart) -> None:
    assert chart.title and chart.unit in ("BRL", "%"), name
    for series in chart.series:
        for point in series.points:
            assert point.y is None or isinstance(point.y, Decimal), f"{name}: {series.name} has {point.y!r}"
    headers, rows = charts.table_rows(chart)
    assert headers == [s.name for s in chart.series]
    data = [r for r in rows if r.x is not None]
    xs = {p.x for s in chart.series for p in s.points}
    assert len(data) == len(xs), f"{name}: one row per x"
    total = next((r for r in rows if r.label == "Total"), None)
    if total is None:
        return
    for column, series in enumerate(chart.series):
        known = [r.values[column] for r in data if r.values[column] is not None]
        if series.adds_up and known:
            assert total.values[column] == sum((v for v in known if v is not None), ZERO), f"{name}: {series.name}"
        else:
            assert total.values[column] is None, f"{name}: {series.name} is a position, no total"


def test_every_builder_is_covered_here() -> None:
    """A new chart builder must be added to `builders` (and so to these checks)."""
    helpers = {"month_name", "months_between", "table_rows"}
    public = {name for name in charts.__all__ if name[0].islower()} - helpers
    assert public <= set(builders(demo_session(Path("/nonexistent/demo.opesvault")).ledger))


@pytest.mark.parametrize("vault", ["demo", "empty"])
def test_every_chart_builds_and_its_table_agrees(vault: str, tmp_path: Path) -> None:
    session = demo_session(tmp_path / "d.opesvault") if vault == "demo" else Session.new(tmp_path / "e.opesvault")
    built = builders(session.ledger)
    if vault == "demo":
        assert {"loan_chart", "goal_chart", "investment_evolution", "tag_chart"} <= set(built)
    for name, build in built.items():
        _check(name, build())
