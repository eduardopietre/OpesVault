"""Planning modules over seeded ledgers (docs/18 §4, phase W4).

recurrence, cards, periods, budget, balance_checks, loans, deductibles, sharing, saved_filters,
settings, comparisons, goals, tags, merchants, anomalies, subscriptions, projection and indicators.

Each scenario builds a family ledger through the public API with a fixed seed, dumps its records,
then computes every public query over the reloaded ledger and replays commands that change it.
The TS side loads the same records, computes the same queries and replays the same commands.

Ids created while replaying are random, so outputs are anonymized: any id that is not in the
records becomes "new:<n>" in order of first appearance (keys visited in sorted order), and
instants become "<instant>". Orders that Python leaves undefined (sets) are sorted here.
"""

import random
import re
from datetime import date, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

from pydantic import ValidationError

from opesvault.domain import (
    anomalies,
    balance_checks,
    budget,
    cards,
    comparisons,
    deductibles,
    goals,
    indicators,
    loans,
    merchants,
    periods,
    projection,
    recurrence,
    saved_filters,
    settings,
    sharing,
    subscriptions,
    tags,
)
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, Card, LedgerAccount, YearMonth
from scripts.golden.common import j

START = date(2025, 6, 1)
MONTHS = 14
TODAYS = [date(2026, 3, 15), date(2026, 7, 20), date(2026, 8, 5)]
SEEDS = (1, 2, 3)

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
INSTANT_KEYS = {"closed_at", "at"}

DESCRIPTIONS = [
    "IFD*IFOOD.COM AGENCIA",
    "IFD*IFOOD.COM AGENCIA 7781",
    "MP*LOJA DO ZE 123456",
    "PADARIA REAL LTDA BR",
    "SPOTIFY P1A2B3",
    "NETFLIX.COM",
    "TV 55 (3/10)",
    "12345",
    "  Farmácia São João  ",
    "UBER *TRIP 8812",
    "PAG*Açaí do Bairro",
    "APPLE.COM/BILL",
    "POSTO SHELL",
    "Loja.COM.BR Centro",
    "MERCADO.COMPRAS",
    "ÇA.COMÉRCIO",
    "",
    "x" * 70,
    "ß straße",
]


def _money(rng: random.Random, low: int = 100, high: int = 50_000) -> str:
    return str(Decimal(rng.randint(low, high)) / 100)


def _d(text: str) -> date:
    return date.fromisoformat(text)


