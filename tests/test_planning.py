"""Features of the review of 03/10/2026 (docs/09 §1.3 E): loans, tags, reimbursements, settling up,
bank checks, deductible expenses, subscriptions, calendar, indicators, comparisons and projection."""

import json
from datetime import date
from decimal import Decimal

import pytest

from opesvault.charts import data as charts
from opesvault.domain import (
    agenda,
    alerts,
    balance_checks,
    comparisons,
    deductibles,
    indicators,
    loans,
    projection,
    queries,
    sharing,
    subscriptions,
    tags,
)
from opesvault.domain.cards import CompetencePolicy, record_installment_purchase
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount, YearMonth
from opesvault.domain.periods import close_month
from opesvault.domain.recurrence import Frequency, RecurrenceRule, add_rule, realize
from opesvault.domain.search import OperationFilter, find_operations

from .domain_fixtures import Family, category, family

D = Decimal


def _loan(
    f: Family, system: loans.AmortizationSystem = loans.AmortizationSystem.PRICE, **extra: object
) -> loans.LoanPlan:
    debt = f.ledger.add_account(LedgerAccount(name="Carro", type=AccountType.LIABILITY, subtype=AccountSubtype.LOAN))
    fields: dict[str, object] = {
        "name": "Carro",
        "liability_account_id": debt.id,
        "payment_account_id": f.bank,
        "interest_category_id": category(f.ledger, "Juros e encargos"),
        "principal": D("1000.00"),
        "monthly_rate": D("0.01"),
        "term": 12,
        "system": system,
        "first_due": date(2026, 2, 10),
    }
    fields.update(extra)
    return loans.LoanPlan(**fields)  # type: ignore[arg-type]


# ── loans ────────────────────────────────────────────────


def test_price_schedule_matches_the_textbook_installment() -> None:
    f = family()
    items = loans.schedule(_loan(f))
    assert len(items) == 12
    assert items[0].payment == D("88.85")  # 1000 × 0.01 / (1 − 1.01^−12) = 88,8488 → 88,85
    assert items[0].interest == D("10.00") and items[0].amortization == D("78.85")
    assert all(i.payment == D("88.85") for i in items[:-1])
    assert sum((i.amortization for i in items), D(0)) == D("1000.00")
    assert items[-1].balance_after == 0 and items[-1].due == date(2027, 1, 10)


def test_sac_schedule_has_constant_amortization() -> None:
    f = family()
    items = loans.schedule(_loan(f, loans.AmortizationSystem.SAC, principal=D("1200.00")))
    assert {i.amortization for i in items} == {D("100.00")}
    assert items[0].payment == D("112.00") and items[-1].payment == D("101.00")
    assert [i.payment for i in items] == sorted((i.payment for i in items), reverse=True)


def test_zero_rate_and_rounding_residual_go_to_the_last_installment() -> None:
    f = family()
    items = loans.schedule(_loan(f, principal=D("100.00"), monthly_rate=D("0"), term=3))
    assert [i.payment for i in items] == [D("33.33"), D("33.33"), D("33.34")]


def test_annual_rate_converts_to_the_equivalent_monthly_rate() -> None:
    assert loans.annual_to_monthly("0.126825030") == D("0.0100000000")
    with pytest.raises(DomainError):
        loans.annual_to_monthly("-0.1")


def test_paying_an_installment_splits_amortization_interest_and_fees() -> None:
    f = family()
    fees = category(f.ledger, "Serviços e assinaturas")
    plan = loans.create_loan(
        f.ledger,
        _loan(f, fees_per_installment=D("5.00"), fees_category_id=fees),
        loans.Opening.OPENING_BALANCE,
        on=date(2026, 1, 10),
    )
    assert queries.balance(f.ledger, plan.liability_account_id) == D("1000.00")
    op = loans.pay_installment(f.ledger, plan.id, 1, date(2026, 2, 10))
    by_account = {p.account_id: p.amount for p in op.postings}
    assert by_account[plan.liability_account_id] == D("78.85")
    assert by_account[plan.interest_category_id] == D("10.00")
    assert by_account[fees] == D("5.00")
    assert by_account[f.bank] == D("-93.85")
    status = loans.status(f.ledger, plan.id, date(2026, 3, 1))
    assert status.outstanding == status.ledger_balance == D("921.15")
    assert status.paid == 1 and status.next_due is not None and status.next_due.number == 2
    with pytest.raises(DomainError, match="já foi paga"):
        loans.pay_installment(f.ledger, plan.id, 1, date(2026, 2, 11))
    with pytest.raises(DomainError, match="menor"):
        loans.pay_installment(f.ledger, plan.id, 2, date(2026, 3, 10), "50.00")
    late = loans.pay_installment(f.ledger, plan.id, 2, date(2026, 3, 15), "100.00")  # with late charges
    interest = sum((p.amount for p in late.postings if p.account_id == plan.interest_category_id), D(0))
    assert interest == D("100.00") - D("5.00") - loans.plan_schedule(f.ledger, plan.id)[1].amortization


