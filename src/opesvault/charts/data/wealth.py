"""What the project has and owes over time: net worth, account balances, card bills, loans and goals."""

from datetime import date
from decimal import Decimal
from uuid import UUID

from opesvault.charts.data.model import Chart, Point, Series, months_between
from opesvault.domain import queries
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import YearMonth


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