def build(seed: int) -> tuple[Ledger, dict[str, Any]]:
    rng = random.Random(seed)
    ledger = Ledger.new("Projeto Golden")
    ana = ledger.add_member("Ana").id
    bruno = ledger.add_member("Bruno").id

    def account(name: str, kind: AccountType, sub: AccountSubtype, holders: tuple[UUID, ...] = (), **kw: Any) -> UUID:
        return ledger.add_account(LedgerAccount(name=name, type=kind, subtype=sub, holders=holders, **kw)).id

    asset, liability = AccountType.ASSET, AccountType.LIABILITY
    n: dict[str, Any] = {
        "ana": ana,
        "bruno": bruno,
        "bank": account("Banco A", asset, AccountSubtype.CHECKING, (ana,)),
        "savings": account("Poupança", asset, AccountSubtype.SAVINGS, (ana,)),
        "joint": account("Conjunta", asset, AccountSubtype.CHECKING, (ana, bruno)),
        "cash": account("Carteira", asset, AccountSubtype.CASH),
        "bruno_bank": account("Banco B", asset, AccountSubtype.CHECKING, (bruno,)),
        "invest": account("Investimentos", asset, AccountSubtype.INVESTMENT, (ana,)),
        "card_account": account("Cartão X", liability, AccountSubtype.CREDIT_CARD),
        "card2_account": account("Cartão Y", liability, AccountSubtype.CREDIT_CARD),
        "loan1": account("Financiamento Carro", liability, AccountSubtype.LOAN),
        "loan2": account("Empréstimo Casa", liability, AccountSubtype.LOAN),
    }
    closing, due = [(3, 10), (25, 5), (31, 8), (10, 20)][seed % 4]
    n["card"] = ledger.add_card(
        Card(
            name="Cartão X",
            liability_account_id=n["card_account"],
            holder_id=ana,
            last4="1234",
            closing_day=closing,
            due_day=due,
            settlement_account_id=n["bank"],
        )
    ).id
    n["card2"] = ledger.add_card(
        Card(
            name="Cartão Y",
            liability_account_id=n["card2_account"],
            holder_id=bruno,
            last4="9876",
            closing_day=15,
            due_day=25,
            settlement_account_id=n["bruno_bank"] if seed != 2 else None,
        )
    ).id
    cat = {a.name: a.id for a in ledger.categories(AccountType.EXPENSE)}
    inc = {a.name: a.id for a in ledger.categories(AccountType.INCOME)}
    house = account("Casa", AccountType.EXPENSE, AccountSubtype.CATEGORY)
    cat["Casa"] = house
    cat["Casa — reparos"] = account("Casa — reparos", AccountType.EXPENSE, AccountSubtype.CATEGORY, parent_id=house)
    cat["Dentista"] = account("Dentista", AccountType.EXPENSE, AccountSubtype.CATEGORY, parent_id=cat["Saúde"])
    n["cat"] = cat
    n["inc"] = inc

    ledger.record_opening_balance(n["bank"], "3500.00", START)
    ledger.record_opening_balance(n["joint"], "1200.00", START)
    ledger.record_opening_balance(n["bruno_bank"], "800.00", START)
    ledger.record_opening_balance(n["savings"], "5000.00", START)

    def rule(**kw: Any) -> UUID:
        return recurrence.add_rule(ledger, recurrence.RecurrenceRule(**kw)).id

    n["r_salary"] = rule(
        description="Salário Ana",
        account_id=n["bank"],
        counterpart_id=inc["Salário"],
        amount=Decimal("6200.00"),
        tolerance=Decimal("100.00"),
        day=5,
        start=START,
    )
    n["r_rent"] = rule(
        description="Aluguel",
        account_id=n["bank"],
        counterpart_id=cat["Moradia"],
        amount=Decimal("2100"),
        day=10,
        start=START,
    )
    n["r_stream"] = rule(
        description="Streaming",
        account_id=n["card_account"],
        counterpart_id=cat["Serviços e assinaturas"],
        amount=Decimal("39.90"),
        tolerance=Decimal("0.50"),
        day=12,
        start=START,
    )
    n["r_gym"] = rule(
        description="Academia",
        account_id=n["cash"],
        counterpart_id=cat["Lazer"],
        amount=Decimal("35.00"),
        frequency=recurrence.Frequency.WEEKLY,
        day=1,
        start=START + timedelta(days=rng.randint(0, 6)),
        window_days=2,
    )
    n["r_insurance"] = rule(
        description="Seguro anual",
        account_id=n["bank"],
        counterpart_id=cat["Impostos e taxas"],
        amount=Decimal("1180.00"),
        frequency=recurrence.Frequency.YEARLY,
        day=31,
        start=date(2025, 8, 31),
    )
    n["r_paused"] = rule(
        description="Revista",
        account_id=n["bank"],
        counterpart_id=cat["Educação"],
        amount=Decimal("19.90"),
        day=20,
        start=START,
        paused=True,
    )
    n["r_school"] = rule(
        description="Escola",
        account_id=n["joint"],
        counterpart_id=cat["Educação"],
        amount=Decimal("950.00"),
        day=31,
        start=START,
        end=date(2026, 6, 30),
        skipped=(date(2025, 12, 31), date(2026, 1, 31)),
    )
    n["r_card2"] = rule(
        description="Nuvem",
        account_id=n["card2_account"],
        counterpart_id=cat["Serviços e assinaturas"],
        amount=Decimal("12.90"),
        day=2,
        start=date(2026, 5, 1),
    )

    words = ["Mercado", "Farmácia", "Posto", "Restaurante", "Padaria", "Escola", "Luz", "Água", "Cinema"]
    expense_cats = [cat[k] for k in ("Alimentação", "Transporte", "Saúde", "Lazer", "Casa — reparos", "Dentista")]
    liquid = [n["bank"], n["joint"], n["cash"], n["savings"], n["bruno_bank"]]
    plans: list[UUID] = []
    month = YearMonth.of(START)
    for index in range(MONTHS):
        first = month.first_day()

        def day(d: int, first: date = first) -> date:
            return first + timedelta(days=min(d, 27))

        def safe(fn: Any, *args: Any, **kw: Any) -> Any:
            try:
                return fn(*args, **kw)
            except DomainError:
                return None

        # salary: realized most months (value inside or outside the tolerance), skipped sometimes
        roll = rng.random()
        if roll < 0.75:
            value = _money(rng, 615000, 630000) if rng.random() < 0.8 else "5800.00"
            op = ledger.record_income(n["bank"], inc["Salário"], value, day(rng.randint(3, 7)), "SALARIO EMPRESA")
            if rng.random() < 0.7:
                safe(recurrence.realize, ledger, n["r_salary"], date(month.year, month.month, 5), op.id)
        elif roll < 0.85:
            recurrence.skip(ledger, n["r_salary"], date(month.year, month.month, 5))
        # rent
        if rng.random() < 0.8:
            op = ledger.record_expense(n["bank"], cat["Moradia"], "2100.00", day(rng.randint(8, 12)), "Aluguel")
            if rng.random() < 0.8:
                safe(recurrence.realize, ledger, n["r_rent"], date(month.year, month.month, 10), op.id)
        # streaming on the card, price changes after some months
        price = "39.90" if index < 8 else "44.90"
        op = ledger.record_card_purchase(n["card"], cat["Serviços e assinaturas"], price, day(11), "STREAMING")
        if rng.random() < 0.85:
            safe(recurrence.realize, ledger, n["r_stream"], date(month.year, month.month, 12), op.id)
        # a subscription without a rule (candidate) and merchant-like charges
        if index >= MONTHS - 6:
            ledger.record_card_purchase(n["card"], cat["Serviços e assinaturas"], "21.90", day(8), "SPOTIFY P1A2B3")
        if index >= MONTHS - 5 and seed != 3:
            ledger.record_expense(
                n["bank"], cat["Lazer"], rng.choice(["55.00", "55.00", "58.00"]), day(15), "NETFLIX.COM"
            )
        for _ in range(rng.randint(6, 12)):
            r = rng.random()
            when = day(rng.randint(0, 27))
            desc = f"{rng.choice(words)} {rng.randint(1, 40)}"
            if r < 0.30:
                safe(
                    ledger.record_expense,
                    rng.choice(liquid),
                    rng.choice(expense_cats),
                    _money(rng),
                    when,
                    desc,
                    member_id=rng.choice([None, ana, bruno]),
                )
            elif r < 0.40:
                c1, c2 = rng.sample(expense_cats, 2)
                op = safe(ledger.record_expense, n["bank"], [(c1, _money(rng)), (c2, _money(rng))], None, when, desc)
                if op is not None and rng.random() < 0.6:
                    postings = (
                        op.postings[0].model_copy(update={"member_id": ana}),
                        op.postings[1].model_copy(update={"member_id": bruno}),
                        op.postings[2],
                    )
                    ledger.update_operation(op.model_copy(update={"postings": postings}), "rateio")
            elif r < 0.62:
                safe(
                    ledger.record_card_purchase,
                    rng.choice([n["card"], n["card"], n["card2"]]),
                    rng.choice(expense_cats),
                    _money(rng),
                    when,
                    rng.choice([desc, rng.choice(DESCRIPTIONS[:7])]),
                    member_id=rng.choice([None, None, bruno, ana]),
                )
            elif r < 0.70:
                safe(ledger.record_income, rng.choice(liquid), rng.choice(list(inc.values())), _money(rng), when, desc)
            elif r < 0.80:
                a, b = rng.sample(liquid, 2)
                safe(ledger.record_transfer, a, b, _money(rng), when)
            elif r < 0.85:
                safe(ledger.record_expense, n["joint"], cat["Educação"], _money(rng), when, "Material escolar")
            elif r < 0.90:
                safe(ledger.record_income, n["cash"], inc["Outras receitas"], _money(rng), when, "Venda")
            else:
                safe(ledger.record_expense, n["cash"], cat["Lazer"], "35.00", when, "Academia")
        # card bill payments: on time, late, partial or none
        for card_id, payer in ((n["card"], n["bank"]), (n["card2"], n["bruno_bank"])):
            r = rng.random()
            if r < 0.85:
                bill = cards.bills(ledger, card_id, [month])[0]
                owed = bill.remaining
                if owed > 0:
                    pay_on = bill.cycle.due + timedelta(days=rng.choice([-3, 0, 0, 2, 9]))
                    amount = owed if rng.random() < 0.7 else (owed / 2).quantize(Decimal("0.01"))
                    safe(ledger.record_card_payment, card_id, payer, amount, pay_on)
        # installment plans
        if index in (2, 5, 9, 11):
            policy = cards.CompetencePolicy.SPREAD if index in (5, 11) else cards.CompetencePolicy.PURCHASE
            plan = safe(
                cards.record_installment_purchase,
                ledger,
                n["card"] if index != 9 else n["card2"],
                rng.choice(expense_cats),
                _money(rng, 30_000, 300_000),
                day(rng.randint(0, 27)),
                f"Parcelado {index}",
                rng.randint(2, 10),
                policy,
            )
            if plan is not None:
                plans.append(plan.id)
        month = month.add(1)
    n["plans"] = plans
    end = month.first_day() - timedelta(days=1)
    n["end"] = end

    # duplicates and an outlier near the end
    dup_day = date(2026, 7, 10)
    ledger.record_card_purchase(n["card"], cat["Transporte"], "89.90", dup_day, "POSTO SHELL")
    n["dup"] = ledger.record_card_purchase(
        n["card"], cat["Transporte"], "89.9", dup_day + timedelta(days=1), "Posto Shell"
    ).id
    ledger.record_card_purchase(n["card"], cat["Transporte"], "89.90", dup_day + timedelta(days=8), "POSTO SHELL")
    for k in range(6):
        ledger.record_expense(
            n["bank"], cat["Alimentação"], "100.00", date(2025, 9 + k % 3, 3 + k), f"Mercado base {k}"
        )
    n["outlier"] = ledger.record_expense(
        n["bank"], cat["Alimentação"], "4999.99", date(2026, 7, 2), "Mercado errado"
    ).id
    reviewed = ledger.record_expense(n["bank"], cat["Alimentação"], "100.00", date(2026, 7, 3), "Feira")
    ledger.record_expense(n["bank"], cat["Alimentação"], "100.00", date(2026, 7, 4), "FEIRA")
    anomalies.mark_reviewed(ledger, reviewed.id, anomalies.SuspicionKind.OUTLIER)

    # budgets
    for m in (YearMonth(year=2026, month=k) for k in (3, 4, 5, 6, 7)):
        budget.set_budget(ledger, cat["Alimentação"], m, _money(rng, 50_000, 150_000))
        budget.set_budget(ledger, cat["Transporte"], m, _money(rng, 10_000, 40_000))
        budget.set_budget(ledger, cat["Casa"], m, "300.00")
        if m.month % 2:
            budget.set_budget(ledger, cat["Casa — reparos"], m, "50.00")
            budget.set_budget(ledger, cat["Saúde"], m, "10.00")

    # bank checks
    from opesvault.domain import queries

    bank_now = queries.balance(ledger, n["bank"], date(2026, 6, 30))
    balance_checks.record(ledger, n["bank"], date(2026, 6, 30), bank_now, "extrato")
    balance_checks.record(ledger, n["bank"], date(2026, 5, 31), "1234.56")
    balance_checks.record(ledger, n["card_account"], date(2026, 7, 1), "0.00", "  ")
    balance_checks.record(ledger, n["joint"], date(2026, 4, 30), queries.balance(ledger, n["joint"], date(2026, 4, 30)))

    # loans
    fees_cat = cat["Serviços e assinaturas"]
    plan1 = loans.create_loan(
        ledger,
        loans.LoanPlan(
            name="Carro",
            liability_account_id=n["loan1"],
            payment_account_id=n["bank"],
            interest_category_id=cat["Juros e encargos"],
            fees_category_id=fees_cat,
            principal=Decimal("24000.00"),
            monthly_rate=loans.annual_to_monthly("0.1899"),
            term=36,
            system=loans.AmortizationSystem.PRICE,
            first_due=date(2025, 7, 31),
            fees_per_installment=Decimal("12.50"),
        ),
        loans.Opening.OPENING_BALANCE,
        on=START,
    )
    plan2 = loans.create_loan(
        ledger,
        loans.LoanPlan(
            name="Reforma",
            liability_account_id=n["loan2"],
            payment_account_id=n["joint"],
            interest_category_id=cat["Juros e encargos"],
            principal=Decimal("9000.00"),
            monthly_rate=Decimal("0.0125"),
            term=18,
            system=loans.AmortizationSystem.SAC,
            first_due=date(2025, 10, 15),
        ),
        loans.Opening.DEPOSIT,
        on=date(2025, 9, 15),
        deposit_account_id=n["joint"],
    )
    n["loan_plan1"], n["loan_plan2"] = plan1.id, plan2.id
    paid1 = rng.randint(6, 10)
    for number in range(1, paid1 + 1):
        due_on = loans.due_date(plan1.first_due, number)
        extra = None if number != 3 else "900.00"
        loans.pay_installment(ledger, plan1.id, number, due_on + timedelta(days=2 if number == 3 else 0), extra)
    loans.prepay(ledger, plan1.id, "2000.00", date(2026, 4, 2), loans.PrepaymentMode.REDUCE_TERM)
    loans.prepay(ledger, plan2.id, "500.00", date(2025, 9, 20), loans.PrepaymentMode.REDUCE_PAYMENT)
    for number in range(1, rng.randint(3, 6)):
        loans.pay_installment(ledger, plan2.id, number, loans.due_date(plan2.first_due, number))
    cancelled = loans.pay_installment(ledger, plan2.id, 6, date(2026, 3, 15))
    ledger.cancel_operation(cancelled.id, "duplicado")

    # deductibles
    deductibles.mark(ledger, cat["Saúde"], deductibles.DeductibleKind.HEALTH)
    deductibles.mark(ledger, cat["Educação"], deductibles.DeductibleKind.EDUCATION)
    deductibles.mark(ledger, cat["Dentista"], deductibles.DeductibleKind.OTHER)
    deductibles.mark(ledger, cat["Dentista"], deductibles.DeductibleKind.HEALTH)
    deductibles.mark(ledger, cat["Lazer"], deductibles.DeductibleKind.DONATION)
    deductibles.mark(ledger, cat["Lazer"], None)

    # reimbursements and settlements
    health_ops = [
        o
        for o in ledger.active_operations()
        if any(p.account_id in (cat["Saúde"], cat["Dentista"]) and p.amount > 0 for p in o.postings)
    ]
    for k, op in enumerate(health_ops[:4]):
        cats_total = sum(
            (
                p.amount
                for p in op.postings
                if p.amount > 0 and ledger.account(p.account_id).type is AccountType.EXPENSE
            ),
            Decimal(0),
        )
        expected = (cats_total * Decimal("0.8")).quantize(Decimal("0.01"))
        if expected <= 0:
            continue
        item = sharing.request(ledger, op.id, ["Plano", "Empresa"][k % 2], expected, op.occurred_on)
        if k == 0:
            sharing.receive(ledger, item.id, n["bank"], expected, date(2026, 7, 1))
        elif k == 1:
            sharing.receive(ledger, item.id, n["bank"], (expected / 3).quantize(Decimal("0.01")), date(2026, 6, 1))
        elif k == 2:
            sharing.deny(ledger, item.id, "fora da cobertura")
    sharing.settle(ledger, bruno, ana, "150.00", date(2026, 2, 1), "pix")
    sharing.settle(ledger, ana, bruno, "20.00", date(2026, 5, 1))

    # tags
    ops = [o for o in ledger.active_operations() if o.kind.value != "opening_balance"]
    for op in rng.sample(ops, 12):
        tags.add_tag(ledger, [op.id], rng.choice(["Viagem 2026", "viagem 2026", "Reforma", "Obra  da casa"]))
    if plans:
        tags.add_tag(ledger, [ledger.entities("installment_plan")[plans[0]].operation_ids[0]], "Parcelados")

    # merchants
    merchants.name_merchant(ledger, "IFD*IFOOD.COM AGENCIA", "iFood")
    merchants.name_merchant(ledger, "PADARIA REAL LTDA BR", "Padaria Real", "modelo:x prompt:1")
    merchants.name_merchant(ledger, "PADARIA REAL LTDA BR", "Padaria  Real do Centro")

    # goals, saved filters and settings
    goals.add_goal(
        ledger,
        goals.Goal(
            name="Reserva",
            kind=goals.GoalKind.ACCOUNTS,
            target=Decimal("20000.00"),
            target_date=date(2027, 6, 30),
            account_ids=(n["savings"], n["invest"]),
            created_on=date(2025, 6, 1),
        ),
    )
    goals.add_goal(
        ledger,
        goals.Goal(name="patrimônio", kind=goals.GoalKind.NET_WORTH, target=Decimal("1000.00"), created_on=START),
    )
    old = goals.add_goal(
        ledger,
        goals.Goal(name="Antiga", kind=goals.GoalKind.NET_WORTH, target=Decimal("50000.00"), created_on=START),
    )
    goals.update_goal(ledger, old.model_copy(update={"archived": True}), "concluída")
    saved_filters.save_filter(
        ledger, saved_filters.SavedFilter(name="Cartão da Ana", period="this_month", account_id=n["card_account"])
    )
    saved_filters.save_filter(ledger, saved_filters.SavedFilter(name="aluguel", text="Aluguel", tag="Casa"))
    settings.update_settings(ledger, ai_enabled=True, backup_keep=25)

    # closing
    periods.close_month(ledger, YearMonth.of(START), "golden")
    periods.close_month(ledger, YearMonth.of(START).add(1), "golden")
    periods.reopen_month(ledger, YearMonth.of(START).add(1), "ajuste tardio")
    return ledger, n


