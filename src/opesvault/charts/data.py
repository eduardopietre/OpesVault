"""Chart datasets (docs/07 §4-5). Pure data with provenance; rendering lives elsewhere.

Missing data stays None (never zero); currencies and percentages never share an axis.
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from uuid import UUID

from opesvault.domain import queries
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountType, OperationKind, YearMonth
from opesvault.domain.money import ZERO, round_money


@dataclass(frozen=True)
class Point:
    x: date | str
    y: Decimal | None
    info: dict[str, str] = field(default_factory=dict)  # tooltip: origin, nature, method, quality…


@dataclass
class Series:
    name: str
    points: list[Point]
    style: str = "bar"  # bar, line, scatter, step, forecast
    marker_points: bool = False
    hidden: bool = False  # only in the table of values, not drawn (keeps the chart readable)
    # Whether a total over the rows means something: flows (bars) add up, positions (lines) do not.
    summable: bool | None = None
    # "right": drawn against a second scale (a loan's installment beside its balance), so a small
    # series is not flattened by a large one
    axis: str = "left"

    @property
    def adds_up(self) -> bool:
        return self.summable if self.summable is not None else self.style in ("bar", "forecast")


@dataclass
class Chart:
    title: str
    unit: str  # "BRL" or "%"
    series: list[Series]
    notes: list[str] = field(default_factory=list)
    regime: str | None = None


def months_between(start: YearMonth, end: YearMonth) -> list[YearMonth]:
    out, cursor = [], start
    while cursor <= end:
        out.append(cursor)
        cursor = cursor.add(1)
    return out


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


def expenses_by_category(ledger: Ledger, start: YearMonth, end: YearMonth) -> Chart:
    totals = queries.expenses_by_category(ledger, start, end)
    refunds: dict[UUID, Decimal] = defaultdict(lambda: ZERO)
    for op in ledger.active_operations():
        if op.kind is OperationKind.REFUND and op.competence and start <= op.competence <= end:
            for p in op.postings:
                if ledger.account(p.account_id).type is AccountType.EXPENSE:
                    refunds[p.account_id] += -p.amount
    ordered = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)
    points = [
        Point(
            ledger.account(cid).name,
            value,
            {"estornos no período": str(refunds[cid])} if refunds.get(cid) else {},
        )
        for cid, value in ordered
    ]
    return Chart(
        "Despesas por categoria",
        "BRL",
        [Series("Despesas", points)],
        ["Valores já líquidos de estornos."],
        "competência",
    )


def category_monthly(ledger: Ledger, category_id: UUID, start: YearMonth, end: YearMonth) -> Chart:
    """One expense category (with its sub-categories) month by month, by competence."""
    family = {category_id}
    grew = True
    while grew:  # sub-categories at any depth
        children = {a.id for a in ledger.accounts.values() if a.parent_id in family} - family
        family |= children
        grew = bool(children)
    points = []
    for month in months_between(start, end):
        totals = queries.expenses_by_category(ledger, month, month)
        value = sum((v for cid, v in totals.items() if cid in family), ZERO)
        points.append(Point(str(month), value, {"regime": "competência"}))
    name = ledger.account(category_id).name
    return Chart(
        f"Despesas: {name}",
        "BRL",
        [Series(name, points)],
        ["Competência; inclui as subcategorias. Valores já líquidos de estornos."],
        "competência",
    )


def net_worth_series(ledger: Ledger, start: YearMonth, end: YearMonth) -> Chart:
    from opesvault.investments.performance import composition

    assets, liabilities, net = [], [], []
    notes = []
    for month in months_between(start, end):
        worth = queries.net_worth(ledger, month.last_day())
        info = {"base": "custo contábil"}
        portfolio = composition(ledger, month.last_day())
        if portfolio.partial:
            info["carteira"] = "parcial (ativos sem avaliação)"
        assets.append(Point(str(month), worth.assets, info))
        liabilities.append(Point(str(month), worth.liabilities, info))
        net.append(Point(str(month), worth.net, info))
    notes.append("Investimentos pelo custo contábil; o valor observado aparece nos gráficos de investimento.")
    return Chart(
        "Patrimônio",
        "BRL",
        [
            Series("Ativos", assets, style="line", marker_points=True),
            Series("Passivos", liabilities, style="line", marker_points=True),
            Series("Patrimônio líquido", net, style="line", marker_points=True),
        ],
        notes,
    )


def investment_evolution(ledger: Ledger, position_id: UUID) -> Chart:
    from opesvault.investments.model import NATURE_LABELS, EventKind, ValueNature
    from opesvault.investments.performance import selected_series
    from opesvault.investments.service import events_of

    series = []
    for nature in ValueNature:
        points = [
            Point(v.on, v.value, {"natureza": NATURE_LABELS[v.nature], "fonte": v.source, "origem": "observado"})
            for v in selected_series(ledger, position_id, nature)
        ]
        if points:
            series.append(Series(f"Valor {NATURE_LABELS[nature].lower()}", points, style="line", marker_points=True))
    labels = {EventKind.CONTRIBUTION: "Aporte", EventKind.WITHDRAWAL: "Resgate", EventKind.DISTRIBUTION: "Provento"}
    for kind, label in labels.items():
        markers = [
            Point(e.on, e.gross if e.gross is not None else e.net, {"evento": label, "qualidade": e.quality.value})
            for e in events_of(ledger, position_id)
            if e.kind is kind
        ]
        if markers:
            series.append(Series(label, markers, style="scatter"))
    return Chart(
        "Evolução do investimento",
        "BRL",
        series,
        ["Linhas ligam observações; não são preços diários. Bruto e líquido em séries separadas."],
    )


def investment_result(ledger: Ledger, position_id: UUID) -> Chart:
    """Cumulative monetary result at each observed date: capital contributed never counts as gain."""
    from opesvault.investments.model import ValueNature
    from opesvault.investments.performance import period_result, selected_series

    points = []
    gross = selected_series(ledger, position_id, ValueNature.GROSS)
    if gross:
        first = gross[0]
        for v in gross:
            result = period_result(ledger, position_id, first.on, v.on)
            points.append(Point(v.on, result.value, {"método": result.method, "qualidade": result.quality.value}))
    return Chart(
        "Resultado acumulado do investimento", "BRL", [Series("Resultado", points, style="line", marker_points=True)]
    )


def portfolio_composition(ledger: Ledger, at: date) -> Chart:
    from opesvault.investments.model import ASSET_CLASS_LABELS
    from opesvault.investments.performance import composition
    from opesvault.investments.service import assets, position

    portfolio = composition(ledger, at)
    points = []
    for line in portfolio.lines:
        pos = position(ledger, line.position_id)
        asset = assets(ledger)[pos.asset_id]
        info = {"classe": ASSET_CLASS_LABELS[asset.asset_class]}
        if line.as_of:
            info["data-base"] = f"{line.as_of:%d/%m/%Y} ({line.age_days} dias)"
        else:
            info["situação"] = "sem avaliação"
        points.append(Point(asset.name, line.value, info))
    notes = [f"Data-base {at:%d/%m/%Y}; último valor conhecido até a data."]
    if portfolio.partial:
        notes.append("Total parcial: há ativos sem avaliação.")
    return Chart("Composição da carteira", "BRL", [Series("Valor", points)], notes)


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


def returns_chart(ledger: Ledger, position_id: UUID, start: date, end: date) -> Chart:
    """Percentages by method; unavailable methods appear in notes with their reason, never as zero."""
    from opesvault.investments.returns import all_methods

    points, notes = [], []
    for result in all_methods(ledger, position_id, start, end):
        label = result.method.split(" (")[0]
        if result.value is None:
            notes.append(f"{label}: indisponível — {result.notes[0] if result.notes else ''}")
        points.append(
            Point(
                label,
                result.value,
                {
                    "método": result.method,
                    "qualidade": result.quality.value,
                    **({"notas": "; ".join(result.notes)} if result.notes else {}),
                },
            )
        )
    return Chart(f"Rentabilidade {start:%d/%m/%Y} a {end:%d/%m/%Y}", "%", [Series("Retorno", points)], notes)


# ── the table of values behind a chart ─────────────────────


@dataclass(frozen=True)
class TableRow:
    x: date | str | None  # None for the summary rows
    label: str
    values: list[Decimal | None]


def table_rows(chart: Chart) -> tuple[list[str], list[TableRow]]:
    """The chart's numbers as rows (one per x) and columns (one per series, hidden ones included).

    Monthly charts get "Total" and "Média" rows for the series that add up (flows); positions
    such as balances never get a total. Unknown values stay None.
    """
    xs: list[date | str] = []
    for series in chart.series:
        for point in series.points:
            if point.x not in xs:
                xs.append(point.x)
    if all(isinstance(x, date) for x in xs):
        xs.sort()  # type: ignore[call-overload]
    lookup = [{p.x: p.y for p in s.points} for s in chart.series]
    rows = [TableRow(x, str(x), [values.get(x) for values in lookup]) for x in xs]
    monthly = bool(xs) and all(isinstance(x, str) and _is_month(x) for x in xs)
    summable = [s.adds_up for s in chart.series]
    if monthly and len(rows) > 1 and any(summable) and chart.unit == "BRL":
        totals: list[Decimal | None] = []
        averages: list[Decimal | None] = []
        for column, adds in enumerate(summable):
            known = [r.values[column] for r in rows if r.values[column] is not None]
            if not adds or not known:
                totals.append(None)
                averages.append(None)
                continue
            total = sum((v for v in known if v is not None), ZERO)
            totals.append(total)
            averages.append(round_money(total / len(known)))
        rows.append(TableRow(None, "Total", totals))
        rows.append(TableRow(None, "Média", averages))
    return [s.name for s in chart.series], rows


def _is_month(text: str) -> bool:
    try:
        YearMonth.parse(text)
    except (ValueError, TypeError):
        return False
    return True


# ── charts added with the review of 03/10/2026 ─────────────


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


def category_comparison_chart(ledger: Ledger, month: YearMonth, window: int = 3) -> Chart:
    from opesvault.domain.comparisons import category_comparison

    rows = category_comparison(ledger, month, window)
    label_now = f"{_month_name(month)}"
    current, average, last_year = [], [], []
    for row in rows:
        info = {}
        if row.change is not None:
            info["variação"] = f"{row.change * 100:+.0f}% sobre a média".replace(".", ",")
        current.append(Point(row.name, row.current, info))
        average.append(Point(row.name, row.average, {"meses na média": str(row.months_averaged)}))
        last_year.append(Point(row.name, row.last_year))
    notes = [f"Competência. Média dos {window} meses anteriores com registros; meses sem registros não entram."]
    if rows and rows[0].months_averaged < window:
        notes.append(f"Só {rows[0].months_averaged} mês(es) anterior(es) com registros.")
    return Chart(
        "Comparação com a média",
        "BRL",
        [
            Series(label_now, current),
            Series(f"Média de {window} meses", average),
            Series("Mesmo mês do ano anterior", last_year),
        ],
        notes,
        "competência",
    )


def _month_name(month: YearMonth) -> str:
    names = ("jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez")
    return f"{names[month.month - 1]}/{month.year}"


def budget_history(ledger: Ledger, start: YearMonth, end: YearMonth, category_id: UUID | None = None) -> Chart:
    """Planned against actual month by month, for the whole budget or one category."""
    from opesvault.domain.budget import status

    planned, actual = [], []
    for month in months_between(start, end):
        current = status(ledger, month)
        if category_id is None:
            plan: Decimal | None = current.total_planned if current.rows else None
            spent: Decimal | None = current.total_actual if current.rows else None
        else:
            row = next((r for r in current.rows if r.category_id == category_id), None)
            plan = row.planned if row else None
            spent = row.actual if row else None
        planned.append(Point(str(month), plan, {"situação": "sem orçamento"} if plan is None else {}))
        actual.append(Point(str(month), spent, {"regime": "competência"}))
    name = ledger.account(category_id).name if category_id else "Categorias com orçamento"
    return Chart(
        f"Orçamento mês a mês: {name}",
        "BRL",
        [Series("Planejado", planned), Series("Realizado", actual)],
        ["Meses sem orçamento ficam vazios, não zerados."],
        "competência",
    )


def account_balance_history(ledger: Ledger, account_id: UUID, start: YearMonth, end: YearMonth) -> Chart:
    """End-of-month balance of one account, with the bank checks informed by the user."""
    from opesvault.domain.balance_checks import results

    account = ledger.account(account_id)
    balances = [
        Point(str(m), queries.balance(ledger, account_id, m.last_day()), {"saldo": "fim do mês"})
        for m in months_between(start, end)
    ]
    series = [Series("Saldo no fim do mês", balances, style="line", marker_points=True)]
    checks = [r for r in results(ledger, account_id) if start.first_day() <= r.check.on <= end.last_day()]
    if checks:
        by_month: dict[str, Decimal] = {}
        for r in sorted(checks, key=lambda r: r.check.on):
            by_month[str(YearMonth.of(r.check.on))] = r.check.informed
        series.append(
            Series(
                "Saldo informado pelo banco",
                [Point(str(m), by_month.get(str(m))) for m in months_between(start, end)],
                style="scatter",
            )
        )
    return Chart(f"Saldo: {account.name}", "BRL", series, ["Saldo por data de caixa."], "caixa")


def card_bills_history(ledger: Ledger, card_id: UUID, months: list[YearMonth]) -> Chart:
    from opesvault.domain.cards import bills

    card = ledger.cards[card_id]
    found = bills(ledger, card_id, months)
    total = [Point(str(b.cycle.month), b.total, {"vencimento": f"{b.cycle.due:%d/%m/%Y}"}) for b in found]
    paid = [Point(str(b.cycle.month), b.payments) for b in found]
    installments = [Point(str(b.cycle.month), b.installments) for b in found]
    return Chart(
        f"Faturas: {card.name}",
        "BRL",
        [Series("Total da fatura", total), Series("Pago", paid), Series("Parcelas", installments, hidden=True)],
        ["Mês de vencimento."],
    )


def loan_chart(ledger: Ledger, plan_id: UUID) -> Chart:
    """Outstanding balance and the interest × amortization split of each installment."""
    from opesvault.domain.loans import STATE_LABELS, plan_schedule, plans, state_of

    plan = plans(ledger)[plan_id]
    today = date.today()
    balance, interest, amortization, payment = [], [], [], []
    for item in plan_schedule(ledger, plan_id):
        info = {"parcela": str(item.number), "situação": STATE_LABELS[state_of(ledger, plan_id, item, today)]}
        if item.prepaid_after:
            info["amortização antecipada"] = format(item.prepaid_after, "f")
        balance.append(Point(item.due, item.balance_after, info))
        interest.append(Point(item.due, item.interest, info))
        amortization.append(Point(item.due, item.amortization, info))
        payment.append(Point(item.due, item.payment, info))
    return Chart(
        f"Financiamento: {plan.name}",
        "BRL",
        [
            Series("Saldo devedor", balance, style="line"),
            Series("Juros", interest, style="line", summable=True, axis="right"),
            Series("Amortização", amortization, style="line", summable=True, axis="right"),
            Series("Parcela", payment, hidden=True, summable=True),
        ],
        [
            "Saldo devedor na escala da esquerda; juros e amortização de cada parcela na da direita.",
            "Calculado pelo contrato informado; o saldo da conta no livro é a referência.",
        ],
    )


def tag_chart(ledger: Ledger, tag: str) -> Chart:
    from opesvault.domain.tags import summary

    found = summary(ledger, tag)
    ordered = sorted(found.by_category.items(), key=lambda kv: kv[1], reverse=True)
    points = [Point(ledger.account(cid).name, value) for cid, value in ordered if value]
    span = ""
    if found.first and found.last:
        span = f"De {found.first:%d/%m/%Y} a {found.last:%d/%m/%Y}. "
    return Chart(
        f"Marcador: {tag}",
        "BRL",
        [Series("Despesas", points)],
        [span + "Despesas líquidas de estornos, em qualquer mês."],
    )


def tags_overview(ledger: Ledger) -> Chart:
    from opesvault.domain.tags import summaries

    rows = summaries(ledger)
    return Chart(
        "Marcadores",
        "BRL",
        [
            Series("Despesas", [Point(s.tag, s.expense, {"lançamentos": str(len(s.operations))}) for s in rows]),
            Series("Receitas", [Point(s.tag, s.income) for s in rows], hidden=True),
        ],
        ["Cada marcador soma seus lançamentos em qualquer mês, com várias categorias."],
    )


def merchants_chart(ledger: Ledger, start: date, end: date, top: int = 15) -> Chart:
    """Expense per merchant (approved names, or the cleaned description), largest first."""
    from opesvault.domain.merchants import totals

    found = totals(ledger, start, end)
    shown = found[:top]
    rest = sum((m.expense for m in found[top:]), ZERO)
    points = [
        Point(m.name, m.expense, {"lançamentos": str(m.count), "nome": "aprovado" if m.approved else "da descrição"})
        for m in shown
    ]
    if rest:
        points.append(Point("Outros", rest, {"estabelecimentos": str(len(found) - top)}))
    return Chart(
        "Despesas por estabelecimento",
        "BRL",
        [Series("Despesas", points)],
        ["Nomes aprovados no Livro (Ações › Nomear estabelecimento); os demais vêm da descrição, limpa."],
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


def goal_chart(ledger: Ledger, goal_id: UUID, end: YearMonth, months: int = 12) -> Chart:
    """The goal's value at the end of each month, against the target."""
    from opesvault.domain.goals import KIND_LABELS, value_of

    goal = ledger.entities("goal")[goal_id]
    value, target = [], []
    for month in months_between(end.add(-(months - 1)), end):
        at = min(month.last_day(), date.today())
        value.append(Point(str(month), value_of(ledger, goal, at), {"base": KIND_LABELS[goal.kind].lower()}))
        target.append(Point(str(month), goal.target))
    notes = ["Valor no fim de cada mês (o mês atual, até hoje)."]
    if goal.target_date:
        notes.append(f"Prazo: {goal.target_date:%d/%m/%Y}.")
    return Chart(
        f"Meta: {goal.name}",
        "BRL",
        [
            Series("Valor", value, style="line", marker_points=True),
            Series("Meta", target, style="line", summable=False),
        ],
        notes,
    )
