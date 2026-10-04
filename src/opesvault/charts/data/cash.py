"""Money in and out over time: monthly flows, results, cash, the projected balance and commitments."""

from collections import defaultdict
from datetime import date
from decimal import Decimal
from uuid import UUID

from opesvault.charts.data.model import Chart, Point, Series, months_between
from opesvault.domain import queries
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountType, YearMonth
from opesvault.domain.money import ZERO


def monthly_in_out(ledger: Ledger, start: YearMonth, end: YearMonth, accounts: list[UUID] | None = None) -> Chart:
    flows = queries.cash_flow(ledger, start, end, accounts)
    scope = "contas selecionadas" if accounts else "consolidado (transferências internas excluídas)"
    info = {"regime": "caixa", "contas": scope}
    return Chart(
        "Entradas e saídas mensais",
        "BRL",
        [
            Series("Entradas", [Point(str(m), f.inflow, info) for m, f in flows.items()]),
            Series("Saídas", [Point(str(m), f.outflow, info) for m, f in flows.items()]),
        ],
        [f"Regime de caixa · {scope}"],
        "caixa",
    )


def monthly_result(ledger: Ledger, start: YearMonth, end: YearMonth, member_id: UUID | None = None) -> Chart:
    """Competence result per month; with `member_id`, the member's view (`queries.income_statement`)."""
    points = []
    for month in months_between(start, end):
        statement = queries.income_statement(ledger, month, member_id)
        points.append(Point(str(month), statement.result, {"regime": "competência"}))
    member = ledger.members.get(member_id) if member_id else None
    notes = ["Competência; não é a variação do saldo bancário."]
    if member is not None:
        notes.append(f"Visão de {member.name}: lançamentos e rateios atribuídos a este integrante.")
    return Chart(
        "Resultado mensal (receitas − despesas)" + (f" · {member.name}" if member else ""),
        "BRL",
        [Series("Resultado", points)],
        notes,
        "competência",
    )


def cash_flow_balance(ledger: Ledger, start: YearMonth, end: YearMonth, accounts: list[UUID] | None = None) -> Chart:
    flows = queries.cash_flow(ledger, start, end, accounts)
    liquid = accounts if accounts else [a.id for a in ledger.accounts.values() if a.is_liquid]
    balance_points = []
    for month in flows:
        total = sum((queries.balance(ledger, a, month.last_day()) for a in liquid), ZERO)
        balance_points.append(Point(str(month), total, {"regime": "caixa", "saldo": "fim do mês"}))
    return Chart(
        "Fluxo de caixa",
        "BRL",
        [
            Series("Entradas", [Point(str(m), f.inflow) for m, f in flows.items()]),
            Series("Saídas", [Point(str(m), f.outflow) for m, f in flows.items()]),
            Series("Saldo das contas", balance_points, style="line", marker_points=True),
        ],
        ["Transferências internas excluídas do consolidado."],
        "caixa",
    )


def monthly_summary(ledger: Ledger, start: YearMonth, end: YearMonth) -> Chart:
    """The months side by side: cash, competence result and net worth (Visão geral)."""
    months = months_between(start, end)
    flows = queries.cash_flow(ledger, start, end)
    income, expense, result, worth, inflow, outflow = [], [], [], [], [], []
    for month in months:
        statement = queries.income_statement(ledger, month)
        label = str(month)
        competence = {"regime": "competência"}
        income.append(Point(label, statement.total_income, competence))
        expense.append(Point(label, statement.total_expense, competence))
        result.append(Point(label, statement.result, competence))
        inflow.append(Point(label, flows[month].inflow, {"regime": "caixa"}))
        outflow.append(Point(label, flows[month].outflow, {"regime": "caixa"}))
        worth.append(Point(label, queries.net_worth(ledger, month.last_day()).net, {"base": "fim do mês"}))
    return Chart(
        "Mês a mês",
        "BRL",
        [
            Series("Receitas", income),
            Series("Despesas", expense),
            Series("Resultado", result, style="line", marker_points=True, summable=True),
            Series("Entradas (caixa)", inflow, hidden=True),
            Series("Saídas (caixa)", outflow, hidden=True),
            Series("Patrimônio líquido", worth, style="line", hidden=True),
        ],
        ["Receitas, despesas e resultado por competência; entradas e saídas por caixa (na tabela)."],
        "competência",
    )