# ── JSON helpers ─────────────────────────────────────────


def anon(value: Any, known: set[str], seen: dict[str, str]) -> Any:
    """Unknown ids (values and keys) become "new:<n>" (keys visited in sorted order), instants a placeholder.

    A set of ids ({"$ids": [...]}) is sorted after anonymizing, so random new ids do not move it.
    """
    if isinstance(value, dict) and set(value) == {"$ids"}:
        return sorted(anon(v, known, seen) for v in sorted(value["$ids"]))
    if isinstance(value, dict):
        return {
            anon(k, known, seen): (
                "<instant>" if k in INSTANT_KEYS and isinstance(value[k], str) else anon(value[k], known, seen)
            )
            for k in sorted(value)
        }
    if isinstance(value, list):
        return [anon(v, known, seen) for v in value]
    if isinstance(value, str) and UUID_RE.match(value) and value not in known:
        if value not in seen:
            seen[value] = f"new:{len(seen)}"
        return seen[value]
    return value


def ids(values: Any) -> dict[str, list[str]]:
    """A set of ids, sorted once anonymized."""
    return {"$ids": sorted(str(v) for v in values)}


def month_list(first: YearMonth, count: int) -> list[YearMonth]:
    return [first.add(i) for i in range(count)]


def _sorted_balances(found: list[sharing.Balance]) -> list[Any]:
    rows = [j(b) for b in found]
    return sorted(rows, key=lambda b: (-Decimal(b["amount"]["$dec"]), b["debtor_id"], b["creditor_id"]))


