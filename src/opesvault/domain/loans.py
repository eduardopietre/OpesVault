"""Loans and financing: SAC or Price schedules, installments and early repayment (docs/09 §1.3 E).

The plan is the contract as the family knows it (balance, monthly rate, term, first due
date); the schedule is computed from it, never stored. Paying an installment records a
real operation that splits the amount into amortization (reduces the debt), interest and
fees (expenses). An early repayment amortizes the debt and either shortens the term or
lowers the following installments, as the contract allows.

Bank schedules may differ by cents (rounding, insurance indexed to the balance): the
liability account's balance in the ledger stays the authority, and the screen shows both.
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from pydantic import Field

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import (
    AccountSubtype,
    AccountType,
    Amount,
    Operation,
    OperationKind,
    Posting,
    YearMonth,
    _Entity,
)
from opesvault.domain.money import ZERO, is_cents, round_money, to_decimal

RATE_PLACES = Decimal("0.0000000001")
MAX_TERM = 600


class AmortizationSystem(StrEnum):
    PRICE = "price"  # equal installments; amortization grows
    SAC = "sac"  # equal amortization; installments fall


SYSTEM_LABELS = {
    AmortizationSystem.PRICE: "Price (parcelas iguais)",
    AmortizationSystem.SAC: "SAC (amortização constante)",
}


class PrepaymentMode(StrEnum):
    REDUCE_TERM = "reduce_term"
    REDUCE_PAYMENT = "reduce_payment"


MODE_LABELS = {PrepaymentMode.REDUCE_TERM: "Reduzir o prazo", PrepaymentMode.REDUCE_PAYMENT: "Reduzir a parcela"}


class LoanPlan(_Entity):
    name: str = Field(min_length=1, max_length=120)
    liability_account_id: UUID  # subtype LOAN: the debt
    payment_account_id: UUID  # where installments are paid from
    interest_category_id: UUID  # expense category for interest
    fees_category_id: UUID | None = None  # insurance and fees charged with each installment
    principal: Amount  # balance when the schedule starts
    monthly_rate: Decimal = Field(ge=0, le=1)  # 0.0099 = 0,99% a.m.
    term: int = Field(ge=1, le=MAX_TERM)
    system: AmortizationSystem
    first_due: date
    fees_per_installment: Amount = Decimal("0")
    version: int = 1


class LoanPayment(_Entity):
    plan_id: UUID
    number: int = Field(ge=1)
    operation_id: UUID
    paid_on: date


class LoanPrepayment(_Entity):
    plan_id: UUID
    after_number: int = Field(ge=0)  # applied after this installment (0: before the first)
    amount: Amount
    mode: PrepaymentMode
    paid_on: date
    operation_id: UUID | None = None


Ledger.register_kind("loan_plan", LoanPlan)
Ledger.register_kind("loan_payment", LoanPayment)
Ledger.register_kind("loan_prepayment", LoanPrepayment)


def plans(ledger: Ledger) -> dict[UUID, LoanPlan]:
    return ledger.entities("loan_plan")


def payments(ledger: Ledger) -> dict[UUID, LoanPayment]:
    return ledger.entities("loan_payment")


def prepayments(ledger: Ledger) -> dict[UUID, LoanPrepayment]:
    return ledger.entities("loan_prepayment")


def annual_to_monthly(annual: object) -> Decimal:
    """Effective annual rate to the equivalent monthly rate: (1 + a)^(1/12) − 1."""
    value = to_decimal(annual)
    if value < 0:
        raise DomainError("Taxa negativa não é aceita.")
    return ((1 + value) ** (Decimal(1) / Decimal(12)) - 1).quantize(RATE_PLACES)


def due_date(first_due: date, number: int) -> date:
    import calendar

    month = YearMonth.of(first_due).add(number - 1)
    last = calendar.monthrange(month.year, month.month)[1]
    return date(month.year, month.month, min(first_due.day, last))


def _price_payment(balance: Decimal, rate: Decimal, count: int) -> Decimal:
    if count <= 0:
        return balance
    if rate == 0:
        return round_money(balance / count)
    factor = (1 + rate) ** count
    return round_money(balance * rate * factor / (factor - 1))


@dataclass(frozen=True)
class Installment:
    number: int
    due: date
    payment: Decimal  # amortization + interest + fees
    amortization: Decimal
    interest: Decimal
    fees: Decimal
    balance_after: Decimal  # debt after this installment (and after a prepayment applied right after it)
    prepaid_after: Decimal = ZERO


def schedule(plan: LoanPlan, extra: list[tuple[int, Decimal, PrepaymentMode]] | None = None) -> list[Installment]:
    """The installments of `plan`, with prepayments (after installment n, amount, mode) applied.

    Interest is charged on the outstanding balance at the monthly rate and rounded to cents
    (ties away from zero); the last installment takes the residual so the debt ends at zero.
    """
    pending = sorted(extra or [], key=lambda e: e[0])
    rate = plan.monthly_rate
    balance = plan.principal
    remaining = plan.term
    for _after, amount, _mode in [e for e in pending if e[0] == 0]:
        balance = max(balance - amount, ZERO)
    pending = [e for e in pending if e[0] > 0]
    payment = _price_payment(balance, rate, remaining)
    amortization = round_money(balance / remaining) if remaining else balance
    out: list[Installment] = []
    number = 0
    while balance > 0 and number < MAX_TERM * 2:
        number += 1
        interest = round_money(balance * rate)
        if plan.system is AmortizationSystem.PRICE:
            amort = payment - interest
            if amort <= 0:
                raise DomainError("A parcela não cobre os juros: revise taxa, prazo e saldo.")
        else:
            amort = amortization
        last = amort >= balance or remaining <= 1
        if last:
            amort = balance
        balance -= amort
        remaining -= 1
        prepaid = ZERO
        for _after, amount, mode in [e for e in pending if e[0] == number]:
            cut = min(amount, balance)
            balance -= cut
            prepaid += cut
            if balance > 0 and mode is PrepaymentMode.REDUCE_PAYMENT:
                payment = _price_payment(balance, rate, remaining)
                amortization = round_money(balance / remaining) if remaining else balance
        out.append(
            Installment(
                number,
                due_date(plan.first_due, number),
                amort + interest + plan.fees_per_installment,
                amort,
                interest,
                plan.fees_per_installment,
                balance,
                prepaid,
            )
        )
        if balance > 0 and remaining <= 0:
            remaining = 1  # reduce-term path never runs out; reduce-payment ends with the term
    return out


def _extra(ledger: Ledger, plan_id: UUID) -> list[tuple[int, Decimal, PrepaymentMode]]:
    return [(p.after_number, p.amount, p.mode) for p in prepayments(ledger).values() if p.plan_id == plan_id]


def plan_schedule(ledger: Ledger, plan_id: UUID) -> list[Installment]:
    return schedule(plans(ledger)[plan_id], _extra(ledger, plan_id))


class InstallmentState(StrEnum):
    PAID = "paid"
    OVERDUE = "overdue"
    PENDING = "pending"


STATE_LABELS = {
    InstallmentState.PAID: "Paga",
    InstallmentState.OVERDUE: "Vencida",
    InstallmentState.PENDING: "A vencer",
}


def paid_numbers(ledger: Ledger, plan_id: UUID) -> dict[int, LoanPayment]:
    out = {}
    for payment in payments(ledger).values():
        op = ledger.operations.get(payment.operation_id)
        if payment.plan_id == plan_id and op is not None and op.active:
            out[payment.number] = payment
    return out


def state_of(ledger: Ledger, plan_id: UUID, item: Installment, today: date) -> InstallmentState:
    if item.number in paid_numbers(ledger, plan_id):
        return InstallmentState.PAID
    return InstallmentState.OVERDUE if item.due < today else InstallmentState.PENDING


@dataclass(frozen=True)
class LoanStatus:
    plan: LoanPlan
    installments: list[Installment]
    paid: int
    overdue: int
    next_due: Installment | None
    outstanding: Decimal  # by the schedule, after the paid installments and prepayments
    ledger_balance: Decimal  # the liability account's balance in the ledger
    interest_to_come: Decimal
    end: date | None


def status(ledger: Ledger, plan_id: UUID, today: date | None = None) -> LoanStatus:
    from opesvault.domain import queries

    today = today or date.today()
    plan = plans(ledger)[plan_id]
    items = plan_schedule(ledger, plan_id)
    paid = paid_numbers(ledger, plan_id)
    unpaid = [i for i in items if i.number not in paid]
    outstanding = plan.principal - sum((i.amortization + i.prepaid_after for i in items if i.number in paid), ZERO)
    # A prepayment made before any installment is applied to the starting balance.
    upfront = (p.amount for p in prepayments(ledger).values() if p.plan_id == plan_id and p.after_number == 0)
    outstanding -= sum(upfront, ZERO)
    return LoanStatus(
        plan=plan,
        installments=items,
        paid=len(paid),
        overdue=sum(1 for i in unpaid if i.due < today),
        next_due=unpaid[0] if unpaid else None,
        outstanding=max(outstanding, ZERO),
        ledger_balance=queries.balance(ledger, plan.liability_account_id),
        interest_to_come=sum((i.interest for i in unpaid), ZERO),
        end=items[-1].due if items else None,
    )


def _check_accounts(ledger: Ledger, plan: LoanPlan) -> None:
    liability = ledger.accounts.get(plan.liability_account_id)
    if liability is None or liability.subtype is not AccountSubtype.LOAN:
        raise DomainError("Escolha uma conta de empréstimo ou financiamento.")
    paying = ledger.accounts.get(plan.payment_account_id)
    if paying is None or paying.type is not AccountType.ASSET:
        raise DomainError("Escolha a conta de onde saem as parcelas.")
    for category_id in (plan.interest_category_id, plan.fees_category_id):
        if category_id is None:
            continue
        category = ledger.accounts.get(category_id)
        if category is None or category.type is not AccountType.EXPENSE:
            raise DomainError("Juros e encargos são categorias de despesa.")
    if plan.principal <= 0 or not is_cents(plan.principal):
        raise DomainError("Informe o saldo devedor em reais e centavos.")
    if plan.fees_per_installment < 0 or not is_cents(plan.fees_per_installment):
        raise DomainError("Encargos por parcela inválidos.")
    if plan.fees_per_installment > 0 and plan.fees_category_id is None:
        raise DomainError("Escolha a categoria dos encargos.")


class Opening(StrEnum):
    NONE = "none"  # the debt is already in the ledger
    OPENING_BALANCE = "opening_balance"  # an existing debt enters as opening balance
    DEPOSIT = "deposit"  # the money was credited to an account on the start date


def create_loan(
    ledger: Ledger,
    plan: LoanPlan,
    opening: Opening = Opening.NONE,
    *,
    on: date | None = None,
    deposit_account_id: UUID | None = None,
) -> LoanPlan:
    _check_accounts(ledger, plan)
    schedule(plan)  # rejects contracts whose installment does not cover the interest
    when = on or plan.first_due
    if opening is Opening.OPENING_BALANCE:
        ledger.record_opening_balance(plan.liability_account_id, plan.principal, when)
    elif opening is Opening.DEPOSIT:
        if deposit_account_id is None:
            raise DomainError("Escolha a conta que recebeu o dinheiro.")
        ledger.record_transfer(
            plan.liability_account_id, deposit_account_id, plan.principal, when, f"Liberação — {plan.name}"
        )
    return ledger.put("loan_plan", plan)


def update_loan(ledger: Ledger, plan: LoanPlan, reason: str) -> LoanPlan:
    current = plans(ledger).get(plan.id)
    if current is None:
        raise DomainError("Financiamento inexistente.")
    _check_accounts(ledger, plan)
    schedule(plan)
    return ledger.put("loan_plan", plan.model_copy(update={"version": current.version + 1}), reason=reason)


def pay_installment(
    ledger: Ledger, plan_id: UUID, number: int, on: date, amount: object | None = None, from_account: UUID | None = None
) -> Operation:
    """Records installment `number`. Paying more than scheduled (late charges) adds the difference to interest."""
    plan = plans(ledger).get(plan_id)
    if plan is None:
        raise DomainError("Financiamento inexistente.")
    if number in paid_numbers(ledger, plan_id):
        raise DomainError("Esta parcela já foi paga.")
    items = {i.number: i for i in plan_schedule(ledger, plan_id)}
    item = items.get(number)
    if item is None:
        raise DomainError("Parcela inexistente.")
    value = item.payment if amount is None else to_decimal(amount)
    if value < item.payment:
        raise DomainError("O valor pago é menor que a parcela. Pagamento parcial não é registrado como parcela.")
    interest = item.interest + (value - item.payment)
    source = from_account or plan.payment_account_id
    postings = [Posting(account_id=plan.liability_account_id, amount=item.amortization)]
    if interest > 0:
        postings.append(Posting(account_id=plan.interest_category_id, amount=interest))
    if item.fees > 0 and plan.fees_category_id is not None:
        postings.append(Posting(account_id=plan.fees_category_id, amount=item.fees))
    postings.append(Posting(account_id=source, amount=-value))
    op = ledger.add_operation(
        Operation(
            kind=OperationKind.OTHER,
            description=f"Parcela {number}/{len(items)} — {plan.name}",
            postings=tuple(postings),
            occurred_on=on,
            settled_on=on,
            due_on=item.due,
            accrual_month=YearMonth.of(item.due),
        )
    )
    ledger.put("loan_payment", LoanPayment(plan_id=plan_id, number=number, operation_id=op.id, paid_on=on))
    return op


def prepay(
    ledger: Ledger, plan_id: UUID, amount: object, on: date, mode: PrepaymentMode, from_account: UUID | None = None
) -> LoanPrepayment:
    """Early repayment: the whole amount amortizes the debt (no interest), after the last paid installment."""
    plan = plans(ledger).get(plan_id)
    if plan is None:
        raise DomainError("Financiamento inexistente.")
    value = to_decimal(amount)
    if value <= 0 or not is_cents(value):
        raise DomainError("Informe um valor positivo em reais e centavos.")
    current = status(ledger, plan_id, on)
    if value > current.outstanding:
        raise DomainError("O valor passa do saldo devedor.")
    after = max(paid_numbers(ledger, plan_id), default=0)
    op = ledger.add_operation(
        Operation(
            kind=OperationKind.OTHER,
            description=f"Amortização antecipada — {plan.name}",
            postings=(
                Posting(account_id=plan.liability_account_id, amount=value),
                Posting(account_id=from_account or plan.payment_account_id, amount=-value),
            ),
            occurred_on=on,
            settled_on=on,
        )
    )
    return ledger.put(
        "loan_prepayment",
        LoanPrepayment(plan_id=plan_id, after_number=after, amount=value, mode=mode, paid_on=on, operation_id=op.id),
    )


@dataclass(frozen=True)
class PrepaymentSimulation:
    amount: Decimal
    mode: PrepaymentMode
    interest_before: Decimal  # interest still to pay without the prepayment
    interest_after: Decimal
    installments_before: int  # unpaid installments
    installments_after: int
    next_payment_before: Decimal | None
    next_payment_after: Decimal | None

    @property
    def interest_saved(self) -> Decimal:
        return self.interest_before - self.interest_after


def simulate_prepayment(ledger: Ledger, plan_id: UUID, amount: object, mode: PrepaymentMode) -> PrepaymentSimulation:
    """What an early repayment now would save. A simulation: nothing is recorded."""
    plan = plans(ledger)[plan_id]
    value = to_decimal(amount)
    if value <= 0:
        raise DomainError("Informe um valor positivo.")
    paid = paid_numbers(ledger, plan_id)
    after = max(paid, default=0)
    current = _extra(ledger, plan_id)
    before = [i for i in schedule(plan, current) if i.number not in paid]
    later = [i for i in schedule(plan, [*current, (after, value, mode)]) if i.number not in paid]
    return PrepaymentSimulation(
        value,
        mode,
        sum((i.interest for i in before), ZERO),
        sum((i.interest for i in later), ZERO),
        len(before),
        len(later),
        before[0].payment if before else None,
        later[0].payment if later else None,
    )


def upcoming(ledger: Ledger, start: date, end: date) -> list[tuple[LoanPlan, Installment]]:
    """Unpaid installments due between `start` and `end` (projection and calendar)."""
    out = []
    for plan in plans(ledger).values():
        paid = paid_numbers(ledger, plan.id)
        for item in plan_schedule(ledger, plan.id):
            if item.number not in paid and start <= item.due <= end:
                out.append((plan, item))
    return sorted(out, key=lambda pair: pair[1].due)


def loan_operation_ids(ledger: Ledger) -> set[UUID]:
    """Operations that pay installments (fixed expenses in the indicators)."""
    return {p.operation_id for p in payments(ledger).values()}
