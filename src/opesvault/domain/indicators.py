"""Family indicators computed from what is already recorded (docs/09 §1.3 E).

Each indicator says how it is computed and is None, with the reason, when the data does
not allow it (no income in the month, no expense history): never a misleading zero.
"""

from dataclasses import dataclass
from decimal import Decimal

from opesvault.domain import queries
from opesvault.domain.comparisons import known_months
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountType, YearMonth
from opesvault.domain.money import ZERO

RATIO = Decimal("0.0001")
RESERVE_WINDOW = 6  # months of expense averaged for the emergency reserve


@dataclass(frozen=True)
class Indicator:
    key: str
    label: str
    value: Decimal | None
    unit: str  # "%" (fraction: 0.25 = 25%), "meses"
    detail: str  # how it was computed, or why it is unavailable


def _ratio(part: Decimal, whole: Decimal) -> Decimal:
    return (part / whole).quantize(RATIO)


def savings_rate(ledger: Ledger, month: YearMonth) -> Indicator:
    statement = queries.income_statement(ledger, month)
    if statement.total_income <= 0:
        return Indicator("savings", "Taxa de poupança do mês", None, "%", "Sem receitas no mês.")
    return Indicator(
        "savings",
        "Taxa de poupança do mês",
        _ratio(statement.result, statement.total_income),
        "%",
        "Resultado por competência dividido pelas receitas do mês.",
    )


def savings_rate_year(ledger: Ledger, month: YearMonth) -> Indicator:
    months = known_months(ledger, [month.add(-i) for i in range(12)])
    income = expense = ZERO
    for m in months:
        statement = queries.income_statement(ledger, m)
        income += statement.total_income
        expense += statement.total_expense
    label = "Taxa de poupança em 12 meses"
    if income <= 0:
        return Indicator("savings_12m", label, None, "%", "Sem receitas registradas no período.")
    detail = f"Últimos {len(months)} mês(es) com registros: resultado dividido pelas receitas."
    return Indicator("savings_12m", label, _ratio(income - expense, income), "%", detail)


def fixed_share(ledger: Ledger, month: YearMonth) -> Indicator:
    """Share of the month's expenses that are commitments: linked to a recurrence or loan installments."""
    from opesvault.domain.loans import loan_operation_ids

    loans = loan_operation_ids(ledger)
    total = fixed = ZERO
    for op in queries.index(ledger).by_competence.get(month, ()):
        committed = op.forecast_id is not None or op.id in loans
        for p in op.postings:
            if ledger.account(p.account_id).type is AccountType.EXPENSE:
                total += p.amount
                if committed:
                    fixed += p.amount
    label = "Despesas fixas"
    if total <= 0:
        return Indicator("fixed", label, None, "%", "Sem despesas no mês.")
    return Indicator(
        "fixed",
        label,
        _ratio(fixed, total),
        "%",
        "Parte das despesas do mês ligada a recorrências e a parcelas de financiamento; o resto é variável.",
    )


def committed_income(ledger: Ledger, month: YearMonth) -> Indicator:
    """Card installments billed in the month plus loan installments due in it, over the month's income."""
    from opesvault.domain.cards import plans, schedule
    from opesvault.domain.loans import plan_schedule
    from opesvault.domain.loans import plans as loan_plans

    installments = ZERO
    for plan in plans(ledger).values():
        installments += sum((i.amount for i in schedule(ledger, plan) if i.cycle.month == month), ZERO)
    for loan in loan_plans(ledger).values():
        installments += sum((i.payment for i in plan_schedule(ledger, loan.id) if YearMonth.of(i.due) == month), ZERO)
    income = queries.income_statement(ledger, month).total_income
    label = "Renda comprometida com parcelas"
    if income <= 0:
        return Indicator("committed", label, None, "%", "Sem receitas no mês.")
    return Indicator(
        "committed",
        label,
        _ratio(installments, income),
        "%",
        "Parcelas de cartão e de financiamento do mês divididas pelas receitas do mês.",
    )


def reserve_months(ledger: Ledger, month: YearMonth) -> Indicator:
    """How many months of the average expense the liquid accounts cover."""
    months = known_months(ledger, [month.add(-i) for i in range(RESERVE_WINDOW)])
    expense = sum((queries.income_statement(ledger, m).total_expense for m in months), ZERO)
    label = "Reserva em meses de despesa"
    if not months or expense <= 0:
        return Indicator("reserve", label, None, "meses", "Sem despesas registradas para comparar.")
    at = month.last_day()
    liquid = sum(
        (
            queries.balance(ledger, a.id, at)
            for a in ledger.accounts.values()
            if a.is_liquid and a.type is AccountType.ASSET and not a.archived
        ),
        ZERO,
    )
    average = expense / len(months)
    return Indicator(
        "reserve",
        label,
        (liquid / average).quantize(Decimal("0.1")),
        "meses",
        f"Saldo das contas líquidas no fim do mês dividido pela despesa média de {len(months)} mês(es).",
    )


def indicators(ledger: Ledger, month: YearMonth) -> list[Indicator]:
    return [
        savings_rate(ledger, month),
        savings_rate_year(ledger, month),
        fixed_share(ledger, month),
        committed_income(ledger, month),
        reserve_months(ledger, month),
    ]