def _tag_summary(s: tags.TagSummary) -> dict[str, Any]:
    return {
        "tag": s.tag,
        "expense": j(s.expense),
        "income": j(s.income),
        "by_category": j(dict(s.by_category)),
        "first": j(s.first),
        "last": j(s.last),
        "operations": ids(o.id for o in s.operations),
        "dates": [j(o.occurred_on or o.cash_date) for o in s.operations],
    }


def _progress(ledger: Ledger, goal: goals.Goal, today: date) -> dict[str, Any]:
    """A slow pace can put the reach month past year 2999: YearMonth then raises (a ValidationError)."""
    try:
        p = goals.progress(ledger, goal, today)
    except ValidationError:
        return {"error": "month out of range"}
    return {**j(p), "reached": p.reached}


def _bill(b: cards.Bill) -> dict[str, Any]:
    out = j(b)
    out["total"] = j(b.total)
    out["remaining"] = j(b.remaining)
    out["status"] = [b.status(t).value for t in TODAYS]
    out["month"] = str(b.cycle.month)
    return out


def queries_of(ledger: Ledger, n: dict[str, Any]) -> dict[str, Any]:
    """Every public read of the planning modules; mirrored by queriesOf() in planning.golden.test.ts."""
    from opesvault.domain import queries

    q: dict[str, Any] = {}
    first = YearMonth.of(START)
    months = month_list(first.add(-1), MONTHS + 3)
    card = ledger.cards[n["card"]]
    # recurrence
    rules_ = recurrence.rules(ledger)
    q["occurrences"] = {
        str(rid): [j(x) for x in recurrence.occurrences(r, START, date(2026, 9, 30))] for rid, r in rules_.items()
    }
    q["forecasts"] = [
        j(recurrence.forecasts(ledger, a, b, t))
        for a, b, t in (
            (START, n["end"], TODAYS[0]),
            (date(2026, 3, 1), date(2026, 8, 31), TODAYS[1]),
            (date(2026, 7, 1), date(2026, 7, 31), TODAYS[2]),
        )
    ]
    q["candidates"] = [
        [str(o.id) for o in recurrence.candidates(ledger, f)]
        for f in recurrence.forecasts(ledger, START, n["end"], TODAYS[1])
        if f.status in (recurrence.ForecastStatus.PENDING, recurrence.ForecastStatus.LATE)
    ]
    q["auto_suggestions"] = [
        [str(f.rule_id), j(f.due_on), j(f.amount), str(o.id)]
        for f, o in recurrence.auto_suggestions(ledger, START, n["end"])
    ]
    # cards
    q["cycle_for"] = [
        j(cards.cycle_for(card, START + timedelta(days=k * 9)))
        | {"month": str(cards.cycle_for(card, START + timedelta(days=k * 9)).month)}
        for k in range(50)
    ]
    q["cycle_by_due_month"] = [j(cards.cycle_by_due_month(card, m)) for m in months]
    q["bills"] = {name: [_bill(b) for b in cards.bills(ledger, n[name], months)] for name in ("card", "card2")}
    q["schedules"] = {str(p.id): j(cards.schedule(ledger, p)) for p in cards.plans(ledger).values()}
    matches = []
    for p in cards.plans(ledger).values():
        for number, desc in (
            (p.first_number, p.description.lower()),
            (2, f"{p.description} PARCELA 2/{p.count}"),
            (p.count + 1, p.description),
        ):
            amount = p.amounts[min(number - 1, len(p.amounts) - 1)]
            matches.append(j(cards.find_plan_for_installment(ledger, p.card_id, desc, number, p.count, amount)))
        matches.append(j(cards.find_plan_for_installment(ledger, p.card_id, p.description, 1, p.count, amount + 1)))
    q["find_plan"] = matches
    # periods
    q["periods"] = [
        {
            "month": str(m),
            "closed": periods.is_closed(ledger, m),
            "pending": periods.pending_items(ledger, m),
            "summary": j(periods.summarize(ledger, m)),
            "unchanged": periods.closed_figures_unchanged(ledger, m),
        }
        for m in months
    ]
    q["months_of"] = {str(o.id): sorted(str(m) for m in periods.months_of(o)) for o in ledger.operations.values()}
    # budget
    q["budget"] = [
        {**j(s), "over": [str(r.category_id) for r in s.over], "near": [str(r.category_id) for r in s.near]}
        for s in (budget.status(ledger, m) for m in months)
    ]
    q["budget_lines"] = {str(m): ids(x.category_id for x in budget.lines_of(ledger, m)) for m in months}
    # balance checks
    q["checks"] = [
        {**j(r), "difference": j(r.difference), "matches": r.matches} for r in balance_checks.results(ledger)
    ]
    q["checks_bank"] = [str(r.check.id) for r in balance_checks.results(ledger, n["bank"])]
    q["checks_latest"] = {str(k): str(v.check.id) for k, v in balance_checks.latest(ledger).items()}
    q["checks_divergent"] = [str(r.check.id) for r in balance_checks.divergent(ledger)]
    # loans
    q["loans"] = {}
    for pid in loans.plans(ledger):
        sims = []
        for amount, mode in (("1000.00", "reduce_term"), ("1000.00", "reduce_payment"), ("0.01", "reduce_term")):
            s = loans.simulate_prepayment(ledger, pid, amount, loans.PrepaymentMode(mode))
            sims.append({**j(s), "interest_saved": j(s.interest_saved)})
        statuses = [j(loans.status(ledger, pid, t)) for t in TODAYS]
        items = loans.plan_schedule(ledger, pid)
        q["loans"][str(pid)] = {
            "schedule": j(items),
            "plain_schedule": j(loans.schedule(loans.plans(ledger)[pid])),
            "status": statuses,
            "simulations": sims,
            "paid": sorted(loans.paid_numbers(ledger, pid)),
            "states": [loans.state_of(ledger, pid, i, TODAYS[1]).value for i in items],
        }
    q["loans_upcoming"] = [[str(p.id), j(i)] for p, i in loans.upcoming(ledger, date(2026, 1, 1), date(2026, 12, 31))]
    q["loan_operation_ids"] = ids(loans.loan_operation_ids(ledger))
    # deductibles
    q["deductible_kinds"] = {
        str(a.id): j(deductibles.kind_of(ledger, a.id))
        for a in ledger.accounts.values()
        if a.type is AccountType.EXPENSE
    }
    q["deductibles"] = {
        str(year): [
            {
                "kind": g.kind.value,
                "member_id": j(g.member_id),
                "total": j(g.total),
                "lines": [[str(x.operation.id), str(x.category_id), j(x.member_id), j(x.amount)] for x in g.lines],
            }
            for g in deductibles.annual(ledger, year)
        ]
        for year in (2025, 2026, 2027)
    }
    # sharing
    q["reimbursements"] = [
        {"id": str(r.id), "state": sharing.state(ledger, r).value, "received": j(sharing.received(ledger, r))}
        for r in sharing.reimbursements(ledger).values()
    ]
    q["open_reimbursements"] = [str(r.id) for r in sharing.open_items(ledger)]
    q["payers"] = {str(o.id): j(sharing.payer_of(ledger, o)) for o in ledger.operations.values()}
    q["shares"] = j(sharing.shares(ledger))
    q["shares_window"] = j(sharing.shares(ledger, date(2026, 1, 1), date(2026, 3, 31)))
    q["balances"] = _sorted_balances(sharing.balances(ledger))
    q["balances_window"] = _sorted_balances(sharing.balances(ledger, date(2026, 2, 1), date(2026, 5, 31)))
    # comparisons and indicators
    q["first_activity"] = j(comparisons.first_activity(ledger))
    q["comparisons"] = {
        str(m): {
            "categories": [
                {**j(c), "delta": j(c.delta), "change": j(c.change)} for c in comparisons.category_comparison(ledger, m)
            ],
            "totals": [
                {**j(c), "delta": j(c.delta), "change": j(c.change)}
                for c in comparisons.totals_comparison(ledger, m, 6)
            ],
        }
        for m in months
    }
    q["indicators"] = {str(m): j(indicators.indicators(ledger, m)) for m in months}
    # goals
    q["goals"] = [str(g.id) for g in goals.goals(ledger)]
    q["progress"] = [_progress(ledger, g, t) for g in goals.goals(ledger) for t in TODAYS]
    # tags
    q["all_tags"] = tags.all_tags(ledger)
    q["tags_of"] = {str(o): list(tags.tags_of(ledger, o)) for o in ledger.operations}
    q["operations_with"] = {t: ids(tags.operations_with(ledger, t)) for t in [*tags.all_tags(ledger), "VIAGEM 2026"]}
    q["tag_summaries"] = [_tag_summary(s) for s in tags.summaries(ledger)]
    # merchants
    q["clean"] = [[d, merchants.clean(d), merchants.key_of(d), merchants.merchant_of(ledger, d)] for d in DESCRIPTIONS]
    q["merchant_totals"] = [
        j(merchants.totals(ledger, a, b)) for a, b in ((START, n["end"]), (date(2026, 3, 1), date(2026, 3, 31)))
    ]
    # anomalies
    q["suspicions"] = [j(anomalies.suspicions(ledger, t)) for t in TODAYS]
    q["of_operation"] = [j(anomalies.of_operation(ledger, n[k], TODAYS[1])) for k in ("dup", "outlier")]
    # subscriptions
    q["commitments"] = [
        {**j(c), "rule": str(c.rule.id), "price_changed": c.price_changed} for c in subscriptions.commitments(ledger)
    ]
    q["yearly_total"] = j(subscriptions.yearly_total(ledger))
    q["subscription_candidates"] = [j(subscriptions.candidates(ledger, t)) for t in TODAYS]
    # projection
    q["projection_events"] = [j(projection.events(ledger, t, t + timedelta(days=60))) for t in TODAYS]
    q["projections"] = []
    for t in TODAYS:
        for p in projection.project(ledger, t):
            q["projections"].append(
                {
                    **j(p),
                    "lowest": j(p.lowest),
                    "first_negative": j(p.first_negative),
                    "balance_on": j(p.balance_on(t + timedelta(days=20))),
                    "daily": j(p.daily(t + timedelta(days=10))),
                }
            )
    q["projection_chosen"] = j(projection.project(ledger, TODAYS[1], 30, [n["card_account"], n["joint"]]))
    q["negative_ahead"] = [[str(p.account_id) for p in projection.negative_ahead(ledger, t, 45)] for t in TODAYS]
    # saved filters and settings
    q["saved_filters"] = j(saved_filters.saved(ledger))
    q["settings"] = j(settings.get_settings(ledger))
    q["balance_bank"] = j(queries.balance(ledger, n["bank"]))
    return q