def test_deposit_opening_and_cancelled_payment() -> None:
    f = family()
    plan = loans.create_loan(f.ledger, _loan(f), loans.Opening.DEPOSIT, on=date(2026, 1, 5), deposit_account_id=f.bank)
    assert queries.balance(f.ledger, f.bank) == D("1000.00")
    op = loans.pay_installment(f.ledger, plan.id, 1, date(2026, 2, 10))
    f.ledger.cancel_operation(op.id, "lançado em duplicidade")
    assert loans.status(f.ledger, plan.id).paid == 0  # a cancelled operation does not pay


def test_prepayment_reduces_term_or_payment_and_simulation_writes_nothing() -> None:
    f = family()
    plan = loans.create_loan(f.ledger, _loan(f), loans.Opening.OPENING_BALANCE, on=date(2026, 1, 10))
    loans.pay_installment(f.ledger, plan.id, 1, date(2026, 2, 10))
    before = f.ledger.change_count
    shorter = loans.simulate_prepayment(f.ledger, plan.id, "300.00", loans.PrepaymentMode.REDUCE_TERM)
    lower = loans.simulate_prepayment(f.ledger, plan.id, "300.00", loans.PrepaymentMode.REDUCE_PAYMENT)
    assert f.ledger.change_count == before
    assert shorter.installments_after < shorter.installments_before == 11
    assert shorter.next_payment_after == shorter.next_payment_before
    assert lower.installments_after == 11 and lower.next_payment_after is not None
    assert lower.next_payment_before is not None and lower.next_payment_after < lower.next_payment_before
    assert shorter.interest_saved > lower.interest_saved > 0
    loans.prepay(f.ledger, plan.id, "300.00", date(2026, 2, 20), loans.PrepaymentMode.REDUCE_TERM)
    status = loans.status(f.ledger, plan.id, date(2026, 3, 1))
    assert status.outstanding == status.ledger_balance == D("621.15")
    assert len(status.installments) == 1 + shorter.installments_after
    with pytest.raises(DomainError, match="saldo devedor"):
        loans.prepay(f.ledger, plan.id, "5000.00", date(2026, 2, 21), loans.PrepaymentMode.REDUCE_TERM)


def test_loan_validation() -> None:
    f = family()
    with pytest.raises(DomainError, match="empréstimo"):
        loans.create_loan(f.ledger, _loan(f).model_copy(update={"liability_account_id": f.card_account}))
    with pytest.raises(DomainError, match="categoria dos encargos"):
        loans.create_loan(f.ledger, _loan(f, fees_per_installment=D("5.00")))
    with pytest.raises(DomainError, match="conta que recebeu"):
        loans.create_loan(f.ledger, _loan(f), loans.Opening.DEPOSIT)
    assert loans.plans(f.ledger) == {}


# ── tags ─────────────────────────────────────────────────


