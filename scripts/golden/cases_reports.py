"""Alerts, agenda, year-end summary, tax issues, chart data and exports over seeded ledgers (docs/18 §4, W5).

domain/{alerts,agenda,annual}.py, tax/{issues,statements}.py, charts/data/*.py and exports.py.

Ledgers: the three planning seeds of cases_planning extended with investments, tax records and
import items, the final state of every cases_tax scenario, and a small ledger of awkward text.
For each one the generator dumps the records and a list of calls ({fn, args, result}); the TS side
loads the records, runs the same calls through its own table and compares the results as JSON
(decimals as text, no tolerance).

Functions that read the clock take `today` as an argument on the TS side; here `date.today()` is
frozen at the call's `today` in the modules that read it, so both sides compute the same day.
Exports are compared by SHA-256 of their exact bytes (full text kept when small).

Run it on its own (`uv run python -m scripts.golden.generate reports`): the order of the entities in
the interchange JSON follows `Ledger.KINDS`, which depends on which modules were imported first, and
the generator checks it against a clean interpreter that loads only `opesvault.registry`.
"""

import hashlib
import json
import random
import subprocess
import sys
from collections.abc import Callable, Iterator
from contextlib import ExitStack, contextmanager
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any
from unittest import mock
from uuid import UUID

import opesvault.registry  # noqa: F401  (loads every kind first, like the app does)
from opesvault import exports
from opesvault.charts import data as charts
from opesvault.domain import (
    agenda,
    alerts,
    annual,
    banking,
    budget,
    goals,
    loans,
    merchants,
    tags,
)
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountType, YearMonth
from opesvault.importing.model import (
    BatchStatus,
    DocFormat,
    ExtractedItem,
    ImportBatch,
    ItemKind,
    ItemStatus,
)
from opesvault.investments import profile as prof
from opesvault.investments import service, trades
from opesvault.investments.model import AssetClass, TrackingMode, ValueNature
from opesvault.tax import issues, records
from opesvault.tax.model import (
    Bracket,
    Bucket,
    BucketRule,
    DeclaredAsset,
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
from scripts.golden import cases_planning, cases_tax
from scripts.golden.cases_investments import known_ids, run_commands
from scripts.golden.common import j, outcome

EXPORTED_AT = datetime(2026, 10, 5, 12, 0, 0, 123456, tzinfo=UTC)
CNPJ = "11.222.333/0001-81"
CPF_ANA = "529.982.247-25"
CPF_BRUNO = "111.444.777-35"
FULL_TEXT_LIMIT = 30_000

FROZEN_MODULES = (
    "opesvault.domain.agenda",
    "opesvault.domain.alerts",
    "opesvault.domain.anomalies",
    "opesvault.domain.goals",
    "opesvault.domain.loans",
    "opesvault.domain.projection",
    "opesvault.domain.recurrence",
    "opesvault.domain.subscriptions",
    "opesvault.tax.issues",
    "opesvault.charts.data.wealth",
)


def _d(text: str) -> date:
    return date.fromisoformat(text)


def _ym(text: str) -> YearMonth:
    return YearMonth.parse(text)


# ── the clock, frozen ──────────


@contextmanager
def frozen(today: date) -> Iterator[None]:
    """`date.today()` answers `today` in the modules that read the clock."""

    class Frozen(date):
        @classmethod
        def today(cls) -> "Frozen":  # type: ignore[override]
            return cls(today.year, today.month, today.day)

    with ExitStack() as stack:
        for name in FROZEN_MODULES:
            stack.enter_context(mock.patch(f"{name}.date", Frozen))
        yield


class _Now(datetime):
    @classmethod
    def now(cls, tz: Any = None) -> datetime:  # type: ignore[override]
        return EXPORTED_AT


def _kind_order_check() -> list[str]:
    """`Ledger.KINDS` of a clean interpreter that only loads the registry; this process must agree."""
    code = (
        "import opesvault.registry; from opesvault.domain.ledger import Ledger; print(json.dumps(list(Ledger.KINDS)))"
    )
    out = subprocess.run(
        [sys.executable, "-c", "import json; " + code], check=True, capture_output=True, text=True
    ).stdout
    clean: list[str] = json.loads(out)
    if list(Ledger.KINDS) != clean:
        raise RuntimeError("Ledger.KINDS order differs from a clean interpreter: run `generate reports` on its own")
    return clean


# ── dumps ──────────


def blob(data: bytes | str) -> dict[str, Any]:
    raw = data if isinstance(data, bytes) else data.encode("utf-8")
    text = raw.decode("utf-8")
    return {
        "sha256": hashlib.sha256(raw).hexdigest(),
        "length": len(raw),
        "text": text if len(raw) <= FULL_TEXT_LIMIT else None,
        "head": text[:300],
    }


def _x(x: Any) -> dict[str, Any]:
    return {"x": j(x), "is_date": isinstance(x, date)}


def dump_chart(chart: charts.Chart) -> dict[str, Any]:
    return {
        "title": chart.title,
        "unit": chart.unit,
        "notes": chart.notes,
        "regime": chart.regime,
        "series": [
            {
                "name": s.name,
                "style": s.style,
                "marker_points": s.marker_points,
                "hidden": s.hidden,
                "summable": s.summable,
                "adds_up": s.adds_up,
                "axis": s.axis,
                "points": [{**_x(p.x), "y": j(p.y), "info": p.info} for p in s.points],
            }
            for s in chart.series
        ],
    }


def dump_chart_and_table(chart: charts.Chart) -> dict[str, Any]:
    headers, rows = charts.table_rows(chart)
    return {
        "chart": dump_chart(chart),
        "headers": headers,
        "rows": [{**_x(r.x), "label": r.label, "values": [j(v) for v in r.values]} for r in rows],
    }


def dump_annual(summary: annual.AnnualSummary) -> dict[str, Any]:
    return {**j(summary), "net_worth": j(summary.net_worth)}


# ── the calls ──────────


def _accounts(ledger: Ledger, ids: list[str] | None) -> list[UUID] | None:
    return None if ids is None else [UUID(i) for i in ids]


def _opt(value: str | None) -> UUID | None:
    return UUID(value) if value else None


RUN: dict[str, Callable[[Ledger, dict[str, Any]], Any]] = {
    # alerts
    "alerts": lambda ledger, a: [j(x) for x in alerts.alerts(ledger, _d(a["today"]), a["horizon"])],
    "card_alerts": lambda ledger, a: [j(x) for x in alerts.card_alerts(ledger, _d(a["today"]), a["horizon"])],
    "recurrence_alerts": lambda ledger, a: [
        j(x) for x in alerts.recurrence_alerts(ledger, _d(a["today"]), a["horizon"])
    ],
    "loan_alerts": lambda ledger, a: [j(x) for x in alerts.loan_alerts(ledger, _d(a["today"]), a["horizon"])],
    "maturity_alerts": lambda ledger, a: [j(x) for x in alerts.maturity_alerts(ledger, _d(a["today"]), a["horizon"])],
    "tax_alerts": lambda ledger, a: [j(x) for x in alerts.tax_alerts(ledger, _d(a["today"]), a["horizon"])],
    "projection_alerts": lambda ledger, a: [j(x) for x in alerts.projection_alerts(ledger, _d(a["today"]))],
    "budget_alerts": lambda ledger, a: [j(x) for x in alerts.budget_alerts(ledger, _d(a["today"]))],
    "suspicion_alerts": lambda ledger, a: [j(x) for x in alerts.suspicion_alerts(ledger, _d(a["today"]))],
    "import_alerts": lambda ledger, a: [j(x) for x in alerts.import_alerts(ledger)],
    "balance_check_alerts": lambda ledger, a: [j(x) for x in alerts.balance_check_alerts(ledger)],
    "price_alerts": lambda ledger, a: [j(x) for x in alerts.price_alerts(ledger)],
    "backup_alert": lambda ledger, a: [
        j(x)
        for x in alerts.backup_alert(
            _d(a["last_backup"]) if a["last_backup"] else None, _d(a["today"]), a["configured"]
        )
    ],
    # agenda
    "agenda_events": lambda ledger, a: [
        j(x) for x in agenda.events(ledger, _d(a["start"]), _d(a["end"]), _d(a["today"]))
    ],
    "month_events": lambda ledger, a: [j(x) for x in agenda.month_events(ledger, _ym(a["month"]), _d(a["today"]))],
    "by_day": lambda ledger, a: {
        str(day): j(found)
        for day, found in agenda.by_day(agenda.month_events(ledger, _ym(a["month"]), _d(a["today"]))).items()
    },
    # annual
    "annual": lambda ledger, a: dump_annual(annual.annual(ledger, a["year"])),
    # tax issues
    "issues": lambda ledger, a: j(issues.issues(ledger, a["year"], _opt(a["declarant"]), _d(a["today"]))),
    "reminders": lambda ledger, a: j(issues.reminders(ledger, _d(a["today"]), a["horizon"])),
    "engaged": lambda ledger, a: issues.engaged(ledger),
    # charts
    "monthly_in_out": lambda ledger, a: dump_chart_and_table(
        charts.monthly_in_out(ledger, _ym(a["start"]), _ym(a["end"]), _accounts(ledger, a["accounts"]))
    ),
    "monthly_result": lambda ledger, a: dump_chart_and_table(
        charts.monthly_result(ledger, _ym(a["start"]), _ym(a["end"]), _opt(a["member"]))
    ),
    "cash_flow_balance": lambda ledger, a: dump_chart_and_table(
        charts.cash_flow_balance(ledger, _ym(a["start"]), _ym(a["end"]), _accounts(ledger, a["accounts"]))
    ),
    "monthly_summary": lambda ledger, a: dump_chart_and_table(
        charts.monthly_summary(ledger, _ym(a["start"]), _ym(a["end"]))
    ),
    "projected_balance": lambda ledger, a: dump_chart_and_table(
        charts.projected_balance(ledger, _d(a["today"]), a["days"])
    ),
    "commitments_projection": lambda ledger, a: dump_chart_and_table(
        charts.commitments_projection(ledger, _ym(a["start"]), a["months"])
    ),
    "annual_chart": lambda ledger, a: dump_chart_and_table(charts.annual_chart(ledger, a["year"])),
    "expenses_by_category": lambda ledger, a: dump_chart_and_table(
        charts.expenses_by_category(ledger, _ym(a["start"]), _ym(a["end"]))
    ),
    "category_monthly": lambda ledger, a: dump_chart_and_table(
        charts.category_monthly(ledger, UUID(a["category"]), _ym(a["start"]), _ym(a["end"]))
    ),
    "category_comparison_chart": lambda ledger, a: dump_chart_and_table(
        charts.category_comparison_chart(ledger, _ym(a["month"]), a["window"])
    ),
    "budget_history": lambda ledger, a: dump_chart_and_table(
        charts.budget_history(ledger, _ym(a["start"]), _ym(a["end"]), _opt(a["category"]))
    ),
    "tag_chart": lambda ledger, a: dump_chart_and_table(charts.tag_chart(ledger, a["tag"])),
    "tags_overview": lambda ledger, a: dump_chart_and_table(charts.tags_overview(ledger)),
    "merchants_chart": lambda ledger, a: dump_chart_and_table(
        charts.merchants_chart(ledger, _d(a["start"]), _d(a["end"]), a["top"])
    ),
    "net_worth_series": lambda ledger, a: dump_chart_and_table(
        charts.net_worth_series(ledger, _ym(a["start"]), _ym(a["end"]))
    ),
    "account_balance_history": lambda ledger, a: dump_chart_and_table(
        charts.account_balance_history(ledger, UUID(a["account"]), _ym(a["start"]), _ym(a["end"]))
    ),
    "card_bills_history": lambda ledger, a: dump_chart_and_table(
        charts.card_bills_history(ledger, UUID(a["card"]), [_ym(m) for m in a["months"]])
    ),
    "loan_chart": lambda ledger, a: dump_chart_and_table(charts.loan_chart(ledger, UUID(a["plan"]))),
    "goal_chart": lambda ledger, a: dump_chart_and_table(
        charts.goal_chart(ledger, UUID(a["goal"]), _ym(a["end"]), a["months"])
    ),
    "investment_evolution": lambda ledger, a: dump_chart_and_table(
        charts.investment_evolution(ledger, UUID(a["position"]))
    ),
    "investment_result": lambda ledger, a: dump_chart_and_table(charts.investment_result(ledger, UUID(a["position"]))),
    "portfolio_composition": lambda ledger, a: dump_chart_and_table(charts.portfolio_composition(ledger, _d(a["at"]))),
    "returns_chart": lambda ledger, a: dump_chart_and_table(
        charts.returns_chart(ledger, UUID(a["position"]), _d(a["start"]), _d(a["end"]))
    ),
    # exports
    "ledger_csv": lambda ledger, a: blob(exports.ledger_csv(ledger)),
    "interchange_json": lambda ledger, a: blob(exports.interchange_json(ledger)),
    "monthly_report_html": lambda ledger, a: blob(
        exports.monthly_report_html(ledger, _ym(a["month"]), _opt(a["member"]))
    ),
    "annual_report_html": lambda ledger, a: blob(exports.annual_report_html(ledger, a["year"])),
    "tax_report_html": lambda ledger, a: blob(exports.tax_report_html(ledger, a["year"], _opt(a["declarant"]))),
}


def call(ledger: Ledger, fn: str, **args: Any) -> dict[str, Any]:
    """Runs one call with the clock frozen at its `today` (when it has one) and records its outcome."""
    today = _d(args["today"]) if args.get("today") else date(2026, 10, 5)
    with frozen(today), mock.patch("opesvault.exports.datetime", _Now):
        return {"fn": fn, "args": args, **outcome(RUN[fn], ledger, args)}


# ── what to call on each ledger ──────────


def _liquid(ledger: Ledger) -> list[str]:
    return [str(a.id) for a in ledger.accounts.values() if a.is_liquid][:2]


def plan_calls(
    ledger: Ledger,
    *,
    window: tuple[str, str],
    todays: list[str],
    years: list[int],
    months: list[str],
    tax_todays: list[str],
) -> list[dict[str, Any]]:
    start, end = window
    out: list[dict[str, Any]] = []

    def add(fn: str, **args: Any) -> None:
        out.append(call(ledger, fn, **args))

    members = [None, *[str(m) for m in ledger.members]]
    # alerts and the agenda
    for today in todays:
        for horizon in (7, 21):
            add("alerts", today=today, horizon=horizon)
            for fn in ("card_alerts", "recurrence_alerts", "loan_alerts", "maturity_alerts", "tax_alerts"):
                add(fn, today=today, horizon=horizon)
        for fn in ("projection_alerts", "budget_alerts", "suspicion_alerts"):
            add(fn, today=today)
        month = today[:7]
        add("month_events", month=month, today=today)
        add("by_day", month=month, today=today)
        add("agenda_events", start=start + "-01", end=end + "-28", today=today)
        add("reminders", today=today, horizon=7)
    for fn in ("import_alerts", "balance_check_alerts", "price_alerts"):
        add(fn)
    add("engaged")
    for last, today, configured in (
        (None, "2026-03-31", False),
        (None, "2026-03-31", True),
        ("2026-03-20", "2026-03-31", True),
        ("2026-01-31", "2026-03-31", True),
        ("2026-03-01", "2026-03-31", False),
    ):
        add("backup_alert", last_backup=last, today=today, configured=configured)
    # year end and the return
    for year in years:
        add("annual", year=year)
        add("annual_chart", year=year)
        for today in tax_todays:
            for member in members:
                add("issues", year=year, declarant=member, today=today)
    # charts
    liquid = _liquid(ledger)
    add("monthly_in_out", start=start, end=end, accounts=None)
    add("monthly_in_out", start=start, end=end, accounts=liquid)
    add("monthly_in_out", start=start, end=end, accounts=[])
    add("monthly_result", start=start, end=end, member=None)
    for member in members[1:3]:
        add("monthly_result", start=start, end=end, member=member)
    add("cash_flow_balance", start=start, end=end, accounts=None)
    add("cash_flow_balance", start=start, end=end, accounts=liquid)
    add("cash_flow_balance", start=start, end=end, accounts=[])
    add("monthly_summary", start=start, end=end)
    for today in todays[:3]:
        add("projected_balance", today=today, days=60)
        add("projected_balance", today=today, days=15)
    add("commitments_projection", start=start, months=12)
    add("commitments_projection", start=end, months=3)
    add("expenses_by_category", start=start, end=end)
    expense_cats = sorted((a for a in ledger.accounts.values() if a.type is AccountType.EXPENSE), key=lambda a: a.name)
    parents = [a for a in expense_cats if any(c.parent_id == a.id for c in expense_cats)]
    for cat in [*expense_cats[:2], *parents[:2]]:
        add("category_monthly", category=str(cat.id), start=start, end=end)
    add("category_monthly", category=str(UUID(int=7)), start=start, end=end)  # unknown: KeyError/DomainError
    for month in months:
        add("category_comparison_chart", month=month, window=3)
    add("category_comparison_chart", month=months[0], window=1)
    add("budget_history", start=start, end=end, category=None)
    for cat in [
        c
        for c in expense_cats
        if budget.lines(ledger) and any(b.category_id == c.id for b in budget.lines(ledger).values())
    ][:2]:
        add("budget_history", start=start, end=end, category=str(cat.id))
    for tag in tags.all_tags(ledger)[:3]:
        add("tag_chart", tag=tag)
    add("tags_overview")
    add("merchants_chart", start=start + "-01", end=end + "-28", top=15)
    add("merchants_chart", start=start + "-01", end=end + "-28", top=2)
    add("net_worth_series", start=start, end=end)
    for account in [a for a in ledger.accounts.values() if a.type is AccountType.ASSET][:4]:
        add("account_balance_history", account=str(account.id), start=start, end=end)
    for card_id in ledger.cards:
        add("card_bills_history", card=str(card_id), months=[start, _next(start), _next(_next(start))])
    for plan_id in loans.plans(ledger):
        for today in todays[:2]:
            add("loan_chart", plan=str(plan_id), today=today)
    for goal in goals.goals(ledger)[:3]:
        for today in todays[:2]:
            add("goal_chart", goal=str(goal.id), end=end, months=12, today=today)
    positions = list(service.positions(ledger))
    for position in positions[:4]:
        add("investment_evolution", position=str(position))
        add("investment_result", position=str(position))
        add("returns_chart", position=str(position), start=start + "-01", end=todays[-1])
        add("returns_chart", position=str(position), start=todays[0], end=todays[0])
    for today in todays[:3]:
        add("portfolio_composition", at=today)
    # exports
    add("ledger_csv")
    add("interchange_json")
    for month in months:
        for member in members[:2]:
            add("monthly_report_html", month=month, member=member, today=month + "-15")
    for year in years:
        add("annual_report_html", year=year)
        for member in members:
            add("tax_report_html", year=year, declarant=member, today=tax_todays[0])
    return out


def _next(month: str) -> str:
    return str(_ym(month).add(1))


# ── the ledgers ──────────


def _safe(label: str, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    try:
        return fn(*args, **kwargs)
    except DomainError as exc:
        print(f"  skipped {label}: {exc}", file=sys.stderr)
        return None


def extend(ledger: Ledger, n: dict[str, Any], seed: int) -> None:
    """Investments, tax records and import items on top of a planning ledger."""
    rng = random.Random(seed * 101)
    ana, bruno, bank = n["ana"], n["bruno"], n["bank"]
    inc = n["inc"]
    # investments
    cdb = service.create_position(
        ledger,
        "CDB Alfa",
        AssetClass.FIXED_INCOME,
        date(2025, 8, 1),
        initial_cost="5000",
        from_account=bank,
        holder_id=ana,
    )
    for on, value in (
        ("2025-09-30", "5040.00"),
        ("2025-12-31", "5110.00"),
        ("2026-03-31", "5190.00"),
        ("2026-06-30", "5260.00"),
    ):
        service.add_valuation(ledger, cdb.id, _d(on), value, ValueNature.GROSS)
    service.add_valuation(ledger, cdb.id, _d("2026-06-30"), "5100.00", ValueNature.NET_ESTIMATED, source="estimado")
    prof.save_profile(
        ledger,
        prof.InvestmentProfile(
            position_id=cdb.id,
            irpf_group="04",
            irpf_code="03",
            issuer="Banco Alfa S.A.",
            issuer_tax_id="11222333000181",
            indexer=prof.Indexer.CDI,
            rate=Decimal("95"),
            applied_on=date(2025, 8, 1),
            maturity=date(2026, 7, 25) if seed != 3 else date(2026, 9, 28),
            liquidity=prof.Liquidity.AT_MATURITY,
            tax=prof.TaxTreatment.EXEMPT,
            income_code="isento:12",
            fgc=True,
        ),
    )
    service.distribute(ledger, cdb.id, "40.00", date(2025, 12, 15), bank, "6.00")
    service.distribute(ledger, cdb.id, "45.00", date(2026, 6, 15), bank, "0")
    lci = service.create_position(
        ledger, "LCI Beta", AssetClass.FIXED_INCOME, date(2025, 3, 1), initial_cost="3000", from_account=n["savings"]
    )
    service.add_valuation(ledger, lci.id, date(2025, 12, 31), "3200.00", ValueNature.GROSS)
    service.redeem(ledger, lci.id, date(2026, 2, 10), "3300.00", bank, cost_attributed="3000.00", tax_withheld="20.00")
    prof.save_profile(ledger, prof.InvestmentProfile(position_id=lci.id, maturity=date(2026, 8, 10)))
    fund = service.create_position(
        ledger, "Fundo Gama", AssetClass.FUND, date(2025, 1, 10), reference_value="2000.00", holder_id=bruno
    )
    _safe("redeem net only", service.redeem_net_only, ledger, fund.id, date(2026, 3, 5), "800.00", bank)
    stock = service.create_position(
        ledger, "PETR4", AssetClass.STOCK, date(2025, 9, 1), mode=TrackingMode.QUANTITY, holder_id=ana, ticker="PETR4"
    )
    trades.buy(ledger, stock.id, date(2025, 9, 2), "1000", "20.00", bank)
    records.set_variable_rules(
        ledger,
        date(2000, 1, 1),
        [
            BucketRule(bucket=Bucket.COMMON, rate=Decimal("0.15"), exempt_sales_limit=Decimal("20000.00")),
            BucketRule(bucket=Bucket.DAY_TRADE, rate=Decimal("0.20")),
        ],
        "teste",
    )
    trades.sell(ledger, stock.id, date(2025, 10, 10), "100", "25.00", bank)
    trades.sell(ledger, stock.id, date(2025, 11, 10), "500", "18.00", bank)
    trades.sell(ledger, stock.id, date(2026, 6, 10), "300", "70.00", bank, fees="3.50")
    trades.buy(ledger, stock.id, date(2026, 6, 20), "100", "10.00", bank)
    trades.sell(ledger, stock.id, date(2026, 6, 20), "100", "12.00", bank)
    records.record_payment(
        ledger, PaymentPurpose.VARIABLE_INCOME, YearMonth(year=2025, month=11), "100.00", date(2025, 12, 20), bank
    )
    # a bank account of its own
    item = banking.build(
        name="Conta Itaú", bank_code="341", bank_name=None, branch="0123", number="45678-X", holder_id=ana
    )
    banking.create(
        ledger,
        item,
        checking=True,
        savings=False,
        opening={banking.Part.CHECKING: (Decimal("250.00"), date(2025, 7, 1))},
    )
    # tax records
    records.classify(ledger, NatureSubject.CATEGORY, inc["Salário"], IncomeNature.TAXABLE_PJ)
    records.set_identity(ledger, TaxSubject.CATEGORY, inc["Salário"], CNPJ, "Empresa Exemplo Ltda")
    records.classify(ledger, NatureSubject.CATEGORY, inc["Outras receitas"], IncomeNature.CARNE_LEAO)
    records.set_identity(ledger, TaxSubject.CATEGORY, inc["Outras receitas"], CPF_ANA, "Pessoa Física")
    salaries = [
        o
        for o in ledger.active_operations()
        if o.description == "SALARIO EMPRESA" and o.occurred_on is not None and o.occurred_on.year == 2025
    ]
    for op in salaries[:3]:
        records.set_income_detail(ledger, op.id, IncomeKind.SALARY, "7500.00", "700.00", "600.00")
    records.set_member_info(ledger, ana, cpf=CPF_ANA, birth_date=date(1985, 1, 1), declared_by=None)
    records.set_member_info(ledger, bruno, cpf=CPF_BRUNO, birth_date=None, declared_by=ana, relation="Filho(a)")
    health = [
        o
        for o in ledger.active_operations()
        if o.occurred_on is not None
        and o.occurred_on.year == 2026
        and any(ledger.account(p.account_id).name in ("Saúde", "Dentista") for p in o.postings)
    ]
    if health:
        records.set_identity(
            ledger, TaxSubject.MERCHANT, merchants.key_of(health[0].description), CNPJ, "Clínica Golden"
        )
    records.record_payment(
        ledger, PaymentPurpose.CARNE_LEAO, YearMonth(year=2025, month=8), "50.00", date(2025, 9, 20), bank, ana
    )
    records.save_report(
        ledger,
        2025,
        ReportSource.ACCOUNT,
        bank,
        [
            ReportLine(field=ReportField.BALANCE_END, amount=Decimal("1234.56")),
            ReportLine(field=ReportField.WITHHELD, amount=Decimal("26.00")),
        ],
        payer_tax_id=CNPJ,
    )
    records.save_report(
        ledger,
        2025,
        ReportSource.CATEGORY,
        inc["Salário"],
        [ReportLine(field=ReportField.TAXABLE, amount=Decimal("90000.00"))],
    )
    records.save_declared_asset(
        ledger,
        DeclaredAsset(
            name="Carro", group="02", code="01", owner_id=ana, acquired_on=date(2025, 3, 1), cost=Decimal("60000.00")
        ),
    )
    records.set_parameters(
        ledger,
        TaxParameters(
            year=2025,
            brackets=(
                Bracket(up_to=Decimal("30000.00"), rate=Decimal("0"), deduction=Decimal("0")),
                Bracket(up_to=None, rate=Decimal("0.10"), deduction=Decimal("3000.00")),
            ),
            simplified_rate=Decimal("0.20"),
            simplified_cap=Decimal("16000.00"),
            education_cap=Decimal("3500.00"),
        ),
    )
    records.set_mark(ledger, 2025, f"informe:conta:{bank}", True, "recebido")
    # import items waiting for review
    batch = ledger.put(
        "import_batch",
        ImportBatch(
            document_id=UUID(int=rng.getrandbits(128)),
            parser_id="nubank-fatura",
            parser_version="1",
            doc_format=DocFormat.PDF,
            status=BatchStatus.IN_REVIEW,
            created_at=datetime(2026, 7, 1, 10, 0, tzinfo=UTC),
        ),
    )
    for k, status in enumerate((ItemStatus.READY, ItemStatus.NEEDS_REVIEW, ItemStatus.APPROVED)):
        ledger.put(
            "extracted_item",
            ExtractedItem(
                batch_id=batch.id,
                kind=ItemKind.PURCHASE,
                occurred_on=date(2026, 6, 20 + k),
                description=f"ITEM {k}",
                amount=Decimal("10.00") + k,
                status=status,
            ),
        )
    ledger.put(
        "import_batch",
        ImportBatch(
            document_id=UUID(int=rng.getrandbits(128)),
            parser_id=None,
            parser_version=None,
            doc_format=DocFormat.PDF,
            status=BatchStatus.AMBIGUOUS if seed != 2 else BatchStatus.UNSUPPORTED,
            created_at=datetime(2026, 7, 2, 10, 0, tzinfo=UTC),
        ),
    )


def special_ledger() -> tuple[Ledger, dict[str, Any]]:
    """Text that CSV, JSON and HTML must escape."""
    ledger = Ledger.new('Projeto "Ç" <&> é')
    ana = ledger.add_member("Ana; <b>Silva</b>").id
    from opesvault.domain.model import AccountSubtype, LedgerAccount

    bank = ledger.add_account(
        LedgerAccount(name='Banco "A"; é', type=AccountType.ASSET, subtype=AccountSubtype.CHECKING, holders=(ana,))
    ).id
    cat = next(a.id for a in ledger.categories(AccountType.EXPENSE))
    salary = next(a.id for a in ledger.categories(AccountType.INCOME))
    ledger.record_opening_balance(bank, "1000.00", date(2026, 1, 1))
    descriptions = [
        "Aspas \"duplas\" e 'simples'",
        "ponto;e;virgula",
        "linha1\nlinha2",
        "retorno\rcarro",
        "tab\tchar",
        "barra \\ invertida",
        "<script>alert(1)</script> & co",
        "emoji 😀 e acentos çãõ",
        "controle \x1f e \x7f",
        "  espaços  ",
        "x" * 120,
        "RTL ‮ fim",
        "separador   de linha",
    ]
    for k, text in enumerate(descriptions):
        _safe(
            f"special {k}",
            ledger.record_expense,
            bank,
            cat,
            Decimal(10 + k) + Decimal("0.5"),
            date(2026, 2, 1 + k),
            text,
            member_id=ana if k % 2 else None,
        )
    ledger.record_income(bank, salary, "3000.00", date(2026, 2, 5), "Salário; <ok>", member_id=ana)
    return ledger, {"ana": ana, "bank": bank}


def tax_scenarios() -> list[tuple[str, Ledger]]:
    """The final ledger of each cases_tax scenario (its commands replayed)."""
    lists: list[tuple[str, list[dict[str, Any]]]] = [
        ("tax: salary", cases_tax._salary() + cases_tax._salary_more()),
        ("tax: carne-leão and identities", cases_tax._carne_leao()),
        ("tax: goods, filings and debts", cases_tax._goods()),
        ("tax: investments and renda variável", cases_tax._investments()),
        ("tax: bank accounts", cases_tax._banking()),
        ("tax: deductible payments", cases_tax._deductibles()),
        ("tax: values at a date", cases_tax._values()),
        ("tax: random 21", cases_tax._random(21)),
    ]
    out = []
    for name, commands in lists:
        ledger, names = cases_tax.base()
        commands = cases_tax._resolve_keys(commands, names)
        run_commands(ledger, commands, names, cases_tax.TAX_COMMANDS, known_ids(ledger))
        out.append((name, Ledger.from_records(ledger.to_records())))
    return out


def records_of(ledger: Ledger) -> list[dict[str, Any]]:
    return [{"id": str(i), "kind": k, "payload": p} for i, k, p in ledger.to_records()]


PLANNING_TODAYS = ["2026-03-15", "2026-07-20", "2026-08-05", "2026-09-25", "2027-03-10"]
TAX_TODAYS = ["2025-05-25", "2025-07-10", "2026-03-15", "2026-04-30", "2026-09-25"]


def generate() -> dict[str, Any]:
    kind_order = _kind_order_check()
    scenarios: list[dict[str, Any]] = []
    for seed in cases_planning.SEEDS:
        built, names = cases_planning.build(seed)
        extend(built, names, seed)
        ledger = Ledger.from_records(built.to_records())
        scenarios.append(
            {
                "name": f"planning seed {seed}",
                "records": records_of(ledger),
                "calls": plan_calls(
                    ledger,
                    window=("2025-06", "2026-07"),
                    todays=PLANNING_TODAYS,
                    years=[2025, 2026],
                    months=["2026-03", "2026-07"],
                    tax_todays=["2026-03-15", "2026-09-25"],
                ),
            }
        )
    for name, ledger in tax_scenarios():
        scenarios.append(
            {
                "name": name,
                "records": records_of(ledger),
                "calls": plan_calls(
                    ledger,
                    window=("2025-01", "2025-12"),
                    todays=TAX_TODAYS,
                    years=[2024, 2025, 2026],
                    months=["2025-05", "2025-09"],
                    tax_todays=["2026-03-01", "2025-04-10"],
                ),
            }
        )
    special, _ = special_ledger()
    special = Ledger.from_records(special.to_records())
    scenarios.append(
        {
            "name": "special characters",
            "records": records_of(special),
            "calls": plan_calls(
                special,
                window=("2026-01", "2026-03"),
                todays=["2026-02-15"],
                years=[2026],
                months=["2026-02"],
                tax_todays=["2026-03-01"],
            ),
        }
    )
    return {
        "exported_at": EXPORTED_AT.isoformat(),
        "kind_order": kind_order,
        "scenarios": scenarios,
    }
