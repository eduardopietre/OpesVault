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
from opesvault.domain.money import ZERO


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


def monthly_result(ledger: Ledger, start: YearMonth, end: YearMonth) -> Chart:
    points = []
    for month in months_between(start, end):
        statement = queries.income_statement(ledger, month)
        points.append(Point(str(month), statement.result, {"regime": "competência"}))
    return Chart(
        "Resultado mensal (receitas − despesas)",
        "BRL",
        [Series("Resultado", points)],
        ["Competência; não é a variação do saldo bancário."],
        "competência",
    )


def cash_flow_balance(ledger: Ledger, start: YearMonth, end: YearMonth) -> Chart:
    flows = queries.cash_flow(ledger, start, end)
    liquid = [a.id for a in ledger.accounts.values() if a.is_liquid]
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