def test_tags_group_operations_and_a_plan_is_tagged_whole() -> None:
    f = family()
    lodging = f.ledger.record_card_purchase(f.card, category(f.ledger, "Lazer"), "900.00", date(2026, 2, 2), "Pousada")
    food = f.ledger.record_expense(f.bank, f.groceries, "120.00", date(2026, 2, 3), "Restaurante")
    plan = record_installment_purchase(
        f.ledger, f.card, category(f.ledger, "Lazer"), "600.00", date(2026, 2, 4), "Passeio", 3, CompetencePolicy.SPREAD
    )
    assert tags.add_tag(f.ledger, [lodging.id, food.id], "Viagem 2026") == 2
    tags.add_tag(f.ledger, [plan.operation_ids[0]], "viagem 2026")  # same tag, other spelling
    assert tags.all_tags(f.ledger) == ["Viagem 2026"]
    assert tags.operations_with(f.ledger, "VIAGEM 2026") == {lodging.id, food.id, *plan.operation_ids}
    found = tags.summary(f.ledger, "Viagem 2026")
    assert found.expense == D("1620.00") and found.first == date(2026, 2, 2)
    assert found.by_category[category(f.ledger, "Lazer")] == D("1500.00")
    ids = frozenset(tags.operations_with(f.ledger, "Viagem 2026"))
    assert {o.id for o in find_operations(f.ledger, OperationFilter(operation_ids=ids))} == ids
    assert tags.rename_tag(f.ledger, "Viagem 2026", "Férias") == 5
    assert tags.all_tags(f.ledger) == ["Férias"]
    tags.remove_tag(f.ledger, [food.id], "férias")
    assert tags.tags_of(f.ledger, food.id) == ()
    with pytest.raises(DomainError):
        tags.add_tag(f.ledger, [food.id], "   ")


def test_tagging_is_allowed_in_a_closed_month() -> None:
    f = family()
    op = f.ledger.record_expense(f.bank, f.groceries, "50.00", date(2026, 1, 5), "Feira")
    close_month(f.ledger, YearMonth(year=2026, month=1), "teste")
    tags.add_tag(f.ledger, [op.id], "Casa")
    assert tags.tags_of(f.ledger, op.id) == ("Casa",)


# ── reimbursements and settling up ───────────────────────


def test_reimbursement_is_received_as_a_refund_of_the_same_categories() -> None:
    f = family()
    health = category(f.ledger, "Saúde")
    op = f.ledger.record_expense(f.bank, health, "400.00", date(2026, 3, 5), "Exame")
    with pytest.raises(DomainError, match="passa do valor"):
        sharing.request(f.ledger, op.id, "Plano", "500.00")
    item = sharing.request(f.ledger, op.id, "Plano", "300.00", date(2026, 3, 6))
    with pytest.raises(DomainError, match="já tem"):
        sharing.request(f.ledger, op.id, "Plano", "100.00")
    assert sharing.state(f.ledger, item) is sharing.ReimbursementState.PENDING
    sharing.receive(f.ledger, item.id, f.bank, "100.00", date(2026, 4, 2))
    item = sharing.reimbursements(f.ledger)[item.id]
    assert sharing.state(f.ledger, item) is sharing.ReimbursementState.PARTIAL
    sharing.receive(f.ledger, item.id, f.bank, "200.00", date(2026, 4, 9))
    item = sharing.reimbursements(f.ledger)[item.id]
    assert sharing.state(f.ledger, item) is sharing.ReimbursementState.RECEIVED
    assert sharing.received(f.ledger, item) == D("300.00")
    april = queries.income_statement(f.ledger, YearMonth(year=2026, month=4))
    assert april.expense[health] == D("-300.00") and april.total_income == 0  # never counted as income
    assert sharing.open_items(f.ledger) == []


def test_denied_reimbursement() -> None:
    f = family()
    op = f.ledger.record_expense(f.bank, f.groceries, "80.00", date(2026, 3, 5), "Almoço de trabalho")
    item = sharing.request(f.ledger, op.id, "Empresa", "80.00")
    sharing.deny(f.ledger, item.id, "fora da política")
    assert sharing.state(f.ledger, sharing.reimbursements(f.ledger)[item.id]) is sharing.ReimbursementState.DENIED
    with pytest.raises(DomainError):
        sharing.receive(f.ledger, item.id, f.bank, "10.00", date(2026, 3, 9))