def pure_cases() -> dict[str, Any]:
    """Functions of plain values: rates, due dates, schedules of synthetic plans."""
    a, b, c = (UUID(int=k) for k in (1, 2, 3))
    out: dict[str, Any] = {}
    out["annual_to_monthly"] = []
    for rate in ("0", "0.126825030", "0.1899", "0.0001", "1", "2.5", "0.5", "-0.1", "12"):
        try:
            out["annual_to_monthly"].append({"in": rate, "ok": str(loans.annual_to_monthly(rate))})
        except DomainError as exc:
            out["annual_to_monthly"].append({"in": rate, "error": str(exc)})
    out["due_date"] = [
        [str(d0), k, j(loans.due_date(d0, k))]
        for d0 in (date(2026, 1, 31), date(2026, 2, 28), date(2024, 2, 29), date(2026, 8, 15))
        for k in (1, 2, 3, 13, 25)
    ]
    plans = []
    for system in ("price", "sac"):
        for principal, rate, term, fees in (
            ("1000.00", "0.01", 12, "0"),
            ("100.00", "0", 3, "0"),
            ("50000.00", "0.0099", 360, "25.00"),
            ("1.00", "0.05", 7, "0"),
            ("777.77", "0.0333333333", 5, "1.10"),
        ):
            plans.append(
                {
                    "liability_account_id": str(a),
                    "payment_account_id": str(b),
                    "interest_category_id": str(c),
                    "name": "Sintético",
                    "principal": principal,
                    "monthly_rate": rate,
                    "term": term,
                    "system": system,
                    "first_due": "2026-01-31",
                    "fees_per_installment": fees,
                }
            )
    extras = [
        [],
        [[0, "100.00", "reduce_term"]],
        [[2, "300.00", "reduce_term"], [2, "1.00", "reduce_payment"]],
        [[1, "250.00", "reduce_payment"], [5, "99999.00", "reduce_term"]],
    ]
    out["schedules"] = []
    for payload in plans:
        plan = loans.LoanPlan.model_validate(payload)
        payload["id"] = str(plan.id)
        for extra in extras:
            parsed = [(k, Decimal(v), loans.PrepaymentMode(m)) for k, v, m in extra]
            try:
                result: Any = {"ok": j(loans.schedule(plan, parsed))}
            except DomainError as exc:
                result = {"error": str(exc)}
            out["schedules"].append({"plan": plan.model_dump(mode="json"), "extra": extra, "result": result})
    # a contract whose installment does not cover the interest
    bad = loans.LoanPlan.model_validate({**plans[0], "monthly_rate": "0.5", "term": 600})
    try:
        loans.schedule(bad)
        out["bad"] = {"plan": bad.model_dump(mode="json"), "ok": True}
    except DomainError as exc:
        out["bad"] = {"plan": bad.model_dump(mode="json"), "error": str(exc)}
    return out


