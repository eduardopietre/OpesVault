"""Chart data with provenance (docs/07 §4): every chart the app draws, built from the ledger.

The model is in `model`; the builders are grouped by subject. Import them from here.
"""

from opesvault.charts.data.cash import (
    annual_chart,
    cash_flow_balance,
    commitments_projection,
    monthly_in_out,
    monthly_result,
    monthly_summary,
    projected_balance,
)
from opesvault.charts.data.investments import (
    investment_evolution,
    investment_result,
    portfolio_composition,
    returns_chart,
)
from opesvault.charts.data.model import (
    Chart,
    Point,
    Series,
    TableRow,
    months_between,
    table_rows,
)
from opesvault.charts.data.spending import (
    budget_history,
    category_comparison_chart,
    category_monthly,
    expenses_by_category,
    merchants_chart,
    tag_chart,
    tags_overview,
)
from opesvault.charts.data.wealth import (
    account_balance_history,
    card_bills_history,
    goal_chart,
    loan_chart,
    net_worth_series,
)

__all__ = [
    "Chart",
    "Point",
    "Series",
    "TableRow",
    "account_balance_history",
    "annual_chart",
    "budget_history",
    "card_bills_history",
    "cash_flow_balance",
    "category_comparison_chart",
    "category_monthly",
    "commitments_projection",
    "expenses_by_category",
    "goal_chart",
    "investment_evolution",
    "investment_result",
    "loan_chart",
    "merchants_chart",
    "monthly_in_out",
    "monthly_result",
    "monthly_summary",
    "months_between",
    "net_worth_series",
    "portfolio_composition",
    "projected_balance",
    "returns_chart",
    "table_rows",
    "tag_chart",
    "tags_overview",
]