def projected_balance(ledger: Ledger, today: date, days: int = 60) -> Chart:
    """Each liquid account's balance from today, with the movements already known (a forecast).

    Every account has a value on every day with a movement, so the table reads across: a balance
    that does not change on a day is still known that day. Late items that may still happen are
    counted today.
    """
    from opesvault.domain.projection import events, project

    end = date.fromordinal(today.toordinal() + days)
    projections = [p for p in project(ledger, today, days) if p.events or p.start_balance != 0]
    by_day: dict[date, list[str]] = defaultdict(list)
    for projection in projections:
        for event in projection.events:
            late = ", atrasado" if event.late else ""
            by_day[event.on].append(f"{event.description} ({event.source}{late})")
    days_shown = sorted({today, end, *by_day})
    series = []
    for projection in projections:
        account = ledger.account(projection.account_id)
        own = {e.on for e in projection.events}
        points = []
        for day in days_shown:
            info = {"natureza": "saldo de hoje" if day == today else "previsão"}
            if day in own:
                info["movimentos"] = "; ".join(
                    f"{e.description} ({e.source})" for e in projection.events if e.on == day
                )
            points.append(Point(day, projection.balance_on(day), info))
        series.append(Series(account.name, points, style="step", marker_points=True))
    _found, notes = events(ledger, today, end)
    return Chart(
        "Saldo projetado",
        "BRL",
        series,
        [
            "Previsão com recorrências, faturas e parcelas já registradas; atrasados contam hoje. Não altera saldos.",
            *notes,
        ],
    )


def commitments_projection(ledger: Ledger, start: YearMonth, months: int = 12) -> Chart:
    from opesvault.domain.cards import plans, schedule
    from opesvault.domain.recurrence import ForecastStatus, forecasts

    end = start.add(months - 1)
    installments: dict[YearMonth, Decimal] = defaultdict(lambda: ZERO)
    for plan in plans(ledger).values():
        for item in schedule(ledger, plan):
            if start <= item.cycle.month <= end:
                installments[item.cycle.month] += item.amount
    recurring_out: dict[YearMonth, Decimal] = defaultdict(lambda: ZERO)
    recurring_in: dict[YearMonth, Decimal] = defaultdict(lambda: ZERO)
    for f in forecasts(ledger, start.first_day(), end.last_day()):
        if f.status not in (ForecastStatus.PENDING, ForecastStatus.LATE):
            continue
        target = recurring_in if f.amount > 0 else recurring_out
        target[YearMonth.of(f.due_on)] += abs(f.amount)
    labels = months_between(start, end)
    info = {"natureza": "previsão"}
    return Chart(
        "Projeção de compromissos",
        "BRL",
        [
            Series("Parcelas de cartão", [Point(str(m), installments[m], info) for m in labels], style="forecast"),
            Series("Saídas recorrentes", [Point(str(m), recurring_out[m], info) for m in labels], style="forecast"),
            Series("Entradas recorrentes", [Point(str(m), recurring_in[m], info) for m in labels], style="forecast"),
        ],
        ["Previsões: não alteram o realizado."],
    )


def annual_chart(ledger: Ledger, year: int) -> Chart:
    """Balances on 31/12 per account, with the previous year's in the table (fechamento do ano)."""
    from opesvault.domain.annual import NOTICE, annual

    summary = annual(ledger, year)
    end, before = [], []
    for line in summary.balances:
        kind = "bem" if line.kind is AccountType.ASSET else "dívida"
        end.append(Point(line.name, line.year_end, {"tipo": kind}))
        before.append(Point(line.name, line.previous_year_end, {"tipo": kind}))
    return Chart(
        f"Bens e dívidas em 31/12/{year}",
        "BRL",
        [Series(f"31/12/{year}", end), Series(f"31/12/{year - 1}", before, hidden=True)],
        [NOTICE],
    )
