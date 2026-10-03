"""Projected balance per account: today's balance plus what is already known to come
(docs/09 §1.3 E).

Known future movements: pending recurrences, card bills (charges and installments
already registered, plus card recurrences of each cycle) paid from the card's payment
account, and loan installments. A projection is a forecast: it never changes balances,
and what is not registered (a purchase not yet made) is not guessed. Late items that may
still happen are placed today.
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from uuid import UUID

from opesvault.domain import queries
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountType, YearMonth
from opesvault.domain.money import ZERO

HORIZON_DAYS = 60
ALERT_DAYS = 30  # warn when an account goes negative within this many days
LOOKBACK_DAYS = 31  # late items older than this are history, not projection


@dataclass(frozen=True)
class ProjectedEvent:
    on: date
    account_id: UUID
    amount: Decimal  # effect on the account's balance (natural sign)
    description: str
    source: str  # "recorrência", "fatura", "financiamento"
    late: bool = False


@dataclass
class AccountProjection:
    account_id: UUID
    start: date
    start_balance: Decimal
    events: list[ProjectedEvent] = field(default_factory=list)

    def balance_on(self, day: date) -> Decimal:
        return self.start_balance + sum((e.amount for e in self.events if e.on <= day), ZERO)

    def daily(self, end: date) -> list[tuple[date, Decimal]]:
        out, running, index = [], self.start_balance, 0
        events = sorted(self.events, key=lambda e: e.on)
        day = self.start
        while day <= end:
            while index < len(events) and events[index].on <= day:
                running += events[index].amount
                index += 1
            out.append((day, running))
            day += timedelta(days=1)
        return out

    @property
    def lowest(self) -> tuple[date, Decimal]:
        """The lowest balance in the horizon and its first day."""
        best = (self.start, self.start_balance)
        running = self.start_balance
        for event in sorted(self.events, key=lambda e: e.on):
            running += event.amount
            if running < best[1]:
                best = (event.on, running)
        return best

    @property
    def first_negative(self) -> date | None:
        if self.start_balance < 0:
            return self.start
        running = self.start_balance
        for event in sorted(self.events, key=lambda e: e.on):
            running += event.amount
            if running < 0:
                return event.on
        return None


def events(ledger: Ledger, today: date, end: date) -> tuple[list[ProjectedEvent], list[str]]:
    """Known movements between today and `end` on liquid accounts, and notes on what was left out."""
    from opesvault.domain.cards import bills, cycle_for
    from opesvault.domain.loans import upcoming
    from opesvault.domain.recurrence import ForecastStatus, forecasts, rules

    since = today - timedelta(days=LOOKBACK_DAYS)
    out: list[ProjectedEvent] = []
    notes: list[str] = []
    card_by_liability = {c.liability_account_id: c for c in ledger.cards.values()}
    # Card recurrences (streaming on the card) enter the bill of their cycle.
    card_extra: dict[tuple[UUID, YearMonth], Decimal] = defaultdict(lambda: ZERO)
    for forecast in forecasts(ledger, since, end, today):
        if forecast.status not in (ForecastStatus.PENDING, ForecastStatus.LATE):
            continue
        rule = rules(ledger).get(forecast.rule_id)
        if rule is None:
            continue
        account = ledger.accounts.get(rule.account_id)
        if account is None:
            continue
        card = card_by_liability.get(account.id)
        if card is not None:
            if forecast.due_on >= today:
                card_extra[(card.id, cycle_for(card, forecast.due_on).month)] += -forecast.amount
            continue
        if not account.is_liquid:
            continue
        late = forecast.due_on < today
        out.append(
            ProjectedEvent(
                max(forecast.due_on, today), account.id, forecast.amount, forecast.description, "recorrência", late
            )
        )
    months = []
    cursor = YearMonth.of(since)
    while cursor <= YearMonth.of(end).add(1):
        months.append(cursor)
        cursor = cursor.add(1)
    for card in ledger.cards.values():
        payer = ledger.accounts.get(card.settlement_account_id) if card.settlement_account_id else None
        for bill in bills(ledger, card.id, months):
            due = bill.cycle.due
            extra = card_extra.get((card.id, bill.cycle.month), ZERO)
            owed = bill.remaining + extra
            if owed <= 0 or not (since <= due <= end):
                continue
            if payer is None or not payer.is_liquid:
                notes.append(f"Fatura de {card.name} sem conta de pagamento: fora da projeção.")
                continue
            out.append(ProjectedEvent(max(due, today), payer.id, -owed, f"Fatura {card.name}", "fatura", due < today))
    for plan, item in upcoming(ledger, since, end):
        account = ledger.accounts.get(plan.payment_account_id)
        if account is None or not account.is_liquid:
            continue
        out.append(
            ProjectedEvent(
                max(item.due, today),
                account.id,
                -item.payment,
                f"Parcela {item.number} — {plan.name}",
                "financiamento",
                item.due < today,
            )
        )
    return sorted(out, key=lambda e: (e.on, e.description)), sorted(set(notes))


def project(
    ledger: Ledger, today: date | None = None, days: int = HORIZON_DAYS, accounts: list[UUID] | None = None
) -> list[AccountProjection]:
    """One projection per liquid account (or the chosen ones), from today's balance."""
    today = today or date.today()
    end = today + timedelta(days=days)
    chosen = (
        accounts
        if accounts is not None
        else [a.id for a in ledger.accounts.values() if a.is_liquid and not a.archived and a.type is AccountType.ASSET]
    )
    found, _notes = events(ledger, today, end)
    out = []
    for account_id in chosen:
        projection = AccountProjection(account_id, today, queries.balance(ledger, account_id, today))
        projection.events = [e for e in found if e.account_id == account_id]
        out.append(projection)
    return out


def negative_ahead(ledger: Ledger, today: date | None = None, days: int = ALERT_DAYS) -> list[AccountProjection]:
    """Accounts that are positive today and whose projected balance goes below zero within `days`."""
    today = today or date.today()
    out = []
    for projection in project(ledger, today, days):
        first = projection.first_negative
        if projection.start_balance >= 0 and first is not None and first <= today + timedelta(days=days):
            out.append(projection)
    return out