# ── commands ─────────────────────────────────────────────


def commands(ledger: Ledger, n: dict[str, Any]) -> list[dict[str, Any]]:
    """Commands with ids taken from the records only."""
    s = str
    cat, inc = n["cat"], n["inc"]
    first_plan = next(iter(cards.plans(ledger).values()), None)
    expense_op = next(
        o.id
        for o in ledger.operations.values()
        if o.active and o.kind.value == "expense" and o.occurred_on and o.occurred_on > date(2026, 3, 1)
    )
    closed = YearMonth.of(START)
    loan_pid = n["loan_plan1"]
    paid = loans.paid_numbers(ledger, loan_pid)
    nxt = max(paid) + 1
    reimb = next(iter(sharing.reimbursements(ledger)), None)
    forecast = next(
        f
        for f in recurrence.forecasts(ledger, date(2026, 1, 1), n["end"], TODAYS[1])
        if f.status in (recurrence.ForecastStatus.PENDING, recurrence.ForecastStatus.LATE)
    )
    goal = goals.goals(ledger)[0]
    filt = saved_filters.saved(ledger)[0]
    alias = next(iter(merchants.aliases(ledger)))
    check = next(iter(balance_checks.checks(ledger)))
    return [
        {"cmd": "expense", "args": [s(n["bank"]), s(cat["Alimentação"]), "10.00", str(closed.first_day()), "fechado"]},
        {"cmd": "update_desc", "args": [s(next(o.id for o in ledger.operations.values() if o.competence == closed))]},
        {
            "cmd": "cancel",
            "args": [s(next(o.id for o in ledger.operations.values() if o.active and o.competence == closed))],
        },
        {"cmd": "close", "args": [str(closed), None]},
        {"cmd": "reopen", "args": [str(closed.add(5)), "x"]},
        {"cmd": "reopen", "args": [str(closed), " "]},
        {"cmd": "reopen", "args": [str(closed), "nota atrasada"]},
        {
            "cmd": "expense",
            "args": [s(n["bank"]), s(cat["Alimentação"]), "10.00", str(closed.first_day()), "agora pode"],
        },
        {"cmd": "close", "args": [str(closed), None]},
        {"cmd": "close", "args": [str(closed), "de novo"]},
        {"cmd": "close", "args": [str(closed.add(13)), "fim"]},
        {"cmd": "realize", "args": [s(forecast.rule_id), str(forecast.due_on), s(expense_op)]},
        {"cmd": "realize", "args": [s(forecast.rule_id), str(forecast.due_on), s(expense_op)]},
        {"cmd": "skip", "args": [s(n["r_gym"]), "2026-07-20"]},
        {"cmd": "add_rule", "args": [s(n["bank"]), s(cat["Lazer"]), "-1", "2026-01-01", None]},
        {"cmd": "add_rule", "args": [s(n["bank"]), s(cat["Lazer"]), "10", "2026-01-01", "2025-01-01"]},
        {"cmd": "add_rule", "args": [s(n["bank"]), "00000000-0000-4000-8000-000000000000", "10", "2026-01-01", None]},
        {"cmd": "add_rule", "args": [s(n["bank"]), s(cat["Lazer"]), "10", "2026-01-01", None]},
        {"cmd": "set_budget", "args": [s(cat["Lazer"]), "2026-08", "300.00"]},
        {"cmd": "set_budget", "args": [s(cat["Lazer"]), "2026-08", "300.0"]},
        {"cmd": "set_budget", "args": [s(cat["Lazer"]), "2026-08", "320.00"]},
        {"cmd": "set_budget", "args": [s(inc["Salário"]), "2026-08", "1.00"]},
        {"cmd": "set_budget", "args": [s(cat["Lazer"]), "2026-08", "0.001"]},
        {"cmd": "set_budget", "args": [s(cat["Lazer"]), "2026-08", "-5"]},
        {"cmd": "copy_budget", "args": ["2026-07", "2026-08", False]},
        {"cmd": "copy_budget", "args": ["2026-07", "2026-08", True]},
        {"cmd": "remove_budget", "args": [s(cat["Lazer"]), "2026-08"]},
        {"cmd": "remove_budget", "args": [s(cat["Lazer"]), "2026-08"]},
        {"cmd": "check", "args": [s(n["savings"]), "2026-07-31", "5000.00", " conferido "]},
        {"cmd": "check", "args": [s(cat["Lazer"]), "2026-07-31", "1.00", None]},
        {"cmd": "check", "args": [s(n["savings"]), "2026-07-31", "1.001", None]},
        {"cmd": "remove_check", "args": [s(check)]},
        {"cmd": "pay_installment", "args": [s(loan_pid), nxt - 1, "2026-08-01", None]},
        {"cmd": "pay_installment", "args": [s(loan_pid), nxt, "2026-08-01", "1.00"]},
        {"cmd": "pay_installment", "args": [s(loan_pid), 999, "2026-08-01", None]},
        {"cmd": "pay_installment", "args": [s(loan_pid), nxt, "2026-08-01", None]},
        {"cmd": "pay_installment", "args": [s(loan_pid), nxt + 1, "2026-08-02", "2000.00"]},
        {"cmd": "prepay", "args": [s(loan_pid), "0", "2026-08-03", "reduce_term"]},
        {"cmd": "prepay", "args": [s(loan_pid), "99999999.00", "2026-08-03", "reduce_term"]},
        {"cmd": "prepay", "args": [s(loan_pid), "777.77", "2026-08-03", "reduce_payment"]},
        {"cmd": "update_loan", "args": [s(loan_pid), "0.02"]},
        {"cmd": "update_loan", "args": [s(loan_pid), "0.9"]},
        {"cmd": "mark", "args": [s(cat["Saúde"]), "education"]},
        {"cmd": "mark", "args": [s(cat["Saúde"]), "education"]},
        {"cmd": "mark", "args": [s(n["bank"]), "health"]},
        {"cmd": "mark", "args": [s(cat["Educação"]), None]},
        {"cmd": "request", "args": [s(expense_op), "Plano", "1.00"]},
        {"cmd": "request", "args": [s(expense_op), "Plano", "1.00"]},
        {"cmd": "request", "args": [s(expense_op), "  ", "1.00"]},
        {"cmd": "request", "args": [s(n["bank"]), "Plano", "1.00"]},
        {"cmd": "receive", "args": [s(reimb) if reimb else s(n["bank"]), s(n["bank"]), "0.50", "2026-08-01"]},
        {"cmd": "receive", "args": [s(reimb) if reimb else s(n["bank"]), s(cat["Lazer"]), "0.50", "2026-08-01"]},
        {"cmd": "deny", "args": [s(reimb) if reimb else s(n["bank"]), " "]},
        {"cmd": "deny", "args": [s(reimb) if reimb else s(n["bank"]), "negado"]},
        {"cmd": "settle", "args": [s(n["ana"]), s(n["bruno"]), "33.33", "2026-07-07", "acerto"]},
        {"cmd": "settle", "args": [s(n["ana"]), s(n["ana"]), "1.00", "2026-07-07", None]},
        {"cmd": "settle", "args": [s(n["ana"]), s(n["bruno"]), "1.001", "2026-07-07", None]},
        {"cmd": "add_tag", "args": [[s(expense_op), s(n["dup"])], " Viagem   2026 "]},
        {"cmd": "add_tag", "args": [[s(expense_op)], "x" * 41]},
        {"cmd": "set_tags", "args": [s(n["outlier"]), ["Casa", "casa", "Obra"]]},
        {"cmd": "rename_tag", "args": ["viagem 2026", "Férias"]},
        {"cmd": "remove_tag", "args": [[s(expense_op)], "FÉRIAS"]},
        {"cmd": "set_tags", "args": [s(first_plan.operation_ids[-1]) if first_plan else s(expense_op), ["Parcela"]]},
        {"cmd": "name_merchant", "args": ["NETFLIX.COM", "Netflix"]},
        {"cmd": "name_merchant", "args": ["NETFLIX.COM", "Netflix"]},
        {"cmd": "name_merchant", "args": ["x", " "]},
        {"cmd": "remove_alias", "args": [s(alias)]},
        {"cmd": "mark_reviewed", "args": [s(n["dup"]), None]},
        {"cmd": "mark_reviewed", "args": [s(n["outlier"]), "outlier"]},
        {"cmd": "update_goal", "args": [s(goal.id), "999.99"]},
        {"cmd": "update_goal", "args": [s(goal.id), "0"]},
        {"cmd": "save_filter", "args": [" Meu   filtro ", "last_3"]},
        {"cmd": "save_filter", "args": ["MEU FILTRO", "all"]},
        {"cmd": "save_filter", "args": ["Outro", "custom"]},
        {"cmd": "save_filter", "args": ["   ", "all"]},
        {"cmd": "delete_filter", "args": [s(filt.id)]},
        {"cmd": "settings", "args": [{"save_reminder_minutes": 45}]},
        {
            "cmd": "installments",
            "args": [s(n["card"]), s(cat["Lazer"]), "1000.00", "2026-08-02", "TV nova", 7, "purchase"],
        },
        {"cmd": "installments", "args": [s(n["card2"]), s(cat["Lazer"]), "99.99", "2026-08-02", "Curso", 4, "spread"]},
        {"cmd": "installments", "args": [s(n["card"]), s(cat["Lazer"]), "10.00", "2026-08-02", "x", 1, "purchase"]},
        {
            "cmd": "installments",
            "args": [s(n["card"]), s(cat["Lazer"]), "10.00", str(closed.first_day()), "x", 2, "spread"],
        },
    ]


