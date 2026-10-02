"""Results and returns from valuations and flows (docs/06 §3-5, §9).

Every result carries its method, period, inputs and quality; when the data do not
support a figure, the answer is "unavailable" with a reason, never zero.
"""

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from opesvault.domain.ledger import Ledger
from opesvault.domain.money import ZERO
from opesvault.investments.model import EventKind, EventQuality, InvestmentEvent, Valuation, ValueNature
from opesvault.investments.service import events_of, position, remaining_cost, valuations_of

CALC_VERSION = "1"


class Quality(StrEnum):
    OBSERVED = "observed"
    ESTIMATE = "estimate"
    INCOMPLETE = "incomplete"
    UNAVAILABLE = "unavailable"


@dataclass(frozen=True)
class Result:
    value: Decimal | None
    unit: str  # "BRL" or "ratio"
    method: str
    start: date | None
    end: date | None
    quality: Quality
    notes: tuple[str, ...] = ()
    version: str = CALC_VERSION

    @property
    def available(self) -> bool:
        return self.value is not None


def unavailable(
    method: str, reason: str, start: date | None = None, end: date | None = None, unit: str = "BRL"
) -> Result:
    return Result(None, unit, method, start, end, Quality.UNAVAILABLE, (reason,))


def selected_series(ledger: Ledger, position_id: UUID, nature: ValueNature | None = None) -> list[Valuation]:
    """Observed points actually used (one per date); natures are never mixed silently."""
    out = [v for v in valuations_of(ledger, position_id) if v.selected]
    if nature is not None:
        out = [v for v in out if v.nature is nature]
    return out


@dataclass(frozen=True)
class Observed:
    valuation: Valuation
    age_days: int


def value_at(ledger: Ledger, position_id: UUID, at: date, nature: ValueNature | None = None) -> Observed | None:
    """Last known value up to `at` (never a future price), with its age (docs/07 §5)."""
    points = [v for v in selected_series(ledger, position_id, nature) if v.on <= at]
    if not points:
        return None
    last = points[-1]
    return Observed(last, (at - last.on).days)


@dataclass(frozen=True)
class Flow:
    on: date
    amount: Decimal  # + money into the perimeter, − money out (gross)
    kind: EventKind
    event: InvestmentEvent


def external_flows(ledger: Ledger, position_id: UUID, after: date, until: date) -> list[Flow]:
    """Flows strictly after `after` and up to `until` (closing-of-day convention, docs/06 §4)."""
    out = []
    for event in events_of(ledger, position_id):
        if not (after < event.on <= until):
            continue
        if event.kind in (EventKind.CONTRIBUTION, EventKind.BUY) and event.gross is not None:
            out.append(Flow(event.on, event.gross, event.kind, event))
        elif event.kind in (EventKind.WITHDRAWAL, EventKind.SELL, EventKind.DISTRIBUTION):
            amount = event.gross if event.gross is not None else event.net
            if amount is not None:
                out.append(Flow(event.on, -amount, event.kind, event))
    return out


def _endpoint(ledger: Ledger, position_id: UUID, on: date) -> Valuation | None:
    return next((v for v in selected_series(ledger, position_id) if v.on == on), None)


def period_result(ledger: Ledger, position_id: UUID, start: date, end: date) -> Result:
    """Result = final − initial − contributions + gross withdrawals + external gross distributions."""
    method = "resultado antes de imposto e taxas de saída informados"
    first, last = _endpoint(ledger, position_id, start), _endpoint(ledger, position_id, end)
    if first is None or last is None:
        return unavailable(method, "Faltam avaliações exatamente no início e no fim do período.", start, end)
    if first.nature is not last.nature:
        return unavailable(method, "Valores inicial e final de naturezas diferentes (bruto × líquido).", start, end)
    flows = external_flows(ledger, position_id, start, end)
    notes: list[str] = [f"valores {first.nature.value}"]
    quality = Quality.OBSERVED
    if any(f.event.quality is EventQuality.INCOMPLETE for f in flows):
        quality = Quality.INCOMPLETE
        notes.append("há resgate só com líquido conhecido: resultado incompleto")
    value = last.value - first.value - sum((f.amount for f in flows), ZERO)
    return Result(value, "BRL", method, start, end, quality, tuple(notes))