def test_who_owes_whom() -> None:
    f = family()
    rent = category(f.ledger, "Moradia")
    # Ana's own account pays a split expense: Bruno owes his share.
    f.ledger.record_expense(f.bank, [(rent, "600.00"), (rent, "400.00")], "1000.00", date(2026, 3, 1), "Aluguel")
    op = f.ledger.operations[next(reversed(list(f.ledger.operations)))]
    f.ledger.update_operation(
        op.model_copy(
            update={
                "postings": (
                    op.postings[0].model_copy(update={"member_id": f.ana}),
                    op.postings[1].model_copy(update={"member_id": f.bruno}),
                    op.postings[2],
                )
            }
        ),
        "rateio",
    )
    # The joint account paid for Bruno: nobody fronted anything.
    f.ledger.record_expense(f.joint, f.groceries, "90.00", date(2026, 3, 2), "Feira", member_id=f.bruno)
    # The card (Ana) paid for Bruno.
    f.ledger.record_card_purchase(f.card, f.groceries, "60.00", date(2026, 3, 3), "Lanche", member_id=f.bruno)
    found = sharing.balances(f.ledger)
    assert [(b.debtor_id, b.creditor_id, b.amount) for b in found] == [(f.bruno, f.ana, D("460.00"))]
    sharing.settle(f.ledger, f.bruno, f.ana, "400.00", date(2026, 3, 20))
    assert [b.amount for b in sharing.balances(f.ledger)] == [D("60.00")]
    sharing.settle(f.ledger, f.bruno, f.ana, "100.00", date(2026, 3, 21))  # paid back too much
    assert [(b.debtor_id, b.amount) for b in sharing.balances(f.ledger)] == [(f.ana, D("40.00"))]
    with pytest.raises(DomainError):
        sharing.settle(f.ledger, f.ana, f.ana, "1.00", date(2026, 3, 22))


# ── bank checks ──────────────────────────────────────────


def test_bank_check_shows_the_difference_until_the_missing_operation_is_registered() -> None:
    f = family()
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2026, 1, 1))
    check = balance_checks.record(f.ledger, f.bank, date(2026, 1, 31), "880.00", "extrato")
    [result] = balance_checks.results(f.ledger, f.bank)
    assert result.difference == D("-120.00") and not result.matches
    assert [a.title for a in alerts.balance_check_alerts(f.ledger)] == ["Saldo diferente do banco: Banco A"]
    f.ledger.record_expense(f.bank, f.groceries, "120.00", date(2026, 1, 20), "Compra esquecida")
    assert balance_checks.divergent(f.ledger) == [] and alerts.balance_check_alerts(f.ledger) == []
    later = f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 2, 1), "Depois da conferência")
    assert balance_checks.divergent(f.ledger) == []  # the check compares on its own date
    assert later.id
    balance_checks.remove(f.ledger, check.id)
    assert balance_checks.results(f.ledger) == []


# ── deductible expenses ──────────────────────────────────


def test_deductible_totals_per_person_and_kind() -> None:
    f = family()
    health = category(f.ledger, "Saúde")
    dentist = f.ledger.add_account(
        LedgerAccount(name="Dentista", type=AccountType.EXPENSE, subtype=AccountSubtype.CATEGORY, parent_id=health)
    )
    deductibles.mark(f.ledger, health, deductibles.DeductibleKind.HEALTH)
    assert deductibles.kind_of(f.ledger, dentist.id) is deductibles.DeductibleKind.HEALTH  # inherited
    f.ledger.record_expense(f.bank, dentist.id, "500.00", date(2026, 5, 2), "Canal", member_id=f.bruno)
    f.ledger.record_expense(f.bank, health, "200.00", date(2026, 6, 2), "Consulta", member_id=f.bruno)
    f.ledger.record_expense(f.bank, health, "90.00", date(2025, 12, 2), "Ano anterior", member_id=f.bruno)
    f.ledger.record_expense(f.bank, f.groceries, "70.00", date(2026, 6, 3), "Mercado", member_id=f.bruno)
    consult = f.ledger.record_expense(f.bank, health, "300.00", date(2026, 7, 2), "Consulta Ana", member_id=f.ana)
    item = sharing.request(f.ledger, consult.id, "Plano", "100.00")
    sharing.receive(f.ledger, item.id, f.bank, "100.00", date(2026, 7, 20))
    groups = {(g.kind, g.member_id): g for g in deductibles.annual(f.ledger, 2026)}
    assert groups[(deductibles.DeductibleKind.HEALTH, f.bruno)].total == D("700.00")
    assert groups[(deductibles.DeductibleKind.HEALTH, f.ana)].total == D("200.00")  # net of the reimbursement
    assert len(groups) == 2
    deductibles.mark(f.ledger, health, None)
    assert deductibles.annual(f.ledger, 2026) == []
    with pytest.raises(DomainError):
        deductibles.mark(f.ledger, f.bank, deductibles.DeductibleKind.OTHER)


