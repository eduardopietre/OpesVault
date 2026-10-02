"""Return methods conditioned on available data (docs/06 §5): TWR, XIRR and Modified Dietz.

- Valuations on a flow date follow the closing-of-day convention: they already include
  that day's flow (docs/07 §3).
- No interpolation: missing valuations make TWR unavailable, never "approximately exact".
- XIRR without a unique solution is unavailable, never zero or an arbitrary root.
"""

from datetime import date
from itertools import pairwise
from decimal import Decimal, localcontext
from uuid import UUID

from opesvault.domain.ledger import Ledger
from opesvault.domain.money import ZERO
from opesvault.investments.model import EventQuality
from opesvault.investments.performance import Quality, Result, external_flows, selected_series, unavailable

XIRR_TOLERANCE = Decimal("1e-12")
XIRR_MAX_ITERATIONS = 400
# Dense grid so two nearby roots are never hidden inside one bracket.
XIRR_BRACKETS = (
    Decimal("-0.9999"),
    *(Decimal("-0.99") + Decimal("0.005") * i for i in range(0, 599)),
    *(Decimal(x) for x in ("2", "2.5", "3", "4", "5", "7", "10", "20", "50", "100")),
)


def _value_map(ledger: Ledger, position_id: UUID) -> tuple[dict[date, Decimal], set[str]]:
    points = selected_series(ledger, position_id)
    return {v.on: v.value for v in points}, {v.nature.value for v in points}


def _net_flow_by_date(ledger: Ledger, position_id: UUID, start: date, end: date) -> tuple[dict[date, Decimal], bool]:
    flows: dict[date, Decimal] = {}
    incomplete = False
    for flow in external_flows(ledger, position_id, start, end):
        flows[flow.on] = flows.get(flow.on, ZERO) + flow.amount
        incomplete = incomplete or flow.event.quality is EventQuality.INCOMPLETE
    return flows, incomplete


def twr(ledger: Ledger, position_id: UUID, start: date, end: date) -> Result:
    method = "TWR (retorno ponderado pelo tempo, subperíodos delimitados pelos fluxos)"
    values, natures = _value_map(ledger, position_id)
    if len(natures) > 1:
        return unavailable(method, "Série mistura valores brutos e líquidos.", start, end, "ratio")
    flows, incomplete = _net_flow_by_date(ledger, position_id, start, end)
    boundaries = sorted({start, end, *flows})
    missing = [d for d in boundaries if d not in values]
    if missing:
        listed = ", ".join(d.strftime("%d/%m/%Y") for d in missing[:5])
        return unavailable(
            method,
            f"Faltam avaliações nas datas de fluxo ou extremos ({listed}); não há interpolação.",
            start,
            end,
            "ratio",
        )
    growth = Decimal(1)
    for a, b in pairwise(boundaries):
        if values[a] <= 0:
            return unavailable(method, f"Valor não positivo em {a:%d/%m/%Y}.", start, end, "ratio")
        growth *= (values[b] - flows.get(b, ZERO)) / values[a]
    notes = ["sem anualização", "avaliação na data do fluxo considerada após o movimento"]
    quality = Quality.INCOMPLETE if incomplete else Quality.OBSERVED
    return Result(growth - 1, "ratio", method, start, end, quality, tuple(notes))


def modified_dietz(ledger: Ledger, position_id: UUID, start: date, end: date) -> Result:
    method = "Modified Dietz (estimativa)"
    values, natures = _value_map(ledger, position_id)
    if start not in values or end not in values:
        return unavailable(method, "Faltam avaliações no início e no fim.", start, end, "ratio")
    if len(natures) > 1:
        return unavailable(method, "Série mistura valores brutos e líquidos.", start, end, "ratio")
    days = (end - start).days
    if days <= 0:
        return unavailable(method, "Período de duração zero.", start, end, "ratio")
    flows, incomplete = _net_flow_by_date(ledger, position_id, start, end)
    # Here contributions are positive (C > 0) and withdrawals negative, as in docs/06 §5.
    total_flows = sum(flows.values(), ZERO)
    weighted = sum((amount * Decimal((end - when).days) / Decimal(days) for when, amount in flows.items()), ZERO)
    denominator = values[start] + weighted
    if denominator <= 0:
        return unavailable(method, "Denominador zero ou negativo: estimativa inadequada.", start, end, "ratio")
    value = (values[end] - values[start] - total_flows) / denominator
    notes = ["estimativa", "dias corridos", "fluxo no fechamento do dia", "sem anualização"]
    return Result(
        value, "ratio", method, start, end, Quality.INCOMPLETE if incomplete else Quality.ESTIMATE, tuple(notes)
    )