def _ym(text: str) -> YearMonth:
    return YearMonth.parse(text)


def run(ledger: Ledger, cmd: str, a: list[Any]) -> Any:
    u = UUID
    match cmd:
        case "expense":
            return ledger.record_expense(u(a[0]), u(a[1]), a[2], _d(a[3]), a[4])
        case "update_desc":
            op = ledger.operations[u(a[0])]
            return ledger.update_operation(op.model_copy(update={"description": op.description + " (nota)"}), "nota")
        case "cancel":
            return ledger.cancel_operation(u(a[0]), "erro")
        case "close":
            return periods.close_month(ledger, _ym(a[0]), a[1])
        case "reopen":
            return periods.reopen_month(ledger, _ym(a[0]), a[1])
        case "realize":
            return recurrence.realize(ledger, u(a[0]), _d(a[1]), u(a[2]))
        case "skip":
            return recurrence.skip(ledger, u(a[0]), _d(a[1]))
        case "add_rule":
            rule = recurrence.RecurrenceRule(
                description="Nova",
                account_id=u(a[0]),
                counterpart_id=u(a[1]),
                amount=Decimal(a[2]),
                day=15,
                start=_d(a[3]),
                end=_d(a[4]) if a[4] else None,
            )
            return recurrence.add_rule(ledger, rule)
        case "set_budget":
            return budget.set_budget(ledger, u(a[0]), _ym(a[1]), a[2])
        case "copy_budget":
            return budget.copy_month(ledger, _ym(a[0]), _ym(a[1]), overwrite=a[2])
        case "remove_budget":
            return budget.remove_budget(ledger, u(a[0]), _ym(a[1]))
        case "check":
            return balance_checks.record(ledger, u(a[0]), _d(a[1]), a[2], a[3])
        case "remove_check":
            return balance_checks.remove(ledger, u(a[0]))
        case "pay_installment":
            return loans.pay_installment(ledger, u(a[0]), a[1], _d(a[2]), a[3])
        case "prepay":
            return loans.prepay(ledger, u(a[0]), a[1], _d(a[2]), loans.PrepaymentMode(a[3]))
        case "update_loan":
            plan = loans.plans(ledger)[u(a[0])]
            return loans.update_loan(ledger, plan.model_copy(update={"monthly_rate": Decimal(a[1])}), "renegociado")
        case "mark":
            return deductibles.mark(ledger, u(a[0]), deductibles.DeductibleKind(a[1]) if a[1] else None)
        case "request":
            return sharing.request(ledger, u(a[0]), a[1], a[2])
        case "receive":
            return sharing.receive(ledger, u(a[0]), u(a[1]), a[2], _d(a[3]))
        case "deny":
            return sharing.deny(ledger, u(a[0]), a[1])
        case "settle":
            return sharing.settle(ledger, u(a[0]), u(a[1]), a[2], _d(a[3]), a[4])
        case "add_tag":
            return tags.add_tag(ledger, [u(x) for x in a[0]], a[1])
        case "set_tags":
            return tags.set_tags(ledger, u(a[0]), a[1])
        case "rename_tag":
            return tags.rename_tag(ledger, a[0], a[1])
        case "remove_tag":
            return tags.remove_tag(ledger, [u(x) for x in a[0]], a[1])
        case "name_merchant":
            return merchants.name_merchant(ledger, a[0], a[1])
        case "remove_alias":
            return merchants.remove_alias(ledger, u(a[0]))
        case "mark_reviewed":
            return anomalies.mark_reviewed(ledger, u(a[0]), anomalies.SuspicionKind(a[1]) if a[1] else None)
        case "update_goal":
            goal = ledger.entities("goal")[u(a[0])]
            return goals.update_goal(ledger, goal.model_copy(update={"target": Decimal(a[1])}), "nova meta")
        case "save_filter":
            return saved_filters.save_filter(ledger, saved_filters.SavedFilter(name=a[0], period=a[1]))
        case "delete_filter":
            return saved_filters.delete_filter(ledger, u(a[0]))
        case "settings":
            return settings.update_settings(ledger, **a[0])
        case "installments":
            return cards.record_installment_purchase(
                ledger, u(a[0]), u(a[1]), a[2], _d(a[3]), a[4], a[5], cards.CompetencePolicy(a[6])
            )
    raise AssertionError(cmd)