# ── subscriptions ────────────────────────────────────────


def _rule(f: Family, description: str, amount: str, frequency: Frequency = Frequency.MONTHLY) -> RecurrenceRule:
    return add_rule(
        f.ledger,
        RecurrenceRule(
            description=description,
            account_id=f.card_account,
            counterpart_id=category(f.ledger, "Serviços e assinaturas"),
            amount=D(amount),
            frequency=frequency,
            day=12,
            start=date(2026, 1, 1),
        ),
    )


def test_commitments_cost_per_year_and_price_change() -> None:
    f = family()
    streaming = _rule(f, "Streaming", "39.90")
    _rule(f, "Antivírus", "120.00", Frequency.YEARLY)
    _rule(f, "Aula", "50.00", Frequency.WEEKLY)
    found = {c.rule.description: c for c in subscriptions.commitments(f.ledger)}
    assert found["Streaming"].per_year == D("478.80")
    assert found["Antivírus"].per_year == D("120.00") and found["Aula"].per_year == D("2600.00")
    assert subscriptions.yearly_total(f.ledger) == D("3198.80")
    services = category(f.ledger, "Serviços e assinaturas")
    for month, value in ((1, "39.90"), (2, "44.90")):
        op = f.ledger.record_card_purchase(f.card, services, value, date(2026, month, 12), "STREAMING")
        realize(f.ledger, streaming.id, date(2026, month, 12), op.id)
    changed = next(c for c in subscriptions.commitments(f.ledger) if c.rule.id == streaming.id)
    assert changed.price_changed and changed.last_paid == D("44.90") and changed.previous_paid == D("39.90")
    assert [a.title for a in alerts.price_alerts(f.ledger)] == ["Valor mudou: Streaming"]


def test_recurring_charges_without_a_rule_are_suggested() -> None:
    f = family()
    services = category(f.ledger, "Serviços e assinaturas")
    for month in (1, 2, 3, 4):
        f.ledger.record_card_purchase(f.card, services, "21.90", date(2026, month, 8), "SPOTIFY P1A2B3")
    f.ledger.record_card_purchase(f.card, services, "15.00", date(2026, 1, 9), "AVULSO")
    [found] = subscriptions.candidates(f.ledger, date(2026, 4, 20))
    assert found.description == "SPOTIFY P1A2B3" and found.amount == D("21.90") and found.day == 8
    assert found.account_id == f.card_account and found.category_id == services and found.months == 4
    assert subscriptions.candidates(f.ledger, date(2026, 8, 1)) == []  # stopped: no longer suggested
    _rule(f, "Spotify", "21.90")
    assert subscriptions.candidates(f.ledger, date(2026, 4, 20)) == []  # already registered


# ── calendar, indicators, comparisons ────────────────────


def test_calendar_lists_bills_recurrences_and_installments_with_state() -> None:
    f = family()
    f.ledger.record_card_purchase(f.card, f.groceries, "300.00", date(2026, 2, 20), "Mercado")  # due 10/03
    rent = add_rule(
        f.ledger,
        RecurrenceRule(
            description="Aluguel",
            account_id=f.bank,
            counterpart_id=category(f.ledger, "Moradia"),
            amount=D("2000"),
            day=5,
            start=date(2026, 1, 1),
        ),
    )
    plan = loans.create_loan(f.ledger, _loan(f, first_due=date(2026, 3, 15)), loans.Opening.OPENING_BALANCE)
    events = agenda.month_events(f.ledger, YearMonth(year=2026, month=3), date(2026, 3, 12))
    states = {e.title: (e.on, e.state, e.amount) for e in events}
    assert states["Aluguel"] == (date(2026, 3, 5), agenda.EventState.LATE, D("-2000"))
    assert states["Fatura Cartão X"] == (date(2026, 3, 10), agenda.EventState.LATE, D("-300.00"))
    assert states["Parcela 1 — Carro"][1] is agenda.EventState.PENDING
    f.ledger.record_card_payment(f.card, f.bank, "300.00", date(2026, 3, 10))
    loans.pay_installment(f.ledger, plan.id, 1, date(2026, 3, 15))
    op = f.ledger.record_expense(f.bank, category(f.ledger, "Moradia"), "2000.00", date(2026, 3, 5), "Aluguel")
    realize(f.ledger, rent.id, date(2026, 3, 5), op.id)
    events = agenda.month_events(f.ledger, YearMonth(year=2026, month=3), date(2026, 3, 20))
    assert {e.state for e in events} == {agenda.EventState.DONE}
    assert list(agenda.by_day(events)) == sorted({e.on for e in events})


