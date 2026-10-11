"""Monthly closing (RF-13, docs/04 §7): a state over the continuous ledger, not a separate file."""

from datetime import UTC, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from opesvault.domain import queries
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import Amount, Operation, YearMonth, _Entity


class PeriodSummary(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    cash_in: Amount
    cash_out: Amount
    income: Amount
    expense: Amount
    net_worth: Amount


class PeriodClose(_Entity):
    month: YearMonth
    closed: bool
    closed_at: datetime
    summary: PeriodSummary
    pending_note: str | None = Field(default=None, max_length=1000)
    reopen_reasons: tuple[str, ...] = ()


Ledger.register_kind("period_close", PeriodClose)


def closes(ledger: Ledger) -> dict[UUID, PeriodClose]:
    return ledger.entities("period_close")


def period(ledger: Ledger, month: YearMonth) -> PeriodClose | None:
    return next((p for p in closes(ledger).values() if p.month == month), None)


def is_closed(ledger: Ledger, month: YearMonth | None) -> bool:
    if month is None:
        return False
    found = period(ledger, month)
    return found is not None and found.closed


def months_of(op: Operation) -> set[YearMonth]:
    months = set()
    if op.competence is not None:
        months.add(op.competence)
    if op.cash_date is not None:
        months.add(YearMonth.of(op.cash_date))
    return months


def pending_items(ledger: Ledger, month: YearMonth) -> list[str]:
    """Relevant pending matters shown before closing (docs/01 §3 revisão mensal)."""
    from opesvault.domain.recurrence import ForecastStatus, forecasts
    from opesvault.importing.model import ItemStatus
    from opesvault.importing.store import items

    notes = []
    open_items = [
        i
        for i in items(ledger).values()
        if i.status in (ItemStatus.READY, ItemStatus.NEEDS_REVIEW, ItemStatus.DUPLICATE)
        and i.occurred_on is not None
        and YearMonth.of(i.occurred_on) == month
    ]
    if open_items:
        notes.append(f"{len(open_items)} item(ns) importado(s) aguardando revisão")
    late = [
        f
        for f in forecasts(ledger, month.first_day(), month.last_day())
        if f.status in (ForecastStatus.PENDING, ForecastStatus.LATE)
    ]
    if late:
        notes.append(f"{len(late)} previsão(ões) recorrente(s) sem realização")
    return notes


def summarize(ledger: Ledger, month: YearMonth) -> PeriodSummary:
    flow = queries.cash_flow(ledger, month, month)[month]
    statement = queries.income_statement(ledger, month)
    return PeriodSummary(
        cash_in=flow.inflow,
        cash_out=flow.outflow,
        income=statement.total_income,
        expense=statement.total_expense,
        net_worth=queries.net_worth(ledger, month.last_day()).net,
    )


def close_month(ledger: Ledger, month: YearMonth, pending_note: str | None = None) -> PeriodClose:
    if is_closed(ledger, month):
        raise DomainError("Mês já fechado.")
    pending = pending_items(ledger, month)
    if pending and not (pending_note and pending_note.strip()):
        raise DomainError("Há pendências: " + "; ".join(pending) + ". Resolva ou registre uma justificativa.")
    current = period(ledger, month)
    entry = PeriodClose(
        month=month,
        closed=True,
        closed_at=datetime.now(UTC),
        summary=summarize(ledger, month),
        pending_note=pending_note.strip() if pending_note else None,
        reopen_reasons=current.reopen_reasons if current else (),
    )
    if current is not None:
        entry = entry.model_copy(update={"id": current.id})
        return ledger.put("period_close", entry, reason="novo fechamento")
    return ledger.put("period_close", entry)


def reopen_month(ledger: Ledger, month: YearMonth, reason: str) -> PeriodClose:
    current = period(ledger, month)
    if current is None or not current.closed:
        raise DomainError("Mês não está fechado.")
    if not reason.strip():
        raise DomainError("A reabertura exige motivo.")
    reopened = current.model_copy(update={"closed": False, "reopen_reasons": (*current.reopen_reasons, reason.strip())})
    return ledger.put("period_close", reopened, reason=reason)


def _guard_new(ledger: Ledger, op: Operation) -> None:
    for month in months_of(op):
        if is_closed(ledger, month):
            raise DomainError(f"O mês {month} está fechado. Reabra-o com um motivo para lançar nele.")


def _figures(op: Operation) -> tuple[object, ...]:
    return (op.kind, op.status, op.currency, op.postings, op.occurred_on, op.booked_on, op.accrual_month, op.settled_on)


def _guard_update(ledger: Ledger, before: Operation, after: Operation) -> None:
    if _figures(before) == _figures(after):
        return  # descriptions, evidence or forecast links do not change any closed figure
    for month in months_of(before) | months_of(after):
        if is_closed(ledger, month):
            raise DomainError(f"O mês {month} está fechado. Reabra-o com um motivo antes de alterar.")


Ledger.add_operation_guard(_guard_new)
Ledger.add_update_guard(_guard_update)


def closed_figures_unchanged(ledger: Ledger, month: YearMonth) -> bool:
    found = period(ledger, month)
    return found is None or summarize(ledger, month) == found.summary
