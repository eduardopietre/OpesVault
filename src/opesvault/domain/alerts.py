"""What needs attention when a vault is opened (docs/09 §1.3).

The app is offline and never notifies in the background, so the moment the vault is
opened is when it must say what is due, late or waiting. Alerts are computed from the
ledger, never stored, and never change anything.
"""

from dataclasses import dataclass
from datetime import date, timedelta
from enum import StrEnum

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import YearMonth
from opesvault.domain.money import format_brl

HORIZON_DAYS = 7  # "vence nos próximos dias"
LOOKBACK_DAYS = 31  # late items older than this are history, not alerts


class Severity(StrEnum):
    URGENT = "urgent"  # late or over: something already went wrong
    SOON = "soon"  # due within the horizon
    INFO = "info"  # waiting for the user (review, near the budget)


class Target(StrEnum):
    """Where the user acts on the alert."""

    ACCOUNTS = "accounts"
    RECURRENCES = "recurrences"
    IMPORT = "import"
    BUDGET = "budget"


@dataclass(frozen=True)
class Alert:
    severity: Severity
    title: str
    detail: str
    target: Target
    due_on: date | None = None


def _when(due: date, today: date) -> str:
    days = (due - today).days
    if days == 0:
        return "vence hoje"
    if days == 1:
        return "vence amanhã"
    if days > 1:
        return f"vence em {days} dias ({due:%d/%m})"
    return f"venceu em {due:%d/%m}"


def card_alerts(ledger: Ledger, today: date, horizon: int = HORIZON_DAYS) -> list[Alert]:
    from opesvault.domain.cards import BillStatus, bills

    out: list[Alert] = []
    this_month = YearMonth.of(today)
    months = [this_month.add(-1), this_month, this_month.add(1)]
    for card in ledger.cards.values():
        for bill in bills(ledger, card.id, months):
            due = bill.cycle.due
            if bill.total <= 0 or bill.remaining <= 0:
                continue
            if not (today - timedelta(days=LOOKBACK_DAYS) <= due <= today + timedelta(days=horizon)):
                continue
            state = bill.status(today)
            if state in (BillStatus.OVERDUE, BillStatus.PARTIAL) and due < today:
                severity, verb = Severity.URGENT, "Fatura vencida"
            elif state is BillStatus.PAID:
                continue
            else:
                severity, verb = Severity.SOON, "Fatura a vencer"
            out.append(
                Alert(
                    severity,
                    f"{verb}: {card.name}",
                    f"{_when(due, today)} · falta pagar {format_brl(bill.remaining)}",
                    Target.ACCOUNTS,
                    due,
                )
            )
    return out


def recurrence_alerts(ledger: Ledger, today: date, horizon: int = HORIZON_DAYS) -> list[Alert]:
    from opesvault.domain.recurrence import ForecastStatus, forecasts

    out: list[Alert] = []
    start, end = today - timedelta(days=LOOKBACK_DAYS), today + timedelta(days=horizon)
    for forecast in forecasts(ledger, start, end, today):
        value = format_brl(abs(forecast.amount))
        if forecast.status is ForecastStatus.LATE:
            out.append(
                Alert(
                    Severity.URGENT,
                    f"Previsão não realizada: {forecast.description}",
                    f"esperada em {forecast.due_on:%d/%m} · {value} · vincule ao lançamento ou pule",
                    Target.RECURRENCES,
                    forecast.due_on,
                )
            )
        elif forecast.status is ForecastStatus.PENDING and forecast.due_on >= today:
            out.append(
                Alert(
                    Severity.SOON,
                    f"Conta a vencer: {forecast.description}"
                    if forecast.amount < 0
                    else f"Previsto: {forecast.description}",
                    f"{_when(forecast.due_on, today)} · {value}",
                    Target.RECURRENCES,
                    forecast.due_on,
                )
            )
    return out


def import_alerts(ledger: Ledger) -> list[Alert]:
    from opesvault.importing import pipeline
    from opesvault.importing.model import BatchStatus, ItemStatus

    out: list[Alert] = []
    pending = [i for i in pipeline.items(ledger).values() if i.status in (ItemStatus.READY, ItemStatus.NEEDS_REVIEW)]
    if pending:
        documents = len({i.batch_id for i in pending})
        out.append(
            Alert(
                Severity.INFO,
                f"{len(pending)} item(ns) importado(s) aguardando revisão",
                f"em {documents} documento(s); só entram nas contas depois de aprovados",
                Target.IMPORT,
            )
        )
    undecided = [
        b for b in pipeline.batches(ledger).values() if b.status in (BatchStatus.AMBIGUOUS, BatchStatus.UNSUPPORTED)
    ]
    if undecided:
        out.append(
            Alert(
                Severity.INFO,
                f"{len(undecided)} documento(s) sem layout definido",
                "escolha o layout ou registre os lançamentos manualmente",
                Target.IMPORT,
            )
        )
    return out


def budget_alerts(ledger: Ledger, today: date) -> list[Alert]:
    from opesvault.domain.budget import status

    month = YearMonth.of(today)
    current = status(ledger, month)
    out = [
        Alert(
            Severity.URGENT,
            f"Orçamento estourado: {row.name}",
            f"gasto {format_brl(row.actual)} de {format_brl(row.planned)} ({int(row.used * 100)}%)",
            Target.BUDGET,
        )
        for row in current.over
    ]
    out += [
        Alert(
            Severity.INFO,
            f"Orçamento quase no limite: {row.name}",
            f"resta {format_brl(row.remaining)} de {format_brl(row.planned)}",
            Target.BUDGET,
        )
        for row in current.near
    ]
    return out


ORDER = {Severity.URGENT: 0, Severity.SOON: 1, Severity.INFO: 2}


def alerts(ledger: Ledger, today: date | None = None, horizon: int = HORIZON_DAYS) -> list[Alert]:
    """Most urgent first; within a level, the nearest date first."""
    today = today or date.today()
    found = [
        *card_alerts(ledger, today, horizon),
        *recurrence_alerts(ledger, today, horizon),
        *budget_alerts(ledger, today),
        *import_alerts(ledger),
    ]
    return sorted(found, key=lambda a: (ORDER[a.severity], a.due_on or date.max, a.title))