def test_indicators_say_why_they_are_unavailable() -> None:
    f = family()
    march = YearMonth(year=2026, month=3)
    found = {i.key: i for i in indicators.indicators(f.ledger, march)}
    assert all(i.value is None for i in found.values())
    assert found["savings"].detail == "Sem receitas no mês."
    f.ledger.record_opening_balance(f.bank, "6000.00", date(2026, 1, 1))
    for month in (1, 2, 3):
        f.ledger.record_income(f.bank, f.salary, "5000.00", date(2026, month, 5), "Salário")
        f.ledger.record_expense(f.bank, f.groceries, "1000.00", date(2026, month, 8), "Mercado")
    rent_rule = add_rule(
        f.ledger,
        RecurrenceRule(
            description="Aluguel",
            account_id=f.bank,
            counterpart_id=category(f.ledger, "Moradia"),
            amount=D("1000"),
            day=10,
            start=date(2026, 3, 1),
        ),
    )
    rent = f.ledger.record_expense(f.bank, category(f.ledger, "Moradia"), "1000.00", date(2026, 3, 10), "Aluguel")
    realize(f.ledger, rent_rule.id, date(2026, 3, 10), rent.id)
    record_installment_purchase(f.ledger, f.card, f.groceries, "1500.00", date(2026, 2, 20), "Geladeira", 3)
    found = {i.key: i for i in indicators.indicators(f.ledger, march)}
    assert found["savings"].value == D("0.6000")  # (5000 − 1000 − 1000) / 5000; the fridge is February's
    assert found["fixed"].value == D("0.5000")
    assert found["committed"].value == D("0.1000")  # one 500,00 installment of the fridge in the March bill
    assert found["reserve"].value is not None and found["reserve"].unit == "meses"


def test_comparison_ignores_months_before_the_first_record() -> None:
    f = family()
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2025, 1, 1))  # not activity
    assert comparisons.first_activity(f.ledger) is None
    f.ledger.record_expense(f.bank, f.groceries, "300.00", date(2026, 2, 3), "Feira")
    f.ledger.record_expense(f.bank, f.groceries, "600.00", date(2026, 3, 3), "Feira")
    rows = {r.category_id: r for r in comparisons.category_comparison(f.ledger, YearMonth(year=2026, month=3))}
    row = rows[f.groceries]
    assert row.current == D("600.00") and row.average == D("300.00") and row.months_averaged == 1
    assert row.change == D("1.0000") and row.last_year is None
    totals = {r.name: r for r in comparisons.totals_comparison(f.ledger, YearMonth(year=2026, month=2))}
    assert totals["Despesas"].average is None  # nothing known before February


# ── projection ───────────────────────────────────────────


def test_projected_balance_and_alert_before_going_negative() -> None:
    f = family()
    today = date(2026, 3, 1)
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2026, 1, 1))
    f.ledger.record_card_purchase(f.card, f.groceries, "700.00", date(2026, 2, 20), "Mercado")  # due 10/03 from bank
    add_rule(
        f.ledger,
        RecurrenceRule(
            description="Aluguel",
            account_id=f.bank,
            counterpart_id=category(f.ledger, "Moradia"),
            amount=D("500"),
            day=15,
            start=date(2026, 3, 1),
        ),
    )
    add_rule(
        f.ledger,
        RecurrenceRule(
            description="Salário",
            account_id=f.bank,
            counterpart_id=f.salary,
            amount=D("3000"),
            day=30,
            start=date(2026, 3, 1),
        ),
    )
    [bank] = [p for p in projection.project(f.ledger, today, 40, [f.bank])]
    assert [(e.on, e.amount) for e in bank.events] == [
        (date(2026, 3, 10), D("-700.00")),
        (date(2026, 3, 15), D("-500")),
        (date(2026, 3, 30), D("3000")),
    ]
    assert bank.first_negative == date(2026, 3, 15) and bank.lowest == (date(2026, 3, 15), D("-200.00"))
    assert bank.balance_on(date(2026, 4, 1)) == D("2800.00")
    [alert] = alerts.projection_alerts(f.ledger, today)
    assert alert.title == "Saldo previsto negativo: Banco A" and "15/03" in alert.detail
    assert queries.balance(f.ledger, f.bank) == D("1000.00")  # a projection never changes balances
    chart = charts.projected_balance(f.ledger, today, 40)
    headers, rows = charts.table_rows(chart)
    assert "Banco A" in headers and all(None not in r.values for r in rows)  # every account known every day