def simple_return(
    ledger: Ledger, position_id: UUID, start: date, end: date, *, include_distributions: bool = True
) -> Result:
    """Only without contributions/withdrawals in the period; balance growth is not a return otherwise."""
    method = "retorno simples do período"
    first, last = _endpoint(ledger, position_id, start), _endpoint(ledger, position_id, end)
    if first is None or last is None:
        return unavailable(method, "Faltam avaliações no início e no fim.", start, end, "ratio")
    if first.nature is not last.nature:
        return unavailable(method, "Naturezas diferentes nos extremos.", start, end, "ratio")
    if first.value <= 0:
        return unavailable(method, "Valor inicial não positivo.", start, end, "ratio")
    flows = external_flows(ledger, position_id, start, end)
    if any(f.kind is not EventKind.DISTRIBUTION for f in flows):
        return unavailable(method, "Há aportes ou retiradas no período: use TWR, XIRR ou Dietz.", start, end, "ratio")
    distributions = -sum((f.amount for f in flows), ZERO)
    notes = ["sem anualização"]
    if distributions and include_distributions:
        notes.append("inclui distribuições externas, sem hipótese de reinvestimento")
    else:
        distributions = ZERO
    return Result(
        (last.value + distributions) / first.value - 1, "ratio", method, start, end, Quality.OBSERVED, tuple(notes)
    )


def unrealized(ledger: Ledger, position_id: UUID, at: date) -> Result:
    method = "resultado não realizado (valor observado − custo remanescente)"
    pos = position(ledger, position_id)
    if not pos.cost_known:
        return unavailable(method, "Custo de aquisição desconhecido.", None, at)
    observed = value_at(ledger, position_id, at)
    if observed is None:
        return unavailable(method, "Sem avaliação até a data.", None, at)
    if observed.valuation.nature is not ValueNature.GROSS:
        return unavailable(method, "Última avaliação não é bruta; sem decomposição não há lucro bruto.", None, at)
    notes = [f"avaliação de {observed.valuation.on:%d/%m/%Y} ({observed.age_days} dias)"]
    quality = Quality.OBSERVED if observed.age_days <= 45 else Quality.ESTIMATE
    if quality is Quality.ESTIMATE:
        notes.append("avaliação antiga")
    return Result(
        observed.valuation.value - remaining_cost(ledger, position_id, at),
        "BRL",
        method,
        None,
        at,
        quality,
        tuple(notes),
    )


def realized(ledger: Ledger, position_id: UUID, until: date | None = None) -> Result:
    method = "resultado realizado (bruto do resgate − custo atribuído)"
    total = ZERO
    notes: list[str] = []
    quality = Quality.OBSERVED
    for event in events_of(ledger, position_id):
        if until is not None and event.on > until:
            continue
        if event.kind not in (EventKind.WITHDRAWAL, EventKind.SELL):
            continue
        gain = event.realized_gain
        if gain is None:
            quality = Quality.INCOMPLETE
            notes.append(f"resgate de {event.on:%d/%m/%Y} sem decomposição")
            continue
        total += gain
    return Result(total, "BRL", method, None, until, quality, tuple(notes))


@dataclass
class CompositionLine:
    position_id: UUID
    value: Decimal | None
    as_of: date | None
    age_days: int | None


@dataclass
class Composition:
    at: date
    lines: list[CompositionLine] = field(default_factory=list)

    @property
    def total(self) -> Decimal:
        return sum((line.value for line in self.lines if line.value is not None), ZERO)

    @property
    def partial(self) -> bool:
        return any(line.value is None for line in self.lines)


def composition(ledger: Ledger, at: date) -> Composition:
    """Portfolio at a date: last known value of each open position; missing ones make the total partial."""
    from opesvault.investments.service import positions

    result = Composition(at)
    for pos in positions(ledger).values():
        if pos.opened_on > at:
            continue
        observed = value_at(ledger, pos.id, at)
        if pos.closed and (observed is None or observed.valuation.value == 0):
            continue
        result.lines.append(
            CompositionLine(
                pos.id,
                observed.valuation.value if observed else None,
                observed.valuation.on if observed else None,
                observed.age_days if observed else None,
            )
        )
    return result
