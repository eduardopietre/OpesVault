"""Due-date calendar: card bills, recurrences, loan installments and investment maturities by day.

Read-only: each event says what it is, how much, and whether it is paid, pending or late,
with a reference the screen uses to open the place where it is resolved.
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from enum import StrEnum

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import YearMonth


class EventState(StrEnum):
    DONE = "done"  # paid, realized or skipped
    PENDING = "pending"
    LATE = "late"


STATE_LABELS = {EventState.DONE: "Pago", EventState.PENDING: "A vencer", EventState.LATE: "Atrasado"}


@dataclass(frozen=True)
class AgendaEvent:
    on: date
    title: str
    amount: Decimal  # positive: money in; negative: money out
    kind: str  # "fatura", "recorrência", "financiamento", "vencimento"
    state: EventState
    target: str  # page key that resolves it ("accounts", "recurrences")
    ref: object = None


def events(ledger: Ledger, start: date, end: date, today: date | None = None) -> list[AgendaEvent]:
    from opesvault.domain.cards import BillStatus, bills
    from opesvault.domain.loans import paid_numbers, plan_schedule, plans
    from opesvault.domain.recurrence import ForecastStatus, forecasts

    today = today or date.today()
    out: list[AgendaEvent] = []
    for forecast in forecasts(ledger, start, end, today):
        state = {
            ForecastStatus.REALIZED: EventState.DONE,
            ForecastStatus.SKIPPED: EventState.DONE,
            ForecastStatus.LATE: EventState.LATE,
        }.get(forecast.status, EventState.LATE if forecast.due_on < today else EventState.PENDING)
        out.append(
            AgendaEvent(
                forecast.due_on,
                forecast.description,
                forecast.amount,
                "recorrência",
                state,
                "recurrences",
                (forecast.rule_id, forecast.due_on),
            )
        )
    months = []
    cursor = YearMonth.of(start)
    while cursor <= YearMonth.of(end):
        months.append(cursor)
        cursor = cursor.add(1)
    for card in ledger.cards.values():
        for bill in bills(ledger, card.id, months):
            if bill.total <= 0 or not (start <= bill.cycle.due <= end):
                continue
            status = bill.status(today)
            if status is BillStatus.PAID:
                state = EventState.DONE
            elif bill.cycle.due < today:
                state = EventState.LATE
            else:
                state = EventState.PENDING
            out.append(
                AgendaEvent(
                    bill.cycle.due,
                    f"Fatura {card.name}",
                    -bill.total,
                    "fatura",
                    state,
                    "accounts",
                    (card.id, bill.cycle.month),
                )
            )
    for plan in plans(ledger).values():
        paid = paid_numbers(ledger, plan.id)
        for item in plan_schedule(ledger, plan.id):
            if not (start <= item.due <= end):
                continue
            if item.number in paid:
                state = EventState.DONE
            else:
                state = EventState.LATE if item.due < today else EventState.PENDING
            out.append(
                AgendaEvent(
                    item.due,
                    f"Parcela {item.number} — {plan.name}",
                    -item.payment,
                    "financiamento",
                    state,
                    "accounts",
                    ("loan", plan.id, item.number),
                )
            )
    out += _maturities(ledger, start, end, today)
    return sorted(out, key=lambda e: (e.on, e.title))


def _maturities(ledger: Ledger, start: date, end: date, today: date) -> list[AgendaEvent]:
    """Investments that mature in the period (from their characteristics): the money comes back."""
    from opesvault.investments.performance import value_at
    from opesvault.investments.profile import profiles
    from opesvault.investments.service import assets, positions, remaining_cost

    out = []
    for profile in profiles(ledger).values():
        if profile.maturity is None or not (start <= profile.maturity <= end):
            continue
        pos = positions(ledger).get(profile.position_id)
        if pos is None:
            continue
        observed = value_at(ledger, pos.id, profile.maturity)
        value = observed.valuation.value if observed else remaining_cost(ledger, pos.id, profile.maturity)
        late = profile.maturity < today
        state = EventState.DONE if pos.closed else EventState.LATE if late else EventState.PENDING
        out.append(
            AgendaEvent(
                profile.maturity,
                f"Vencimento — {assets(ledger)[pos.asset_id].name}",
                value,
                "vencimento",
                state,
                "investments",
                pos.id,
            )
        )
    return out


def by_day(found: list[AgendaEvent]) -> dict[date, list[AgendaEvent]]:
    out: dict[date, list[AgendaEvent]] = defaultdict(list)
    for event in found:
        out[event.on].append(event)
    return dict(out)


def month_events(ledger: Ledger, month: YearMonth, today: date | None = None) -> list[AgendaEvent]:
    return events(ledger, month.first_day(), month.last_day(), today)