def test_card_without_payment_account_is_left_out_with_a_note() -> None:
    f = family()
    card = f.ledger.cards[f.card]
    f.ledger.update_card(card.model_copy(update={"settlement_account_id": None}), "sem conta")
    f.ledger.record_card_purchase(f.card, f.groceries, "100.00", date(2026, 2, 20), "Mercado")
    found, notes = projection.events(f.ledger, date(2026, 3, 1), date(2026, 4, 1))
    assert found == [] and notes == ["Fatura de Cartão X sem conta de pagamento: fora da projeção."]


# ── the table of values behind a chart ───────────────────


def test_table_rows_total_flows_but_not_positions() -> None:
    f = family()
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2026, 1, 1))
    f.ledger.record_income(f.bank, f.salary, "500.00", date(2026, 2, 5), "Salário")
    f.ledger.record_expense(f.bank, f.groceries, "200.00", date(2026, 3, 5), "Feira")
    chart = charts.cash_flow_balance(f.ledger, YearMonth(year=2026, month=1), YearMonth(year=2026, month=3))
    headers, rows = charts.table_rows(chart)
    assert headers == ["Entradas", "Saídas", "Saldo das contas"]
    assert [r.label for r in rows] == ["2026-01", "2026-02", "2026-03", "Total", "Média"]
    assert rows[-2].values == [D("500.00"), D("200.00"), None]  # a balance never adds up
    assert rows[-1].values[0] == D("166.67")
    summary = charts.monthly_summary(f.ledger, YearMonth(year=2026, month=1), YearMonth(year=2026, month=3))
    hidden = [s.name for s in summary.series if s.hidden]
    assert "Patrimônio líquido" in hidden and "Patrimônio líquido" in charts.table_rows(summary)[0]


# ── persistence ──────────────────────────────────────────


def test_new_kinds_survive_a_save_and_open() -> None:
    f = family()
    plan = loans.create_loan(f.ledger, _loan(f), loans.Opening.OPENING_BALANCE, on=date(2026, 1, 10))
    loans.pay_installment(f.ledger, plan.id, 1, date(2026, 2, 10))
    loans.prepay(f.ledger, plan.id, "100.00", date(2026, 2, 11), loans.PrepaymentMode.REDUCE_PAYMENT)
    op = f.ledger.record_expense(f.bank, category(f.ledger, "Saúde"), "200.00", date(2026, 2, 3), "Consulta")
    tags.add_tag(f.ledger, [op.id], "Saúde")
    item = sharing.request(f.ledger, op.id, "Plano", "100.00")
    sharing.receive(f.ledger, item.id, f.bank, "50.00", date(2026, 2, 20))
    sharing.settle(f.ledger, f.bruno, f.ana, "10.00", date(2026, 2, 21))
    balance_checks.record(f.ledger, f.bank, date(2026, 2, 28), "0.00")
    deductibles.mark(f.ledger, category(f.ledger, "Saúde"), deductibles.DeductibleKind.HEALTH)
    rows = f.ledger.to_records()
    lines = [(str(rid), kind, json.dumps(payload)) for rid, kind, payload in rows]
    opened = Ledger.from_raw(lines)
    for kind in (
        "loan_plan",
        "loan_payment",
        "loan_prepayment",
        "operation_tags",
        "reimbursement",
        "member_settlement",
        "balance_check",
        "deductible_category",
    ):
        assert opened.entities(kind) == f.ledger.entities(kind), kind
    assert loans.status(opened, plan.id) == loans.status(f.ledger, plan.id)