def _npv(rate: Decimal, flows: list[tuple[Decimal, Decimal]]) -> Decimal:
    base = (1 + rate).ln()
    return sum((amount / (exponent * base).exp() for exponent, amount in flows), ZERO)


def xirr_from_flows(dated: list[tuple[date, Decimal]]) -> tuple[Decimal | None, str]:
    """Solve Σ Fᵢ / (1 + r)^((tᵢ − t₀)/365) = 0 for r > −1. Returns (rate, reason when None)."""
    if not any(a < 0 for _, a in dated) or not any(a > 0 for _, a in dated):
        return None, "É preciso ao menos um fluxo negativo e um positivo."
    with localcontext() as ctx:
        ctx.prec = 40
        t0 = min(d for d, _ in dated)
        flows = [(Decimal((d - t0).days) / Decimal(365), a) for d, a in dated]
        samples = [(r, _npv(r, flows)) for r in XIRR_BRACKETS]
        brackets = [(a, b) for (a, fa), (b, fb) in pairwise(samples) if fa == 0 or (fa < 0) != (fb < 0)]
        if not brackets:
            return None, "Sem solução no domínio r > −100%."
        if len(brackets) > 1:
            return None, "Múltiplas raízes possíveis; taxa não escolhida arbitrariamente."
        low, high = brackets[0]
        f_low = _npv(low, flows)
        for _ in range(XIRR_MAX_ITERATIONS):
            mid = (low + high) / 2
            f_mid = _npv(mid, flows)
            if abs(f_mid) < XIRR_TOLERANCE or (high - low) < XIRR_TOLERANCE:
                return mid, ""
            if (f_mid < 0) == (f_low < 0):
                low, f_low = mid, f_mid
            else:
                high = mid
        return None, "Sem convergência numérica."


def xirr(ledger: Ledger, position_id: UUID, start: date, end: date) -> Result:
    method = "XIRR (taxa anualizada, dias corridos/365)"
    values, natures = _value_map(ledger, position_id)
    if start not in values or end not in values:
        return unavailable(method, "Faltam avaliações no início e no fim.", start, end, "ratio")
    if len(natures) > 1:
        return unavailable(method, "Série mistura valores brutos e líquidos.", start, end, "ratio")
    flows, incomplete = _net_flow_by_date(ledger, position_id, start, end)
    # Investor's view: initial value and contributions are outflows (negative).
    dated = [(start, -values[start])]
    dated += [(when, -amount) for when, amount in flows.items()]
    dated.append((end, values[end]))
    rate, reason = xirr_from_flows(dated)
    if rate is None:
        return unavailable(method, reason, start, end, "ratio")
    notes = ["taxa anualizada", "tolerância 1e-12"]
    if (end - start).days < 365:
        notes.append("período menor que um ano: taxa anualizada a partir de período curto")
    return Result(
        rate, "ratio", method, start, end, Quality.INCOMPLETE if incomplete else Quality.OBSERVED, tuple(notes)
    )


def all_methods(ledger: Ledger, position_id: UUID, start: date, end: date) -> list[Result]:
    from opesvault.investments.performance import simple_return

    return [
        simple_return(ledger, position_id, start, end),
        twr(ledger, position_id, start, end),
        xirr(ledger, position_id, start, end),
        modified_dietz(ledger, position_id, start, end),
    ]