def generate() -> dict[str, Any]:
    scenarios = []
    for seed in SEEDS:
        built, names = build(seed)
        rows = built.to_records()
        records = [{"id": str(i), "kind": k, "payload": p} for i, k, p in rows]
        known = {r["id"] for r in records} | {str(x) for _, _, p in rows for x in _uuids(p)}
        ledger = Ledger.from_records(rows)
        ctx = {
            k: (str(v) if isinstance(v, (UUID, date)) else v)
            for k, v in names.items()
            if not isinstance(v, (dict, list))
        }
        queries_before = anon(queries_of(ledger, names), known, {})
        cmds = commands(ledger, names)
        results = []
        seen: dict[str, str] = {}
        for c in cmds:
            try:
                results.append({"ok": anon(j(run(ledger, c["cmd"], c["args"])), known, seen)})
            except DomainError as exc:
                results.append({"error": str(exc)})
        queries_after = anon(queries_of(ledger, names), known, seen)
        scenarios.append(
            {
                "seed": seed,
                "records": records,
                "names": ctx,
                "queries": queries_before,
                "commands": cmds,
                "results": results,
                "after": queries_after,
                "row_counts": ledger.row_counts(),
            }
        )
    return {"todays": [str(t) for t in TODAYS], "start": str(START), "pure": pure_cases(), "scenarios": scenarios}


def _uuids(value: Any) -> list[str]:
    if isinstance(value, dict):
        return [x for v in value.values() for x in _uuids(v)]
    if isinstance(value, list):
        return [x for v in value for x in _uuids(v)]
    if isinstance(value, str) and UUID_RE.match(value):
        return [value]
    return []
